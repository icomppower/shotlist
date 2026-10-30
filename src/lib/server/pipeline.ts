import "server-only";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { after } from "next/server";
import { CROSSFADE_SECONDS, manualCameraPhrase, planPrompt, type CameraParams } from "../moves";
import { DEFAULT_SIZE, sizeDims, type Project, type ProjectView, type Shot } from "../types";
import { redact, runnerFor, runnerMode, type RunContext } from "../runners";
import { VIDEO, extractLastFrame } from "./ffmpeg";
import { DemoLimitError, demoReason, reserveShots } from "./limits";
import { HttpError } from "./projects";
import { stitchClips } from "./stitch";
import { getStorage, hash, projectKey, scratchFile, withProject } from "./storage";

/**
 * Orchestration is poll-driven: every GET of a project advances its jobs
 * (status -> fetch clip -> stitch). No long-lived worker is needed, which is
 * what the Comfy runner on serverless wants too.
 *
 * Text-only projects (a scene, no image): shot 1 is text-to-video with the
 * scene as its prompt, verbatim. When it finishes, its last frame becomes the
 * project's image and shots 2+ are submitted as image-to-video from it.
 */

/** Shot 1 of a text-only project renders text-to-video. */
export const isT2V = (p: Project, index: number) => !!p.scene && index === 0;

/**
 * The exact prompt a shot sends in the project's current mode.
 * Direct: the user's text, verbatim. Director: the planner's text.
 * Manual: the user's text, verbatim, then a short camera phrase appended in
 * code (LTX 2.5 has no camera LoRA on Comfy Cloud); it is shown in "Sent to LTX:".
 */
export function resolvePrompt(p: Project, s: Shot, index: number): string {
  if (isT2V(p, index)) return p.scene!; // the scene text as typed, never rewritten
  if (p.mode === "director") return planPrompt(s.move, s.note, s.shotNote);
  if (p.mode === "manual") {
    const cam = manualCameraPhrase(s.camera);
    return cam ? (s.prompt ? `${s.prompt} ${cam}` : cam) : s.prompt;
  }
  return s.prompt;
}

export function resolveCamera(p: Project, s: Shot): CameraParams {
  return p.mode === "manual" ? { kind: "manual", ...s.camera } : { kind: "preset", move: s.move };
}

/**
 * Keyed on what is actually sent, so a mode switch that keeps the same prompt
 * and camera re-renders nothing. Not keyed on the runner: a shared link shows
 * the same cut whether or not the viewer has a key.
 */
export function renderKey(p: Project, s: Shot, index: number): string {
  // A t2v shot has no image; every other shot depends on the reference still,
  // which for a text-only project is shot 1's last frame (named by its render key).
  const source = isT2V(p, index) ? ["t2v"] : [p.image?.file ?? "-"];
  return hash(JSON.stringify([...source, resolveCamera(p, s), s.duration, resolvePrompt(p, s, index), s.take, p.size ?? DEFAULT_SIZE]));
}

/** The reference still exists and (text-only) matches shot 1's current render. */
function frameReady(p: Project): boolean {
  if (!p.scene) return !!p.image;
  const s0 = p.shots[0];
  return !!s0 && !!p.image && isFresh(p, s0, 0) && p.frameOf === s0.render!.key;
}

function isFresh(p: Project, s: Shot, index: number): boolean {
  const done = s.render?.state === "done" && s.render.key === renderKey(p, s, index) && !!s.render.clip;
  return done && (index === 0 || !p.scene || frameReady(p));
}

function isInFlight(p: Project, s: Shot, index: number): boolean {
  const r = s.render;
  return !!r && (r.state === "queued" || r.state === "running") && r.key === renderKey(p, s, index);
}

export function stitchKey(p: Project): string {
  return hash([CROSSFADE_SECONDS, ...p.shots.map((s) => s.render?.clip ?? "-")].join("|"));
}

export async function toView(p: Project, ctx: RunContext): Promise<ProjectView> {
  const shotsView = p.shots.map((s, i) => ({
    id: s.id,
    fresh: isFresh(p, s, i),
    inFlight: isInFlight(p, s, i),
    prompt: resolvePrompt(p, s, i),
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
 * to date; `only`, when given, limits submission to those ids. In a text-only
 * project, shots 2+ wait for shot 1's frame; advance() submits them then.
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
    .filter(({ s, index }) => {
      const r = s.render;
      if (force.includes(s.id)) return true;
      return !(r && r.key === renderKey(p, s, index) && r.state !== "failed");
    })
    // Image-to-video needs the reference still; for text-only projects that is shot 1's last frame.
    .filter(({ index }) => isT2V(p, index) || frameReady(p));
  if (todo.length === 0) return [];

  const why = await demoReason(ctx);
  if (why === "no-key") throw new DemoLimitError(why);

  const imagePath = p.image ? await getStorage().localPath(projectKey(p.id, p.image.file)) : undefined;
  const inputFor = (s: Shot, index: number) => {
    const key = renderKey(p, s, index);
    const t2v = isT2V(p, index);
    return {
      key,
      input: {
        projectId: p.id,
        shotId: s.id,
        shotIndex: index,
        attempt: s.renderCount + 1,
        sampleId: p.sample,
        kind: t2v ? ("t2v" as const) : ("i2v" as const),
        imagePath: t2v ? undefined : imagePath,
        imageMime: t2v ? undefined : p.image?.mime,
        mode: p.mode,
        prompt: resolvePrompt(p, s, index),
        camera: resolveCamera(p, s),
        durationSec: s.duration,
        ...sizeDims(p.size),
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
  await continueFromFrame(p, ctx);
  maybeStitch(p);
}

/**
 * Text-only project: once shot 1 is done, take its last frame as the
 * reference still, then submit shots 2+ against it. If they can't be
 * submitted (demo replay limits, daily cap), they show as failed with why.
 */
async function continueFromFrame(p: Project, ctx: RunContext) {
  const s0 = p.shots[0];
  if (!p.scene || !s0 || !isFresh(p, s0, 0) || p.frameOf === s0.render!.key) return;
  const storage = getStorage();
  const file = `frame-${s0.render!.key}.jpg`;
  try {
    const out = await scratchFile("frame.jpg");
    await extractLastFrame(await storage.localPath(projectKey(p.id, s0.render!.clip!)), out);
    await storage.put(projectKey(p.id, file), { path: out }, "image/jpeg");
  } catch (err) {
    s0.render = { ...s0.render!, state: "failed", failReason: "Render failed", error: `frame extraction: ${String(err)}` };
    return;
  }
  p.image = { file, name: "Shot 1 last frame", mime: "image/jpeg" };
  p.frameOf = s0.render!.key;
  try {
    await submitStale(p, ctx);
  } catch (err) {
    const reason = err instanceof DemoLimitError ? "Daily render limit reached" : err instanceof Error ? err.message : "Render failed";
    p.shots.forEach((s, i) => {
      if (i === 0 || isFresh(p, s, i) || isInFlight(p, s, i)) return;
      s.render = {
        jobId: "", runner: ctx.runner.name, key: renderKey(p, s, i), mode: p.mode, sentPrompt: resolvePrompt(p, s, i),
        state: "failed", progress: 0, failReason: reason, error: redact(String(err), ctx.userKey), submittedAt: Date.now(),
      };
    });
  }
}

const g = globalThis as unknown as { __shotlistStitches?: Map<string, Promise<void>> };
const stitching = (g.__shotlistStitches ??= new Map());

/** Stitch only when every shot is current; a failed shot blocks it until fixed. */
function maybeStitch(p: Project) {
  if (p.shots.length === 0 || !p.shots.every((s, i) => isFresh(p, s, i))) return;
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
      const duration = await stitchClips(clips, out, sizeDims(p.size));
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
