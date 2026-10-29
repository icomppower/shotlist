import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getStorage, newId, scratchFile, withLock } from "../server/storage";
import type { JobRunner, JobStatus, ShotJobInput } from "./types";

/**
 * ComfyRunner — renders shots with LTX 2.5 on the Comfy Cloud API
 * (https://docs.comfy.org/development/cloud/api-reference).
 *
 *   upload image  POST /api/upload/image         (multipart: image, type, overwrite)
 *   submit        POST /api/prompt               { prompt: <API-format workflow> }
 *   status        GET  /api/job/{prompt_id}/status
 *   outputs       GET  /api/jobs/{prompt_id}
 *   download      GET  /api/view?filename&subfolder&type   (may 302 to a signed URL)
 *
 * Auth is the X-API-Key header: the visitor's own key (bring-your-own-key,
 * held only for the request) or COMFY_API_KEY for local RUNNER=comfy. The key
 * is never written to job records and is redacted from stored errors.
 * The workflow comes from
 * workflows/shotlist.json; workflows/shotlist.map.json says which node inputs
 * get the image, prompt, frame count, fps, size, seed and camera move.
 * The prompt is injected byte-for-byte. At most MAX_CONCURRENT jobs per
 * project run on Comfy at once; the rest wait in a small per-project queue
 * (per project, because each visitor's queue can only be advanced with their key).
 *
 * UNTESTED against the live API (built without a key) — see README.
 */

const BASE = (process.env.COMFY_API_BASE ?? "https://cloud.comfy.org").replace(/\/+$/, "");
const MAX_CONCURRENT = 3;
const queueKey = (projectId: string) => `comfy-jobs/queue-${projectId}.json`;
const WORKFLOW_DIR = path.join(process.cwd(), "workflows");

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

type Source =
  | "image" | "prompt" | "frames" | "fps" | "width" | "height" | "seed" | "duration"
  | "camera.move" | "camera.zoomStart" | "camera.zoomEnd" | "camera.panX" | "camera.panY" | "camera.roll";

interface NodeMap {
  inputs: Array<{
    from: Source;
    node: string;
    input: string;
    /** Optional value table, e.g. camera.move -> LoRA file name. */
    lookup?: Record<string, unknown>;
    /** Used when the source is missing or not in `lookup`; omit to leave the node untouched. */
    default?: unknown;
  }>;
  /** Node whose output is the finished clip. */
  output: { node: string };
}

interface ComfyJob {
  id: string;
  input: ShotJobInput;
  state: "waiting" | "submitted" | "done" | "failed";
  createdAt: number;
  submittedAt?: number;
  promptId?: string;
  output?: { filename: string; subfolder: string; type: string };
  credits: number;
  reason?: string;
  error?: string;
}

const jobKey = (id: string) => `comfy-jobs/${id}.json`;
const saveJob = (j: ComfyJob) => getStorage().writeJson(jobKey(j.id), j);

/** LTX wants 8n+1 frames. */
export function ltxFrames(durationSec: number, fps: number): number {
  return Math.max(1, Math.round((durationSec * fps) / 8)) * 8 + 1;
}

/** Map Comfy errors to the shot's short failure reason. */
export function classifyFailure(detail: string, status?: number): string {
  if (/moderat|content.?polic|refus|safety|nsfw|flagged|prohibited|not allowed/i.test(detail)) return "Refused by LTX";
  if (status === 401 || status === 403) return "Comfy API key rejected";
  if (status === 402 || /credit|insufficient|balance/i.test(detail)) return "Out of Comfy credits";
  if (status === 429) return "Comfy rate limit — try again shortly";
  return "Render failed";
}

class ComfyHttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(`Comfy API ${status}: ${detail.slice(0, 500)}`);
  }
}

type Queue = { active: string[]; waiting: string[] };

// Workflow files are read once per process.
let cachedFlow: Promise<{ workflow: Workflow; map: NodeMap }> | undefined;

export class ComfyRunner implements JobRunner {
  readonly name = "comfy";

  constructor(private readonly apiKey: string) {}

  private key(): string {
    if (!this.apiKey) throw new ComfyHttpError(401, "No Comfy API key");
    return this.apiKey;
  }

  private async api(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { "X-API-Key": this.key(), ...(init.headers ?? {}) },
      redirect: "manual",
    });
    if (res.status >= 400) throw new ComfyHttpError(res.status, await res.text().catch(() => ""));
    return res;
  }

  private loadWorkflow(): Promise<{ workflow: Workflow; map: NodeMap }> {
    cachedFlow ??= (async () => ({
      workflow: JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, "shotlist.json"), "utf8")) as Workflow,
      map: JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, "shotlist.map.json"), "utf8")) as NodeMap,
    }))();
    return cachedFlow;
  }

  /** Fill the mapped node inputs. The prompt goes in exactly as given. */
  private async buildPrompt(input: ShotJobInput, imageName: string): Promise<Workflow> {
    const { workflow, map } = await this.loadWorkflow();
    const graph = structuredClone(workflow);
    const cam = input.camera;
    const values: Partial<Record<Source, unknown>> = {
      image: imageName,
      prompt: input.prompt,
      frames: ltxFrames(input.durationSec, input.fps),
      fps: input.fps,
      width: input.width,
      height: input.height,
      seed: input.seed,
      duration: input.durationSec,
      "camera.move": cam.kind === "preset" ? cam.move : undefined,
      ...(cam.kind === "manual"
        ? {
            "camera.zoomStart": cam.zoomStart, "camera.zoomEnd": cam.zoomEnd,
            "camera.panX": cam.panX, "camera.panY": cam.panY, "camera.roll": cam.roll,
          }
        : {}),
    };
    for (const m of map.inputs) {
      const node = graph[m.node];
      if (!node) throw new Error(`workflows/shotlist.map.json: node ${m.node} not in shotlist.json`);
      const raw = values[m.from];
      let v: unknown = raw;
      if (m.lookup) v = raw !== undefined && String(raw) in m.lookup ? m.lookup[String(raw)] : undefined;
      if (v === undefined) v = m.default;
      if (v !== undefined) node.inputs[m.input] = v;
    }
    return graph;
  }

  private async uploadImage(input: ShotJobInput): Promise<string> {
    const bytes = await fs.readFile(input.imagePath);
    const form = new FormData();
    const ext = input.imageMime.split("/")[1] ?? "png";
    form.append("image", new Blob([bytes], { type: input.imageMime }), `shotlist-${input.projectId}.${ext}`);
    form.append("type", "input");
    form.append("overwrite", "true");
    const body = (await (await this.api("/api/upload/image", { method: "POST", body: form })).json()) as {
      name: string;
      subfolder?: string;
    };
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  // ---------------------------------------------------------------- queue

  private async dispatch(projectId: string): Promise<void> {
    await withLock(`comfy-dispatch:${projectId}`, async () => {
      const storage = getStorage();
      const q = (await storage.readJson<Queue>(queueKey(projectId))) ?? { active: [], waiting: [] };
      while (q.active.length < MAX_CONCURRENT && q.waiting.length > 0) {
        const id = q.waiting.shift()!;
        const job = await storage.readJson<ComfyJob>(jobKey(id));
        if (!job || job.state !== "waiting") continue;
        try {
          const image = await this.uploadImage(job.input);
          const prompt = await this.buildPrompt(job.input, image);
          const res = await this.api("/api/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt }),
          });
          const body = (await res.json()) as { prompt_id?: string; node_errors?: unknown; error?: unknown };
          if (!body.prompt_id) throw new ComfyHttpError(400, JSON.stringify(body.error ?? body.node_errors ?? body));
          job.promptId = body.prompt_id;
          job.state = "submitted";
          job.submittedAt = Date.now();
          q.active.push(id);
        } catch (err) {
          this.fail(job, err);
        }
        await saveJob(job);
      }
      await storage.writeJson(queueKey(projectId), q);
    });
  }

  private async release(job: ComfyJob) {
    const projectId = job.input.projectId;
    await withLock(`comfy-dispatch:${projectId}`, async () => {
      const storage = getStorage();
      const q = (await storage.readJson<Queue>(queueKey(projectId))) ?? { active: [], waiting: [] };
      q.active = q.active.filter((x) => x !== job.id);
      await storage.writeJson(queueKey(projectId), q);
    });
    await this.dispatch(projectId);
  }

  private fail(job: ComfyJob, err: unknown) {
    const raw = err instanceof ComfyHttpError ? err.detail : err instanceof Error ? err.message : String(err);
    const detail = raw.split(this.apiKey || "\u0000").join("[redacted]");
    job.state = "failed";
    job.reason = classifyFailure(detail, err instanceof ComfyHttpError ? err.status : undefined);
    job.error = detail.slice(0, 2000);
  }

  private trackCredits(job: ComfyJob, res: Response) {
    const c = Number(res.headers.get("X-Comfy-Credits-Used"));
    if (Number.isFinite(c) && c > job.credits) job.credits = c;
  }

  // ---------------------------------------------------------------- JobRunner

  async submitShot(input: ShotJobInput): Promise<{ jobId: string }> {
    this.key();
    const job: ComfyJob = { id: `comfy_${newId(8)}`, input, state: "waiting", createdAt: Date.now(), credits: 0 };
    await saveJob(job);
    await withLock(`comfy-dispatch:${input.projectId}`, async () => {
      const storage = getStorage();
      const q = (await storage.readJson<Queue>(queueKey(input.projectId))) ?? { active: [], waiting: [] };
      q.waiting.push(job.id);
      await storage.writeJson(queueKey(input.projectId), q);
    });
    await this.dispatch(input.projectId);
    return { jobId: job.id };
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const job = await this.read(jobId);
    if (job.state === "waiting") {
      await this.dispatch(job.input.projectId);
      return { state: "queued", progress: 0 };
    }
    if (job.state === "failed") return { state: "failed", progress: 0, reason: job.reason, error: job.error };
    if (job.state === "done") return { state: "done", progress: 1 };

    try {
      const res = await this.api(`/api/job/${encodeURIComponent(job.promptId!)}/status`);
      this.trackCredits(job, res);
      const body = (await res.json()) as { status?: string; progress?: number; error?: unknown };
      const status = String(body.status ?? "").toLowerCase();
      if (["completed", "success", "succeeded", "done"].includes(status)) {
        job.output = await this.findOutput(job);
        job.state = "done";
      } else if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const detail = await this.errorDetail(job, body.error);
        this.fail(job, new Error(detail));
      } else {
        await saveJob(job);
        const est = (Date.now() - (job.submittedAt ?? job.createdAt)) / 90_000;
        const progress = typeof body.progress === "number" ? body.progress : Math.min(est, 0.95);
        return { state: ["pending", "queued", "waiting"].includes(status) ? "queued" : "running", progress };
      }
    } catch (err) {
      // Transient network errors: keep polling. HTTP errors fail the shot.
      if (!(err instanceof ComfyHttpError)) return { state: "running", progress: 0 };
      this.fail(job, err);
    }
    await saveJob(job);
    await this.release(job);
    return job.state === "done"
      ? { state: "done", progress: 1 }
      : { state: "failed", progress: 0, reason: job.reason, error: job.error };
  }

  private async jobDetails(job: ComfyJob): Promise<Record<string, unknown>> {
    const res = await this.api(`/api/jobs/${encodeURIComponent(job.promptId!)}`);
    this.trackCredits(job, res);
    return (await res.json()) as Record<string, unknown>;
  }

  private async errorDetail(job: ComfyJob, fromStatus: unknown): Promise<string> {
    if (fromStatus) return typeof fromStatus === "string" ? fromStatus : JSON.stringify(fromStatus);
    try {
      const d = await this.jobDetails(job);
      return JSON.stringify(d.error ?? d.status ?? d).slice(0, 2000);
    } catch {
      return "Comfy job failed";
    }
  }

  /** Pick the clip from the job's outputs, preferring the mapped output node. */
  private async findOutput(job: ComfyJob): Promise<ComfyJob["output"]> {
    const { map } = await this.loadWorkflow();
    const details = await this.jobDetails(job);
    const outputs = (details.outputs ?? {}) as Record<string, Record<string, unknown>>;
    const files: Array<{ filename: string; subfolder?: string; type?: string; node: string }> = [];
    for (const [node, out] of Object.entries(outputs)) {
      for (const list of Object.values(out ?? {})) {
        if (!Array.isArray(list)) continue;
        for (const f of list) if (f && typeof f.filename === "string") files.push({ ...f, node });
      }
    }
    const isVideo = (f: { filename: string }) => /\.(mp4|webm|mov|mkv)$/i.test(f.filename);
    const pick =
      files.find((f) => f.node === map.output.node && isVideo(f)) ?? files.find(isVideo) ?? files.find((f) => f.node === map.output.node);
    if (!pick) throw new ComfyHttpError(500, "Comfy job finished without a video output");
    return { filename: pick.filename, subfolder: pick.subfolder ?? "", type: pick.type ?? "output" };
  }

  async getClipUrl(jobId: string): Promise<string> {
    const job = await this.read(jobId);
    if (job.state !== "done" || !job.output) throw new Error(`comfy job ${jobId} is not done`);
    const q = new URLSearchParams({ filename: job.output.filename, subfolder: job.output.subfolder, type: job.output.type });
    let res = await this.api(`/api/view?${q}`);
    this.trackCredits(job, res);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Signed storage URL: fetch it without our API key.
      res = await fetch(new URL(location, BASE));
      if (!res.ok) throw new Error(`clip download failed: ${res.status}`);
    }
    const file = await scratchFile(`${jobId}.mp4`);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    await saveJob(job);
    return pathToFileURL(file).href;
  }

  async getCreditsUsed(jobId: string): Promise<number> {
    return (await this.read(jobId)).credits;
  }

  private async read(jobId: string): Promise<ComfyJob> {
    if (!/^comfy_[a-f0-9]+$/.test(jobId)) throw new Error(`unknown comfy job ${jobId}`);
    const job = await getStorage().readJson<ComfyJob>(jobKey(jobId));
    if (!job) throw new Error(`unknown comfy job ${jobId}`);
    return job;
  }
}
