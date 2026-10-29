#!/usr/bin/env node
// End-to-end check with RUNNER=mock. Starts its own `next start` (build first:
// `npm run e2e:mock` does both) with a throwaway data dir, MOCK_FAIL_SHOT=2
// and a small DAILY_SHOT_CAP, then walks the whole flow:
//   upload -> 4-shot list -> generate -> shot 2 refused, nothing stitched
//   -> Edit & retry shot 2 only -> stitched MP4 -> swap one shot's move
//   -> only that shot re-renders -> reorder re-stitches only
//   -> Direct mode sends the prompt byte-for-byte -> daily cap shows the demo.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const PORT = Number(process.env.E2E_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "shotlist-e2e-"));
const FAIL_SHOT = 2;
const CAP = 10; // renders below: 4 + 1 retry + 1 swap + 1 direct = 7, then 4 more must be refused

const log = (...a) => console.log("•", ...a);
let server;
function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    server?.kill();
    process.exit(1);
  }
  console.log("✓", msg);
}

async function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: {
      ...process.env,
      RUNNER: "mock",
      STORAGE: "local",
      SHOTLIST_DATA_DIR: DATA_DIR,
      MOCK_FAIL_SHOT: String(FAIL_SHOT),
      DAILY_SHOT_CAP: String(CAP),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  server.stdout.resume();
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start — run `npm run build` first");
}

async function call(method, url, body, { allow = [] } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: body && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return Object.assign(json, { status: res.status });
}

/** Poll until nothing is rendering or stitching. */
async function settle(id, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const p = await call("GET", `/api/projects/${id}`);
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
  await startServer();
  log(`server on ${BASE}, data in ${DATA_DIR}`);

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

  console.log(`\nAll good.`);
} finally {
  server?.kill();
}
