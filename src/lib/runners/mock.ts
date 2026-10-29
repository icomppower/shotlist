import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after } from "next/server";
import { buildMotionFilter } from "../server/motion";
import { ENCODE_ARGS, runFfmpeg } from "../server/ffmpeg";
import { DATA_DIR, newId } from "../server/storage";
import type { JobRunner, JobStatus, ShotJobInput } from "./types";

/**
 * MockRunner: no API key, no GPU. Fakes a render by animating the uploaded
 * still with the chosen move (ffmpeg zoom/pan/rotate) and pretends the job
 * takes 3–8 s so the per-shot progress UI behaves like a real queue.
 */

interface MockJob {
  id: string;
  /** Logged verbatim, including the exact prompt that was "sent". */
  input: ShotJobInput;
  createdAt: number;
  delayMs: number;
  state: "pending" | "rendered" | "failed";
  error?: string;
}

const JOBS_DIR = path.join(DATA_DIR, "mock-jobs");
const g = globalThis as unknown as { __shotlistMockRenders?: Map<string, Promise<void>> };
const inflight = (g.__shotlistMockRenders ??= new Map());

const jobFile = (id: string) => path.join(JOBS_DIR, `${id}.json`);
const clipFile = (id: string) => path.join(JOBS_DIR, `${id}.mp4`);

async function readJob(id: string): Promise<MockJob> {
  if (!/^mock_[a-f0-9]+$/.test(id)) throw new Error(`unknown mock job ${id}`);
  return JSON.parse(await fs.readFile(jobFile(id), "utf8")) as MockJob;
}

async function saveJob(job: MockJob) {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.writeFile(jobFile(job.id), JSON.stringify(job));
}

/** Keep the work alive past the response (needed on serverless; harmless locally). */
function background(p: Promise<unknown>) {
  try {
    after(() => p);
  } catch {
    // Outside a request scope — the promise just runs on its own.
  }
}

function startRender(job: MockJob) {
  if (inflight.has(job.id)) return;
  const { input } = job;
  const out = clipFile(job.id);
  const p = (async () => {
    try {
      await runFfmpeg([
        "-loop", "1", "-framerate", String(input.fps), "-t", String(input.durationSec),
        "-i", input.imagePath,
        "-filter_complex", buildMotionFilter(input.camera, input.durationSec),
        "-map", "[v]", "-frames:v", String(Math.round(input.durationSec * input.fps)),
        ...ENCODE_ARGS, `${out}.part.mp4`,
      ]);
      await fs.rename(`${out}.part.mp4`, out);
      job.state = "rendered";
    } catch (err) {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
    await saveJob(job);
  })().finally(() => inflight.delete(job.id));
  inflight.set(job.id, p);
  background(p);
}

export class MockRunner implements JobRunner {
  readonly name = "mock";

  async submitShot(input: ShotJobInput) {
    const job: MockJob = {
      id: `mock_${newId(8)}`,
      input,
      createdAt: Date.now(),
      delayMs: 3000 + Math.floor(Math.random() * 5000),
      state: "pending",
    };
    await saveJob(job);
    startRender(job);
    return { jobId: job.id };
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const job = await readJob(jobId);
    if (job.state === "failed") return { state: "failed", progress: 0, error: job.error };
    // If the server restarted mid-render, pick the job back up.
    if (job.state === "pending" && !inflight.has(job.id)) startRender(job);
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < 600) return { state: "queued", progress: 0 };
    if (job.state === "rendered" && elapsed >= job.delayMs) return { state: "done", progress: 1 };
    return { state: "running", progress: Math.min(elapsed / job.delayMs, 0.97) };
  }

  async getClipUrl(jobId: string) {
    const job = await readJob(jobId);
    if (job.state !== "rendered") throw new Error(`mock job ${jobId} is not done`);
    return pathToFileURL(clipFile(jobId)).href;
  }

  async getCreditsUsed(jobId: string) {
    const job = await readJob(jobId);
    // Pretend pricing so the credits UI has something to show.
    return job.state === "rendered" ? job.input.durationSec * 2 : 0;
  }
}
