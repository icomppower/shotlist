#!/usr/bin/env node
// Render the pre-made demo clips with real LTX on Comfy, on your own machine.
//
//   1. Put COMFY_API_KEY=<key> in .env.local (never commit it).
//   2. npm run demo:clips -- --only=slow_push_in   # one shot first: check what it costs
//   3. npm run demo:clips                          # every move for every sample, then the trailer
//
// For each sample image in src/lib/samples.ts this starts the app with
// RUNNER=comfy, renders one 6 s Director-mode shot per move (prompt =
// planPrompt(move, ""), exactly what demo mode replays), and saves them to
// public/demo/<sample>/<move>.mp4, printing the credits each one used. Once every move
// is a real render, it rebuilds public/sample-trailer.mp4 from the starter
// 4-shot list using those clips (RUNNER=demo, so that step costs nothing).
//
// Flags: --only=<move>[,<move>]  render just these moves
//        --sample=<id>           just this sample
//        --trailer-only          skip rendering; rebuild the trailer from the clips on disk
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MOVES = ["crash_zoom", "dolly_zoom", "bullet_orbit", "fpv_dive", "crane_reveal", "whip_pan", "slow_push_in"];
const SAMPLES = ["dusk-ridge"]; // keep in sync with src/lib/samples.ts
const CLIP_SECONDS = 6; // DEMO_CLIP_SECONDS
const PORT = Number(process.env.DEMO_CLIPS_PORT ?? 3299);
const BASE = `http://localhost:${PORT}`;
let server;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const only = typeof args.only === "string" ? args.only.split(",") : null;
const samples = typeof args.sample === "string" ? [args.sample] : SAMPLES;
for (const m of only ?? []) if (!MOVES.includes(m)) fail(`unknown move "${m}" (one of ${MOVES.join(", ")})`);
for (const s of samples) if (!SAMPLES.includes(s)) fail(`unknown sample "${s}"`);

function fail(msg) {
  console.error(`✗ ${msg}`);
  server?.kill();
  process.exit(1);
}

/** True if a key is configured, without ever reading it into output. */
function hasKey() {
  if (process.env.COMFY_API_KEY) return true;
  if (!existsSync(".env.local")) return false;
  return /^\s*COMFY_API_KEY\s*=\s*\S+/m.test(readFileSync(".env.local", "utf8"));
}

async function startServer(env) {
  server?.kill();
  const dataDir = mkdtempSync(path.join(tmpdir(), "shotlist-democlips-"));
  // .env.local supplies COMFY_API_KEY; explicit values here win over it.
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, STORAGE: "local", SHOTLIST_DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("server did not start — run `npm run build` first (npm run demo:clips does both)");
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) fail(`${method} ${url}: ${res.status} ${json.error ?? ""}${json.demo ? ` (demo state: ${json.demo})` : ""}`);
  return json;
}

async function newSampleProject(sample) {
  const form = new FormData();
  form.append("sample", sample);
  return call("POST", "/api/projects", form);
}

/** Poll until nothing is in flight (real LTX renders can take minutes). */
async function settle(id, timeoutMs = 45 * 60_000) {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    const p = await call("GET", `/api/projects/${id}`);
    const line = p.shots.map((s) => `${s.render?.state ?? "-"}:${Math.round((s.render?.progress ?? 0) * 100)}%`).join(" ");
    if (line !== last) console.log(`  ${new Date().toLocaleTimeString()}  ${line}  output=${p.output?.state ?? "-"}`);
    last = line;
    const busy = p.shotsView.some((s) => s.inFlight) || p.output?.state === "stitching";
    if (!busy) return p;
    if (Date.now() - t0 > timeoutMs) fail("timed out");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function download(id, file, dest) {
  const res = await fetch(`${BASE}/api/projects/${id}/files/${file}`);
  if (!res.ok) fail(`download ${file}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const metaPath = (sample) => path.join("public/demo", sample, "clips.json");
function readMeta(sample) {
  try {
    const m = JSON.parse(readFileSync(metaPath(sample), "utf8"));
    return { ...m, moves: m.moves ?? {} };
  } catch {
    return { moves: {} };
  }
}

// ---------------------------------------------------------------- render clips
let grandTotal = 0;
if (!args["trailer-only"]) {
  if (!hasKey()) fail("COMFY_API_KEY is not set — add it to .env.local (never commit it)");
  await startServer({ RUNNER: "comfy" });
  const moves = only ?? MOVES;
  for (const sample of samples) {
    console.log(`\n▶ ${sample}: rendering ${moves.length} move(s) at ${CLIP_SECONDS}s with LTX on Comfy`);
    let p = await newSampleProject(sample);
    const template = p.shots[0];
    const shots = moves.map((move) => ({ ...template, id: undefined, move, duration: CLIP_SECONDS, note: "" }));
    p = await call("PATCH", `/api/projects/${p.id}`, { mode: "director", shots });
    await call("POST", `/api/projects/${p.id}/generate`, {});
    p = await settle(p.id);

    const meta = readMeta(sample);
    let total = 0;
    for (const s of p.shots) {
      const r = s.render;
      if (r?.state !== "done") {
        console.log(`  ✗ ${s.move}: ${r?.failReason ?? "not rendered"} — ${r?.error ?? ""}`);
        continue;
      }
      await download(p.id, r.clip, path.join("public/demo", sample, `${s.move}.mp4`));
      meta.moves[s.move] = { source: "ltx", credits: r.credits ?? 0, prompt: r.sentPrompt, renderedAt: new Date().toISOString() };
      total += r.credits ?? 0;
      console.log(`  ✓ ${s.move.padEnd(13)} ${String(r.credits ?? 0).padStart(6)} credits   "${r.sentPrompt}"`);
    }
    meta.source = MOVES.every((m) => meta.moves[m]?.source === "ltx") ? "ltx" : "partial";
    delete meta.note;
    writeFileSync(metaPath(sample), JSON.stringify(meta, null, 2) + "\n");
    grandTotal += total;
    console.log(`  ${sample}: ${total} credits for ${p.shots.filter((s) => s.render?.state === "done").length} clip(s)`);
    if (p.shots.some((s) => s.render?.state !== "done")) fail("some moves failed — fix and re-run with --only=<move>");
  }
  console.log(`\nCredits used this run: ${grandTotal}`);
}

// ---------------------------------------------------------------- sample trailer
const trailerSample = samples[0];
const meta = readMeta(trailerSample);
if (!args["trailer-only"] && meta.source !== "ltx") {
  console.log(`\nTrailer not rebuilt: ${trailerSample} still has placeholder moves. Render the rest to finish.`);
} else {
  console.log(`\n▶ sample-trailer.mp4 from the starter 4-shot list (${trailerSample}, pre-made clips, 0 credits)`);
  await startServer({ RUNNER: "demo", COMFY_API_KEY: "" });
  let p = await newSampleProject(trailerSample);
  await call("POST", `/api/projects/${p.id}/generate`, {});
  p = await settle(p.id);
  if (!p.outputFresh) fail(`trailer did not stitch: ${p.output?.error ?? p.shots.map((s) => s.render?.error).filter(Boolean).join("; ")}`);
  await download(p.id, p.output.file, "public/sample-trailer.mp4");
  console.log(`  ✓ public/sample-trailer.mp4 (${p.output.duration.toFixed(1)}s: ${p.shots.map((s) => s.move).join(" → ")})`);
}

server?.kill();
