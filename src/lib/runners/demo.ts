import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after } from "next/server";
import { planPrompt } from "../moves";
import { findSample } from "../samples";
import { ENCODE_ARGS, runFfmpeg } from "../server/ffmpeg";
import { getStorage, newId, scratchFile } from "../server/storage";
import type { JobRunner, JobStatus, ShotJobInput } from "./types";

/**
 * DemoRunner (RUNNER=demo, the live link): no API key on the server. For a
 * bundled sample image it replays the pre-made LTX clip for the shot's move
 * (public/demo/<sample>/<move>.mp4), trimmed to the shot's length, after a
 * short fake delay. Anything else needs the visitor's own Comfy key.
 */

export const NEEDS_KEY = "Paste a Comfy key to render your own.";

interface DemoJob {
  id: string;
  input: ShotJobInput;
  createdAt: number;
  delayMs: number;
  state: "pending" | "ready" | "failed";
  error?: string;
}

const DEMO_DIR = path.join(process.cwd(), "public", "demo");
const g = globalThis as unknown as { __shotlistDemoRenders?: Map<string, Promise<void>> };
const inflight = (g.__shotlistDemoRenders ??= new Map());
const jobKey = (id: string) => `demo-jobs/${id}.json`;
const clipKey = (id: string) => `demo-jobs/${id}.mp4`;

export function demoClipPath(sampleId: string, move: string): string {
  return path.join(DEMO_DIR, sampleId, `${move}.mp4`);
}

/** Pre-made clips are "real" once make-demo-clips has replaced the placeholders. */
export async function demoClipsAreReal(sampleId: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(DEMO_DIR, sampleId, "clips.json"), "utf8"));
    return meta.source === "ltx";
  } catch {
    return false;
  }
}

async function readJob(id: string): Promise<DemoJob> {
  if (!/^demo_[a-f0-9]+$/.test(id)) throw new Error(`unknown demo job ${id}`);
  const job = await getStorage().readJson<DemoJob>(jobKey(id));
  if (!job) throw new Error(`unknown demo job ${id}`);
  return job;
}

function startTrim(job: DemoJob) {
  if (inflight.has(job.id)) return;
  const { input } = job;
  const p = (async () => {
    try {
      if (input.camera.kind !== "preset" || !input.sampleId) throw new Error(NEEDS_KEY);
      const out = await scratchFile("demo.mp4");
      await runFfmpeg([
        "-i", demoClipPath(input.sampleId, input.camera.move),
        "-t", String(input.durationSec),
        "-vf", `fps=${input.fps},scale=${input.width}:${input.height}:force_original_aspect_ratio=increase,crop=${input.width}:${input.height},setsar=1`,
        ...ENCODE_ARGS, out,
      ]);
      await getStorage().put(clipKey(job.id), { path: out }, "video/mp4");
      job.state = "ready";
    } catch (err) {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
    await getStorage().writeJson(jobKey(job.id), job);
  })().finally(() => inflight.delete(job.id));
  inflight.set(job.id, p);
  try {
    after(() => p);
  } catch {
    // not in a request scope
  }
}

export class DemoRunner implements JobRunner {
  readonly name = "demo";

  /** Only exact replays: a sample image, a preset move, and the prompt the clip was rendered with. */
  check(input: ShotJobInput): string | null {
    if (!input.sampleId || !findSample(input.sampleId)) return NEEDS_KEY;
    if (input.camera.kind !== "preset") return NEEDS_KEY;
    if (input.prompt !== planPrompt(input.camera.move, "")) return NEEDS_KEY;
    return null;
  }

  async submitShot(input: ShotJobInput) {
    const job: DemoJob = {
      id: `demo_${newId(8)}`,
      input,
      createdAt: Date.now(),
      delayMs: 1500 + Math.floor(Math.random() * 1500),
      state: "pending",
    };
    await getStorage().writeJson(jobKey(job.id), job);
    startTrim(job);
    return { jobId: job.id };
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const job = await readJob(jobId);
    if (job.state === "failed") return { state: "failed", progress: 0, reason: "Render failed", error: job.error };
    if (job.state === "pending" && !inflight.has(job.id)) startTrim(job);
    const elapsed = Date.now() - job.createdAt;
    if (job.state === "ready" && elapsed >= job.delayMs) return { state: "done", progress: 1 };
    return { state: "running", progress: Math.min(elapsed / job.delayMs, 0.95) };
  }

  async getClipUrl(jobId: string) {
    const job = await readJob(jobId);
    if (job.state !== "ready") throw new Error(`demo job ${jobId} is not done`);
    return pathToFileURL(await getStorage().localPath(clipKey(jobId))).href;
  }

  async getCreditsUsed() {
    return 0; // pre-made: nothing is billed
  }
}
