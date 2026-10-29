#!/usr/bin/env node
// End-to-end check with RUNNER=mock. Starts its own `next start` (build first:
// `npm run e2e:mock` does both) with a throwaway data dir, MOCK_FAIL_SHOT=2
// and a small DAILY_SHOT_CAP, then walks the whole flow:
//   upload -> 4-shot list -> generate -> shot 2 refused, nothing stitched
//   -> Edit & retry shot 2 only -> stitched MP4 -> swap one shot's move
//   -> only that shot re-renders -> reorder re-stitches only
//   -> Direct mode sends the prompt byte-for-byte -> daily cap shows the demo.
// Then a second server with RUNNER=demo (the live-link setup, no server key):
//   sample image replays pre-made clips; uploads / custom prompts need a key;
//   bring-your-own-key renders through the ComfyRunner against a local stub of
//   the Comfy API (no real network), and the key is never persisted or logged.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const PORT = Number(process.env.E2E_PORT ?? 3199);
let BASE = `http://localhost:${PORT}`;
let DATA_DIR = mkdtempSync(path.join(tmpdir(), "shotlist-e2e-"));
const FAIL_SHOT = 2;
const CAP = 10; // renders below: 4 + 1 retry + 1 swap + 1 direct = 7, then 4 more must be refused

const log = (...a) => console.log("•", ...a);
let server;
let stub;
let serverLog = "";
function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    server?.kill();
    stub?.close();
    process.exit(1);
  }
  console.log("✓", msg);
}

async function startServer(env) {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    // Explicit values win over anything in .env.local.
    env: { ...process.env, STORAGE: "local", SHOTLIST_DATA_DIR: DATA_DIR, COMFY_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start — run `npm run build` first");
}

async function call(method, url, body, { allow = [], key } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(key ? { "x-comfy-key": key } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return Object.assign(json, { status: res.status });
}

/** Poll until nothing is rendering or stitching. */
async function settle(id, { key, timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const p = await call("GET", `/api/projects/${id}`, undefined, { key });
    const line = p.shots.map((s) => `${s.render?.state ?? "-"}:${Math.round((s.render?.progress ?? 0) * 100)}%`).join(" ");
    if (line !== last) log(`progress ${line} output=${p.output?.state ?? "-"}`);
    last = line;
    const busy = p.shotsView.some((s) => s.inFlight) || p.output?.state === "stitching";
    const allDone = p.shotsView.every((s) => s.fresh);
    if (!busy && (!allDone || p.outputFresh)) return p;
    if (p.output?.state === "failed") throw new Error("stitch failed: " + p.output.error);
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error("timed out waiting for renders");
}

async function fetchDuration(id, file) {
  const buf = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/files/${file}`)).arrayBuffer());
  const f = path.join(DATA_DIR, "check.mp4");
  writeFileSync(f, buf);
  let err = "";
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", f], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    err = e.stderr.toString();
  }
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return { isMp4: buf.subarray(4, 8).toString() === "ftyp", duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN };
}

async function upload() {
  const img = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=1600x1000:end_pts=1",
    "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1",
  ]);
  const form = new FormData();
  form.append("image", new Blob([img], { type: "image/png" }), "test.png");
  return call("POST", "/api/projects", form);
}

try {
  await startServer({ RUNNER: "mock", MOCK_FAIL_SHOT: String(FAIL_SHOT), DAILY_SHOT_CAP: String(CAP) });
  log(`mock server on ${BASE}, data in ${DATA_DIR}`);

  // 1. Upload ---------------------------------------------------------------
  let p = await upload();
  const id = p.id;
  assert(p.shots.length === 4, "upload pre-fills a 4-shot list");
  assert(
    p.shots.map((s) => s.move).join(",") === "slow_push_in,bullet_orbit,crash_zoom,crane_reveal",
    "starter moves: push-in, orbit, crash zoom, crane reveal",
  );
  assert(p.demo === null, "no demo limit yet");

  // 2. Generate: shot 2 is refused (MOCK_FAIL_SHOT=2) -------------------------
  let g = await call("POST", `/api/projects/${id}/generate`, {});
  assert(g.submitted.length === 4, "generate submits all 4 shots");
  p = await settle(id);
  const bad = p.shots[FAIL_SHOT - 1];
  assert(bad.render.state === "failed" && bad.render.failReason === "Refused by LTX", `shot ${FAIL_SHOT} failed: "${bad.render.failReason}"`);
  assert(p.shots.filter((s) => s.render.state === "done").length === 3, "the other 3 shots rendered");
  assert(!p.output, "nothing is stitched while a shot is failed");

  // 3. Edit & retry: only the failed shot re-renders ------------------------
  const counts = Object.fromEntries(p.shots.map((s) => [s.id, s.renderCount]));
  p = await call("PATCH", `/api/projects/${id}`, {
    shots: p.shots.map((s) => (s.id === bad.id ? { ...s, note: "A quiet harbour at dawn" } : s)),
  });
  g = await call("POST", `/api/projects/${id}/generate`, { only: [bad.id] });
  assert(g.submitted.length === 1 && g.submitted[0] === bad.id, "Edit & retry submits only the failed shot");
  p = await settle(id);
  assert(p.outputFresh, "after the retry the video stitches");
  assert(p.shots.every((s) => s.renderCount === counts[s.id] + (s.id === bad.id ? 1 : 0)), "retry re-rendered nothing else");
  let file = await fetchDuration(id, p.output.file);
  assert(file.isMp4, "stitched file is an MP4");
  assert(Math.abs(file.duration - 14.5) < 0.15, `stitched duration ${file.duration.toFixed(2)}s ≈ 14.5s (4×4s, three 0.5s crossfades)`);
  const firstFile = p.output.file;
  const before = Object.fromEntries(p.shots.map((s) => [s.id, { count: s.renderCount, job: s.render.jobId }]));

  // 4. Swap one shot's move -> only that shot re-renders --------------------
  const target = p.shots[2];
  p = await call("PATCH", `/api/projects/${id}`, { shots: p.shots.map((s) => (s.id === target.id ? { ...s, move: "whip_pan" } : s)) });
  assert(!p.outputFresh, "output is stale after changing a move");
  g = await call("POST", `/api/projects/${id}/generate`, {});
  assert(g.submitted.length === 1 && g.submitted[0] === target.id, "regenerate submits only the changed shot");
  p = await settle(id);
  for (const s of p.shots) {
    const same = s.renderCount === before[s.id].count && s.render.jobId === before[s.id].job;
    if (s.id === target.id) assert(!same && s.renderCount === before[s.id].count + 1, `shot ${s.id} re-rendered`);
    else assert(same, `shot ${s.id} reused`);
  }
  assert(p.outputFresh && p.output.file !== firstFile, "a new stitched file was produced");
  file = await fetchDuration(id, p.output.file);
  assert(Math.abs(file.duration - 14.5) < 0.15, `re-stitched duration ${file.duration.toFixed(2)}s`);

  // 5. Reorder -> re-stitch only ---------------------------------------------
  const order = p.shots.map((s) => s.renderCount).join(",");
  await call("PATCH", `/api/projects/${id}`, { shots: [...p.shots].reverse() });
  g = await call("POST", `/api/projects/${id}/generate`, {});
  assert(g.submitted.length === 0, "reordering submits no renders");
  p = await settle(id);
  assert(p.outputFresh && [...p.shots].reverse().map((s) => s.renderCount).join(",") === order, "reorder re-stitched without re-rendering");

  // 6. Direct mode: byte-for-byte prompt ------------------------------------
  p = await call("PATCH", `/api/projects/${id}`, { mode: "direct" });
  assert(p.mode === "direct" && p.shots.every((s) => s.prompt.length > 0 && s.promptSeeded), "Director -> Direct seeds prompts from the planner");
  const exact = "  close-up, rain on glass — “no” style words; 100% as typed\n\ttab ✓  ";
  p = await call("PATCH", `/api/projects/${id}`, { shots: p.shots.map((s, i) => (i === 0 ? { ...s, prompt: exact } : s)) });
  g = await call("POST", `/api/projects/${id}/generate`, {});
  assert(g.submitted.length === 1 && g.submitted[0] === p.shots[0].id, "only the shot with an edited prompt re-renders");
  p = await settle(id);
  const s0 = p.shots[0];
  assert(s0.render.sentPrompt === exact, "Sent-to-LTX prompt equals the typed prompt byte-for-byte");
  const job = JSON.parse(readFileSync(path.join(DATA_DIR, "mock-jobs", `${s0.render.jobId}.json`), "utf8"));
  assert(job.input.prompt === exact, "job JSON logs the exact prompt");
  assert(job.input.camera.kind === "preset" && job.input.camera.move === s0.move, "move only sets camera params");

  // 7. Daily cap -> demo state ---------------------------------------------
  const usage = JSON.parse(readFileSync(path.join(DATA_DIR, "usage", `${new Date().toISOString().slice(0, 10)}.json`), "utf8"));
  assert(usage.shots === 7, `usage counted in storage: ${usage.shots} renders today`);
  const p2 = await upload();
  g = await call("POST", `/api/projects/${p2.id}/generate`, {}, { allow: [429] });
  assert(g.status === 429 && g.demo === "cap", `over DAILY_SHOT_CAP=${CAP}: generate refused with demo state`);
  const sample = await fetch(`${BASE}/sample-trailer.mp4`);
  assert(sample.ok && sample.headers.get("content-type")?.includes("video/mp4"), "sample trailer is served");
  g = await call("POST", `/api/projects/${p2.id}/generate`, { only: [p2.shots[0].id, p2.shots[1].id, p2.shots[2].id] });
  assert(g.submitted.length === 3, "renders that fit under the cap still go through");
  assert(g.project.demo === "cap", "cap reached: project view reports the demo state");

  await demoSuite();
  console.log(`\nAll good.`);
} finally {
  server?.kill();
  stub?.close();
}

// ---------------------------------------------------------------- demo mode + BYOK

/** Minimal stand-in for the Comfy Cloud API, so BYOK runs without the network. */
function startComfyStub(port, key, clipPath) {
  const jobs = new Map();
  const seen = { prompts: [], keysOnSignedUrl: 0, unauthorized: 0 };
  stub = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/signed/")) {
      if (req.headers["x-api-key"]) seen.keysOnSignedUrl++;
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(readFileSync(clipPath));
    }
    if (req.headers["x-api-key"] !== key) {
      seen.unauthorized++;
      return json(401, { error: "invalid key" });
    }
    if (url.pathname === "/api/upload/image") return json(200, { name: "upload.png", subfolder: "", type: "input" });
    if (url.pathname === "/api/prompt") {
      const graph = JSON.parse(body.toString()).prompt;
      const id = `p${jobs.size + 1}`;
      jobs.set(id, Date.now());
      seen.prompts.push(graph["3"].inputs.text);
      return json(200, { prompt_id: id });
    }
    let m = url.pathname.match(/^\/api\/job\/(\w+)\/status$/);
    if (m) return json(200, { status: Date.now() - jobs.get(m[1]) > 1500 ? "completed" : "in_progress" }, { "X-Comfy-Credits-Used": "7" });
    m = url.pathname.match(/^\/api\/jobs\/(\w+)$/);
    if (m) return json(200, { outputs: { 11: { videos: [{ filename: `${m[1]}.mp4`, subfolder: "", type: "output" }] } } });
    if (url.pathname === "/api/view") {
      res.writeHead(302, { location: `/signed/${url.searchParams.get("filename")}` });
      return res.end();
    }
    json(404, { error: "not found" });
  }).listen(port);
  return seen;
}

function filesContaining(dir, needle) {
  const hits = [];
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) hits.push(...filesContaining(f, needle));
    else if (readFileSync(f).includes(needle)) hits.push(f);
  }
  return hits;
}

async function demoSuite() {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  DATA_DIR = mkdtempSync(path.join(tmpdir(), "shotlist-e2e-demo-"));
  const STUB_PORT = PORT + 100;
  const KEY = "sk-test-shotlist-byok-0123456789";
  const seen = startComfyStub(STUB_PORT, KEY, path.join(process.cwd(), "public/demo/dusk-ridge/slow_push_in.mp4"));
  await startServer({ RUNNER: "demo", COMFY_API_BASE: `http://localhost:${STUB_PORT}`, DAILY_SHOT_CAP: "0" });
  log(`demo server on ${BASE} (RUNNER=demo, no server key, cap 0), data in ${DATA_DIR}`);

  // Sample image -> pre-made clips, stitched as usual
  const form = new FormData();
  form.append("sample", "dusk-ridge");
  let p = await call("POST", "/api/projects", form);
  assert(p.runner === "demo" && p.sample === "dusk-ridge" && p.shots.length === 4, "demo: project starts from the bundled sample");
  let g = await call("POST", `/api/projects/${p.id}/generate`, {});
  assert(g.submitted.length === 4, "demo: generate replays all 4 shots (cap 0 does not apply to demo)");
  p = await settle(p.id);
  assert(p.outputFresh && p.shots.every((s) => s.render.runner === "demo" && s.render.credits === 0), "demo: stitched from pre-made clips, 0 credits");
  const file = await fetchDuration(p.id, p.output.file);
  assert(Math.abs(file.duration - 14.5) < 0.15, `demo: stitched duration ${file.duration.toFixed(2)}s`);

  // A custom prompt can't be replayed
  p = await call("PATCH", `/api/projects/${p.id}`, { mode: "direct" });
  p = await call("PATCH", `/api/projects/${p.id}`, { shots: p.shots.map((s, i) => (i === 0 ? { ...s, prompt: "my own words" } : s)) });
  g = await call("POST", `/api/projects/${p.id}/generate`, {}, { allow: [400] });
  assert(g.status === 400 && g.error === "Paste a Comfy key to render your own.", "demo: a custom prompt asks for a key");

  // Uploads need a key
  const up = await upload();
  g = await call("POST", `/api/projects/${up.id}/generate`, {}, { allow: [400] });
  assert(g.status === 400 && g.error === "Paste a Comfy key to render your own.", "demo: an uploaded image asks for a key");

  // Bring your own key -> ComfyRunner (against the stub)
  g = await call("POST", `/api/projects/${up.id}/generate`, {}, { key: KEY });
  assert(g.submitted.length === 4, "BYOK: generate with a key submits all 4 shots");
  let byok = await call("GET", `/api/projects/${up.id}`);
  assert(byok.shotsView.every((s) => s.inFlight), "BYOK: without the key, a poll leaves the jobs alone");
  byok = await settle(up.id, { key: KEY });
  assert(byok.outputFresh && byok.shots.every((s) => s.render.runner === "comfy"), "BYOK: rendered by the ComfyRunner and stitched");
  assert(byok.creditsUsed === 28, `BYOK: credits from X-Comfy-Credits-Used (${byok.creditsUsed} = 4 × 7)`);
  assert(seen.prompts.length === 4 && seen.prompts.every((t, i) => t === byok.shots[i].render.sentPrompt), "BYOK: prompts reach Comfy byte-for-byte");
  assert(seen.keysOnSignedUrl === 0, "BYOK: the key is not sent to the signed download URL");
  assert(filesContaining(DATA_DIR, KEY).length === 0, "BYOK: the key is not in any stored file");
  assert(!serverLog.includes(KEY), "BYOK: the key is not in the server log");

  // A rejected key fails the shot with a clear reason, and the key is redacted
  const bad = await upload();
  await call("POST", `/api/projects/${bad.id}/generate`, { only: [bad.shots[0].id] }, { key: "sk-wrong-key-987654321" });
  const failed = await settle(bad.id, { key: "sk-wrong-key-987654321" });
  const r = failed.shots[0].render;
  assert(r.state === "failed" && r.failReason === "Comfy API key rejected", `BYOK: a bad key fails the shot ("${r.failReason}")`);
  assert(filesContaining(DATA_DIR, "sk-wrong-key-987654321").length === 0, "BYOK: a bad key is not stored either");
}
