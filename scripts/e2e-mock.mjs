#!/usr/bin/env node
// End-to-end check against a running server with RUNNER=mock:
//   upload -> 4-shot list -> generate -> stitched MP4 -> swap one shot's move
//   -> only that shot re-renders -> re-stitch. Also checks Direct mode sends
//   the prompt byte-for-byte.
//
// Usage: npm run dev   (or npm start)   then   npm run e2e:mock [baseUrl]
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000";
const DATA_DIR = process.env.SHOTLIST_DATA_DIR ?? path.join(process.cwd(), ".data");

const log = (...a) => console.log("•", ...a);
function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitForOutput(id, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const p = await call("GET", `/api/projects/${id}`);
    const line = p.shots.map((s) => `${s.render?.state ?? "-"}:${Math.round((s.render?.progress ?? 0) * 100)}%`).join(" ");
    if (line !== last) log(`progress ${line} output=${p.output?.state ?? "-"}`);
    last = line;
    if (p.outputFresh) return p;
    if (p.shots.some((s) => s.render?.state === "failed")) throw new Error("a shot failed: " + JSON.stringify(p.shots));
    if (p.output?.state === "failed") throw new Error("stitch failed: " + p.output.error);
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("timed out waiting for output");
}

function durationOf(buf) {
  const dir = mkdtempSync(path.join(tmpdir(), "shotlist-e2e-"));
  const f = path.join(dir, "out.mp4");
  execFileSync("sh", ["-c", `cat > "${f}"`], { input: buf });
  let err = "";
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", f], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    err = e.stderr.toString();
  }
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

// 1. Upload ---------------------------------------------------------------
const img = execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=1600x1000:end_pts=1",
  "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1",
]);
const form = new FormData();
form.append("image", new Blob([img], { type: "image/png" }), "test.png");
let p = await call("POST", "/api/projects", form);
const id = p.id;
log(`project ${id}`);
assert(p.shots.length === 4, "upload pre-fills a 4-shot list");
assert(
  p.shots.map((s) => s.move).join(",") === "slow_push_in,bullet_orbit,crash_zoom,crane_reveal",
  "starter moves: push-in, orbit, crash zoom, crane reveal",
);

// 2. Generate -------------------------------------------------------------
let t = Date.now();
let g = await call("POST", `/api/projects/${id}/generate`, {});
assert(g.submitted.length === 4, "generate submits all 4 shots");
p = await waitForOutput(id);
log(`first render took ${((Date.now() - t) / 1000).toFixed(1)}s`);
const firstFile = p.output.file;
let mp4 = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/files/${firstFile}`)).arrayBuffer());
assert(mp4.subarray(4, 8).toString() === "ftyp", "stitched file is an MP4");
let dur = durationOf(mp4);
assert(Math.abs(dur - (4 * 4 - 3 * 0.5)) < 0.15, `stitched duration ${dur.toFixed(2)}s ≈ 14.5s (4×4s, three 0.5s crossfades)`);

const before = Object.fromEntries(p.shots.map((s) => [s.id, { count: s.renderCount, job: s.render.jobId }]));

// 3. Swap one shot's move -> only that shot re-renders --------------------
const target = p.shots[2];
const edited = p.shots.map((s) => (s.id === target.id ? { ...s, move: "whip_pan" } : s));
p = await call("PATCH", `/api/projects/${id}`, { shots: edited });
assert(!p.outputFresh, "output is stale after changing a move");
g = await call("POST", `/api/projects/${id}/generate`, {});
assert(g.submitted.length === 1 && g.submitted[0] === target.id, "regenerate submits only the changed shot");
p = await waitForOutput(id);
for (const s of p.shots) {
  if (s.id === target.id) {
    assert(s.renderCount === before[s.id].count + 1 && s.render.jobId !== before[s.id].job, `shot ${s.id} re-rendered`);
  } else {
    assert(s.renderCount === before[s.id].count && s.render.jobId === before[s.id].job, `shot ${s.id} reused (not re-rendered)`);
  }
}
assert(p.output.file !== firstFile, "a new stitched file was produced");
mp4 = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/files/${p.output.file}?download=1`)).arrayBuffer());
dur = durationOf(mp4);
assert(Math.abs(dur - 14.5) < 0.15, `re-stitched duration ${dur.toFixed(2)}s`);

// 4. Reorder -> re-stitch only, no re-render ------------------------------
const counts = p.shots.map((s) => s.renderCount).join(",");
p = await call("PATCH", `/api/projects/${id}`, { shots: [...p.shots].reverse() });
g = await call("POST", `/api/projects/${id}/generate`, {});
assert(g.submitted.length === 0, "reordering submits no renders");
p = await waitForOutput(id);
assert([...p.shots].reverse().map((s) => s.renderCount).join(",") === counts, "reorder re-stitched without re-rendering");

// 5. Direct mode: byte-for-byte prompt ------------------------------------
p = await call("PATCH", `/api/projects/${id}`, { mode: "direct" });
assert(p.mode === "direct", "switched to Direct mode");
assert(
  p.shots.every((s) => s.prompt.length > 0 && s.promptSeeded),
  "Director -> Direct seeds each prompt with the planner text",
);
const exact = "  close-up, rain on glass — “no” style words; 100% as typed\n\ttab ✓  ";
const directShots = p.shots.map((s, i) => (i === 0 ? { ...s, prompt: exact } : s));
p = await call("PATCH", `/api/projects/${id}`, { shots: directShots });
g = await call("POST", `/api/projects/${id}/generate`, {});
assert(g.submitted.length === 1 && g.submitted[0] === p.shots[0].id, "only the shot with an edited prompt re-renders");
p = await waitForOutput(id);
const s0 = p.shots[0];
assert(s0.render.sentPrompt === exact, "Sent-to-LTX prompt equals the typed prompt byte-for-byte");
const job = JSON.parse(readFileSync(path.join(DATA_DIR, "mock-jobs", `${s0.render.jobId}.json`), "utf8"));
assert(job.input.prompt === exact, "job JSON logs the exact prompt");
assert(job.input.camera.kind === "preset" && job.input.camera.move === s0.move, "move only sets camera params");

console.log(`\nAll good. Open ${BASE}/p/${id}`);
