import "server-only";
import { pathToFileURL } from "node:url";
import { after } from "next/server";
import { buildMotionFilter } from "../server/motion";
import { ENCODE_ARGS, runFfmpeg } from "../server/ffmpeg";
import { getStorage, newId, scratchFile } from "../server/storage";
import type { JobRunner, JobStatus, ShotJobInput } from "./types";

/**
 * MockRunner: no API key, no GPU. Fakes a render by animating the uploaded
 * still with the chosen move (ffmpeg zoom/pan/rotate) and pretends the job
 * takes 3–8 s so the per-shot progress UI behaves like a real queue.
 *
 * MOCK_FAIL_SHOT=<n> makes the first render of shot n (1-based) come back as
 * a refusal, so the failure → "Edit & retry" path can be exercised.
 */

interface MockJob {
  id: string;
  /** Logged verbatim, including the exact prompt that was "sent". */
  input: ShotJobInput;
  createdAt: number;
  delayMs: number;
  state: "pending" | "rendered" | "failed";
  reason?: string;
  error?: string;
}

const g = globalThis as unknown as { __shotlistMockRenders?: Map<string, Promise<void>> };
const inflight = (g.__shotlistMockRenders ??= new Map());

const jobKey = (id: string) => `mock-jobs/${id}.json`;
const clipKey = (id: string) => `mock-jobs/${id}.mp4`;

async function readJob(id: string): Promise<MockJob> {
  if (!/^mock_[a-f0-9]+$/.test(id)) throw new Error(`unknown mock job ${id}`);
  const job = await getStorage().readJson<MockJob>(jobKey(id));
  if (!job) throw new Error(`unknown mock job ${id}`);
  return job;
}

const saveJob = (job: MockJob) => getStorage().writeJson(jobKey(job.id), job);

/** Keep the work alive past the response (needed on serverless; harmless locally). */
function background(p: Promise<unknown>) {
  try {
    after(() => p);
  } catch {
    // Outside a request scope — the promise just runs on its own.
  }
}

function simulatedRefusal(input: ShotJobInput): boolean {
  const n = Number(process.env.MOCK_FAIL_SHOT);
  return Number.isInteger(n) && n === input.shotIndex + 1 && input.attempt === 1;
}

function startRender(job: MockJob) {
  if (inflight.has(job.id)) return;
  const { input } = job;
  const p = (async () => {
    try {
      const out = await scratchFile("mock.mp4");
      await runFfmpeg([
        "-loop", "1", "-framerate", String(input.fps), "-t", String(input.durationSec),
        "-i", input.imagePath,
        "-filter_complex", buildMotionFilter(input.camera, input.durationSec),
        "-map", "[v]", "-frames:v", String(Math.round(input.durationSec * input.fps)),
        ...ENCODE_ARGS, out,
      ]);
      await getStorage().put(clipKey(job.id), { path: out }, "video/mp4");
      job.state = "rendered";
    } catch (err) {
      job.state = "failed";
      job.reason = "Render failed";
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
    if (simulatedRefusal(input)) {
      job.state = "failed";
      job.reason = "Refused by LTX";
      job.error = `Prompt refused by content moderation (simulated by MOCK_FAIL_SHOT=${process.env.MOCK_FAIL_SHOT})`;
    }
    await saveJob(job);
    if (job.state === "pending") startRender(job);
    return { jobId: job.id };
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const job = await readJob(jobId);
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < 600) return { state: "queued", progress: 0 };
    if (job.state === "failed") {
      // Simulated refusals still "take a while", like a real queue.
      if (elapsed < Math.min(job.delayMs, 3000)) return { state: "running", progress: elapsed / job.delayMs };
      return { state: "failed", progress: 0, reason: job.reason, error: job.error };
    }
    // If the server restarted mid-render, pick the job back up.
    if (job.state === "pending" && !inflight.has(job.id)) startRender(job);
    if (job.state === "rendered" && elapsed >= job.delayMs) return { state: "done", progress: 1 };
    return { state: "running", progress: Math.min(elapsed / job.delayMs, 0.97) };
  }

  async getClipUrl(jobId: string) {
    const job = await readJob(jobId);
    if (job.state !== "rendered") throw new Error(`mock job ${jobId} is not done`);
    return pathToFileURL(await getStorage().localPath(clipKey(jobId))).href;
  }

  async getCreditsUsed(jobId: string) {
    const job = await readJob(jobId);
    // Pretend pricing so the credits UI has something to show.
    return job.state === "rendered" ? job.input.durationSec * 2 : 0;
  }
}
