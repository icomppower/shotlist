import "server-only";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { after } from "next/server";
import { CROSSFADE_SECONDS, planPrompt, type CameraParams } from "../moves";
import type { Project, ProjectView, Shot } from "../types";
import { redact, runnerFor, runnerMode, type RunContext } from "../runners";
import { VIDEO } from "./ffmpeg";
import { DemoLimitError, demoReason, reserveShots } from "./limits";
import { HttpError } from "./projects";
import { stitchClips } from "./stitch";
import { getStorage, hash, projectKey, scratchFile, withProject } from "./storage";

/**
 * Orchestration is poll-driven: every GET of a project advances its jobs
 * (status -> fetch clip -> stitch). No long-lived worker is needed, which is
 * what the Comfy runner on serverless wants too.
 */

/** The exact prompt a shot sends in the project's current mode. */
export function resolvePrompt(p: Project, s: Shot): string {
  return p.mode === "director" ? planPrompt(s.move, s.note) : s.prompt;
}

export function resolveCamera(p: Project, s: Shot): CameraParams {
  return p.mode === "manual" ? { kind: "manual", ...s.camera } : { kind: "preset", move: s.move };
}

/**
 * Keyed on what is actually sent, so a mode switch that keeps the same prompt
 * and camera re-renders nothing. Not keyed on the runner: a shared link shows
 * the same cut whether or not the viewer has a key.
 */
export function renderKey(p: Project, s: Shot): string {
  return hash(JSON.stringify([p.image.file, resolveCamera(p, s), s.duration, resolvePrompt(p, s), s.take]));
}

function isFresh(p: Project, s: Shot): boolean {
  return s.render?.state === "done" && s.render.key === renderKey(p, s) && !!s.render.clip;
}

function isInFlight(p: Project, s: Shot): boolean {
  const r = s.render;
  return !!r && (r.state === "queued" || r.state === "running") && r.key === renderKey(p, s);
}

export function stitchKey(p: Project): string {
  return hash([CROSSFADE_SECONDS, ...p.shots.map((s) => s.render?.clip ?? "-")].join("|"));
}

export async function toView(p: Project, ctx: RunContext): Promise<ProjectView> {
  const shotsView = p.shots.map((s) => ({
    id: s.id,
    fresh: isFresh(p, s),
    inFlight: isInFlight(p, s),
    prompt: resolvePrompt(p, s),
  }));
  const allFresh = p.shots.length > 0 && shotsView.every((v) => v.fresh);
  const total = p.shots.reduce((t, s) => t + s.duration, 0) - CROSSFADE_SECONDS * Math.max(p.shots.length - 1, 0);
  return {
    ...p,
    runner: runnerMode(),
    shotsView,
    outputFresh: allFresh && p.output?.state === "done" && p.output.key === stitchKey(p),
    expectedDuration: Math.max(total, 0),
    demo: await demoReason(ctx),
  };
}

/**
 * Submit every shot whose current settings have no done/in-flight render
 * (failed shots count as out of date). `force` ids get a new take even if up
 * to date; `only`, when given, limits submission to those ids.
 * Throws DemoLimitError if the renders would exceed the daily cap.
 */
export async function submitStale(
  p: Project,
  ctx: RunContext,
  opts: { force?: string[]; only?: string[] } = {},
): Promise<string[]> {
  const { runner } = ctx;
  const force = opts.force ?? [];
  const todo = p.shots
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => !opts.only || opts.only.includes(s.id))
    .filter(({ s }) => {
      const r = s.render;
      if (force.includes(s.id)) return true;
      return !(r && r.key === renderKey(p, s) && r.state !== "failed");
    });
  if (todo.length === 0) return [];

  const why = await demoReason(ctx);
  if (why === "no-key") throw new DemoLimitError(why);

  const imagePath = await getStorage().localPath(projectKey(p.id, p.image.file));
  const inputFor = (s: Shot, index: number) => {
    const key = renderKey(p, s);
    return {
      key,
      input: {
        projectId: p.id,
        shotId: s.id,
        shotIndex: index,
        attempt: s.renderCount + 1,
        sampleId: p.sample,
        imagePath,
        imageMime: p.image.mime,
        mode: p.mode,
        prompt: resolvePrompt(p, s),
        camera: resolveCamera(p, s),
        durationSec: s.duration,
        width: VIDEO.width,
        height: VIDEO.height,
        fps: VIDEO.fps,
        seed: parseInt(key.slice(0, 8), 16),
      },
    };
  };
  // Pre-flight every shot before submitting any (e.g. demo mode can only replay).
  for (const { s, index } of todo) {
    const problem = runner.check?.(inputFor(s, index).input);
    if (problem) throw new HttpError(400, problem);
  }
  if (ctx.billedToServer && !(await reserveShots(todo.length))) throw new DemoLimitError("cap");

  for (const { s, index } of todo) {
    if (force.includes(s.id)) s.take += 1;
    const { key, input } = inputFor(s, index);
    const prompt = input.prompt;
    s.renderCount += 1;
    const { jobId } = await runner.submitShot(input);
    s.render = {
      jobId, runner: runner.name, key, mode: p.mode, sentPrompt: prompt,
      state: "queued", progress: 0, submittedAt: Date.now(),
    };
  }
  return todo.map(({ s }) => s.id);
}

async function downloadClip(url: string): Promise<string> {
  if (url.startsWith("file:")) return fileURLToPath(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`clip download failed: ${res.status}`);
  const tmp = await scratchFile("clip.mp4");
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  return tmp;
}

/** Poll in-flight jobs, collect finished clips, and kick off stitching. */
export async function advance(p: Project, ctx: RunContext): Promise<void> {
  const storage = getStorage();
  for (const s of p.shots) {
    const r = s.render;
    if (!r || (r.state !== "queued" && r.state !== "running")) continue;
    // A job on someone's own Comfy key can only be polled by a request carrying it.
    const runner = runnerFor(r.runner, ctx);
    if (!runner) continue;
    try {
      const st = await runner.getStatus(r.jobId);
      r.progress = st.progress;
      if (st.state === "failed") {
        r.state = "failed";
        r.failReason = st.reason ?? "Render failed";
        r.error = redact(st.error ?? r.failReason, ctx.userKey);
      } else if (st.state === "done") {
        const clip = `clip-${s.id}-${r.key}.mp4`;
        const local = await downloadClip(await runner.getClipUrl(r.jobId));
        // Copy, never move: a file:// clip belongs to the runner.
        const copy = await scratchFile("clip.mp4");
        await fs.copyFile(local, copy);
        await storage.put(projectKey(p.id, clip), { path: copy }, "video/mp4");
        r.credits = await runner.getCreditsUsed(r.jobId);
        p.creditsUsed += r.credits;
        r.clip = clip;
        r.state = "done";
        r.progress = 1;
        r.finishedAt = Date.now();
      } else {
        r.state = st.state;
      }
    } catch (err) {
      r.state = "failed";
      r.failReason = "Render failed";
      r.error = redact(err instanceof Error ? err.message : String(err), ctx.userKey);
    }
  }
  maybeStitch(p);
}

const g = globalThis as unknown as { __shotlistStitches?: Map<string, Promise<void>> };
const stitching = (g.__shotlistStitches ??= new Map());

/** Stitch only when every shot is current; a failed shot blocks it until fixed. */
function maybeStitch(p: Project) {
  if (p.shots.length === 0 || !p.shots.every((s) => isFresh(p, s))) return;
  const key = stitchKey(p);
  if (p.output?.key === key && p.output.state !== "stitching") return; // done or failed for this cut
  const lockKey = `${p.id}:${key}`;
  if (stitching.has(lockKey)) return;

  const clipKeys = p.shots.map((s) => projectKey(p.id, s.render!.clip!));
  const file = `shotlist-${p.id}-${key}.mp4`;
  p.output = { key, state: "stitching", file: p.output?.file, startedAt: Date.now() };

  const job = (async () => {
    const storage = getStorage();
    let result: { duration?: number; error?: string };
    try {
      const clips = await Promise.all(clipKeys.map((k) => storage.localPath(k)));
      const out = await scratchFile("stitch.mp4");
      const duration = await stitchClips(clips, out);
      await storage.put(projectKey(p.id, file), { path: out }, "video/mp4");
      result = { duration };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    await withProject(p.id, async (cur) => {
      if (cur.output?.key !== key) return; // superseded by a newer cut
      const old = cur.output.file;
      if (result.error) {
        cur.output = { ...cur.output, state: "failed", error: result.error, finishedAt: Date.now() };
        return;
      }
      cur.output = { key, state: "done", file, duration: result.duration, startedAt: cur.output.startedAt, finishedAt: Date.now() };
      if (old && old !== file) await storage.delete(projectKey(p.id, old));
    });
  })().finally(() => stitching.delete(lockKey));
  stitching.set(lockKey, job);
  try {
    after(() => job);
  } catch {
    // not in a request scope
  }
}
