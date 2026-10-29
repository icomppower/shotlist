import "server-only";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { after } from "next/server";
import { CROSSFADE_SECONDS, planPrompt, type CameraParams } from "../moves";
import type { Project, ProjectView, Shot } from "../types";
import { getRunner } from "../runners";
import { VIDEO } from "./ffmpeg";
import { stitchClips } from "./stitch";
import { hash, projectFile, withProject } from "./storage";

/**
 * Orchestration is poll-driven: every GET of a project advances its jobs
 * (status -> fetch clip -> stitch). No long-lived worker is needed, which is
 * what the Comfy runner on serverless will want too.
 */

/** The exact prompt a shot sends in the project's current mode. */
export function resolvePrompt(p: Project, s: Shot): string {
  return p.mode === "director" ? planPrompt(s.move, s.note) : s.prompt;
}

export function resolveCamera(p: Project, s: Shot): CameraParams {
  return p.mode === "manual" ? { kind: "manual", ...s.camera } : { kind: "preset", move: s.move };
}

/** Keyed on what is actually sent, so a mode switch that keeps the same prompt and camera re-renders nothing. */
export function renderKey(p: Project, s: Shot): string {
  return hash(
    JSON.stringify([getRunner().name, p.image.file, resolveCamera(p, s), s.duration, resolvePrompt(p, s), s.take]),
  );
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

export function toView(p: Project): ProjectView {
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
    runner: getRunner().name,
    shotsView,
    outputFresh: allFresh && p.output?.state === "done" && p.output.key === stitchKey(p),
    expectedDuration: Math.max(total, 0),
  };
}

/**
 * Submit every shot whose current settings have no done/in-flight render.
 * `force` shot ids get a new take (new seed) even if they are up to date.
 * Returns the ids that were submitted.
 */
export async function submitStale(p: Project, force: string[] = []): Promise<string[]> {
  const runner = getRunner();
  const submitted: string[] = [];
  for (const s of p.shots) {
    if (force.includes(s.id)) s.take += 1;
    const key = renderKey(p, s);
    if (s.render?.key === key && s.render.state !== "failed") continue;
    const prompt = resolvePrompt(p, s);
    const { jobId } = await runner.submitShot({
      projectId: p.id,
      shotId: s.id,
      imagePath: projectFile(p.id, p.image.file),
      imageMime: p.image.mime,
      mode: p.mode,
      prompt,
      camera: resolveCamera(p, s),
      durationSec: s.duration,
      width: VIDEO.width,
      height: VIDEO.height,
      fps: VIDEO.fps,
      seed: parseInt(key.slice(0, 8), 16),
    });
    s.render = {
      jobId, runner: runner.name, key, mode: p.mode, sentPrompt: prompt,
      state: "queued", progress: 0, submittedAt: Date.now(),
    };
    s.renderCount += 1;
    submitted.push(s.id);
  }
  return submitted;
}

async function saveClip(url: string, dest: string) {
  if (url.startsWith("file:")) {
    await fs.copyFile(fileURLToPath(url), dest);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`clip download failed: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Poll in-flight jobs, collect finished clips, and kick off stitching. */
export async function advance(p: Project): Promise<void> {
  const runner = getRunner();
  for (const s of p.shots) {
    const r = s.render;
    if (!r || (r.state !== "queued" && r.state !== "running") || r.runner !== runner.name) continue;
    try {
      const st = await runner.getStatus(r.jobId);
      r.progress = st.progress;
      if (st.state === "failed") {
        r.state = "failed";
        r.error = st.error ?? "render failed";
      } else if (st.state === "done") {
        const clip = `clip-${s.id}-${r.key}.mp4`;
        await saveClip(await runner.getClipUrl(r.jobId), projectFile(p.id, clip));
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
      r.error = err instanceof Error ? err.message : String(err);
    }
  }
  maybeStitch(p);
}

const g = globalThis as unknown as { __shotlistStitches?: Map<string, Promise<void>> };
const stitching = (g.__shotlistStitches ??= new Map());

function maybeStitch(p: Project) {
  if (p.shots.length === 0 || !p.shots.every((s) => isFresh(p, s))) return;
  const key = stitchKey(p);
  if (p.output?.key === key && p.output.state !== "stitching") return; // done or failed for this cut
  const lockKey = `${p.id}:${key}`;
  if (stitching.has(lockKey)) return;

  const clips = p.shots.map((s) => projectFile(p.id, s.render!.clip!));
  const file = `shotlist-${p.id}-${key}.mp4`;
  const previousFile = p.output?.state === "done" ? p.output.file : p.output?.file;
  p.output = { key, state: "stitching", file: previousFile, startedAt: Date.now() };

  const job = (async () => {
    let result: { duration?: number; error?: string };
    try {
      result = { duration: await stitchClips(clips, projectFile(p.id, file)) };
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
      if (old && old !== file) await fs.rm(projectFile(p.id, old), { force: true });
    });
  })().finally(() => stitching.delete(lockKey));
  stitching.set(lockKey, job);
  try {
    after(() => job);
  } catch {
    // not in a request scope
  }
}
