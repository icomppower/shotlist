#!/usr/bin/env node
// One cheap real render on Comfy Cloud, printing Comfy's raw answers.
// Use it when a shot fails and you want to see exactly what Comfy said.
//
//   npm run comfy:smoke                       # text-to-video, default prompt
//   npm run comfy:smoke -- "a red apple on a wooden table"
//
// Reads COMFY_API_KEY from the environment or .env.local (never prints it).
// Renders 2 s at 768×416 with workflows/shotlist-t2v.json, prints the balance
// before/after, every status change, and the full error if it fails. The clip
// is saved as ./smoke-output.mp4.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.COMFY_API_BASE ?? "https://cloud.comfy.org").replace(/\/+$/, "");
const prompt = process.argv.slice(2).join(" ") || "A red apple on a wooden table, soft morning light.";

function readKey() {
  if (process.env.COMFY_API_KEY) return process.env.COMFY_API_KEY.trim();
  if (!existsSync(".env.local")) return "";
  const m = readFileSync(".env.local", "utf8").match(/^\s*COMFY_API_KEY\s*=\s*"?([^"\n#]*)"?/m);
  return m ? m[1].trim() : "";
}
const KEY = readKey();
if (!KEY) {
  console.error("✗ COMFY_API_KEY is not set — add it to .env.local");
  process.exit(1);
}
const redact = (t) => String(t).split(KEY).join("[redacted]");
const show = (label, body) => console.log(`  ${label}: ${redact(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 3000)}`);

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, redirect: "manual", headers: { "X-API-Key": KEY, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body };
}

async function balance() {
  const r = await api("/api/billing/balance");
  show(`balance (HTTP ${r.status})`, r.body);
  const b = r.body ?? {};
  return b.effective_balance_cents ?? b.prepaid_balance_cents ?? b.amount_cents;
}

console.log(`▶ Comfy smoke test → ${BASE}`);
console.log(`  prompt: "${prompt}"`);
const before = await balance();

const graph = JSON.parse(readFileSync("workflows/shotlist-t2v.json", "utf8"));
const map = JSON.parse(readFileSync("workflows/shotlist-t2v.map.json", "utf8"));
const values = { prompt, duration: 2, fps: 24, width: 768, height: 416, seed: Math.floor(Math.random() * 2 ** 31), frames: 49 };
for (const m of map.inputs) {
  if (!graph[m.node]) {
    console.error(`✗ shotlist-t2v.map.json points at node ${m.node}, which is not in shotlist-t2v.json`);
    process.exit(1);
  }
  if (values[m.from] !== undefined) graph[m.node].inputs[m.input] = values[m.from];
}

const sub = await api("/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
show(`submit (HTTP ${sub.status})`, sub.body);
const id = sub.body?.prompt_id;
if (!id) {
  console.error("✗ Comfy did not accept the job — the line above is its exact answer.");
  process.exit(1);
}

let last = "";
const t0 = Date.now();
for (;;) {
  const st = await api(`/api/job/${encodeURIComponent(id)}/status`);
  const status = String(st.body?.status ?? `HTTP ${st.status}`).toLowerCase();
  if (status !== last) {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${status}`);
    last = status;
  }
  if (["success", "completed", "succeeded", "done"].includes(status)) break;
  if (["error", "non_retryable_error", "lost", "failed", "cancelled", "canceled"].includes(status) || st.status >= 400) {
    show("status body", st.body);
    const details = await api(`/api/jobs/${encodeURIComponent(id)}`);
    show(`job details (HTTP ${details.status})`, details.body);
    console.error("✗ The render failed — the two lines above are Comfy's exact answer.");
    await balance();
    process.exit(1);
  }
  if (Date.now() - t0 > 15 * 60_000) {
    console.error("✗ Gave up after 15 minutes");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const details = await api(`/api/jobs/${encodeURIComponent(id)}`);
const files = Object.values(details.body?.outputs ?? {}).flatMap((o) => Object.values(o ?? {}).flat()).filter((f) => f?.filename);
const clip = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename)) ?? files[0];
if (!clip) {
  show("job details", details.body);
  console.error("✗ Finished without a video output");
  process.exit(1);
}
const q = new URLSearchParams({ filename: clip.filename, subfolder: clip.subfolder ?? "", type: clip.type ?? "output" });
let res = await fetch(`${BASE}/api/view?${q}`, { headers: { "X-API-Key": KEY }, redirect: "manual" });
if (res.status >= 300 && res.status < 400 && res.headers.get("location")) res = await fetch(new URL(res.headers.get("location"), BASE));
writeFileSync("smoke-output.mp4", Buffer.from(await res.arrayBuffer()));
console.log(`✓ Rendered ./smoke-output.mp4 (${clip.filename})`);
const after = await balance();
if (typeof before === "number" && typeof after === "number") console.log(`  cost: ${before - after} cents`);
