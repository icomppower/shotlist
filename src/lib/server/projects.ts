import "server-only";
import { DEFAULT_DURATION, MAX_DURATION, MIN_DURATION, isMoveId, planPrompt, type MoveId } from "../moves";
import type { Project, Shot } from "../types";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findSample, findSceneSample } from "../samples";
import { getStorage, newId, projectKey, writeProject } from "./storage";

/** First-run sequence: Generate works the moment an image is dropped. */
export const STARTER_MOVES: MoveId[] = ["slow_push_in", "bullet_orbit", "crash_zoom", "crane_reveal"];
export const MAX_SHOTS = 12;
const SHOT_ID_RE = /^[a-z0-9]{4,16}$/;

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function newShot(move: MoveId = "slow_push_in"): Shot {
  return {
    id: newId(4),
    move,
    duration: DEFAULT_DURATION,
    shotNote: "",
    prompt: planPrompt(move),
    take: 0,
    renderCount: 0,
  };
}

export const MAX_SCENE_CHARS = 2000;

/**
 * Start a project from an upload, a bundled sample image (`sampleId`), or a
 * scene description (`scene`, text only: shot 1 becomes text-to-video).
 * The scene text is stored exactly as typed.
 */
export async function createProject(source: File | { sampleId: string } | { scene: string }): Promise<Project> {
  const id = newId(6);
  let image: Project["image"];
  let sample: string | undefined;
  let scene: string | undefined;
  if (source instanceof File) {
    const ext = IMAGE_TYPES[source.type];
    if (!ext) throw new HttpError(415, "Upload a JPEG, PNG or WebP image.");
    if (source.size > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is larger than 20 MB.");
    image = { file: `source.${ext}`, name: source.name.slice(0, 200) || "image", mime: source.type };
    await getStorage().put(projectKey(id, image.file), Buffer.from(await source.arrayBuffer()), source.type);
  } else if ("scene" in source) {
    if (!source.scene.trim()) throw new HttpError(400, "Describe a scene.");
    if (source.scene.length > MAX_SCENE_CHARS) throw new HttpError(413, "Scene description is too long.");
    scene = source.scene;
    sample = findSceneSample(scene)?.id; // the bundled sample scene can be replayed in demo mode
  } else {
    const found = findSample(source.sampleId);
    if (!found?.image) throw new HttpError(404, "Unknown sample.");
    const ext = path.extname(found.image).slice(1);
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    image = { file: `source.${ext}`, name: found.label, mime };
    const bytes = await fs.readFile(path.join(process.cwd(), "public", found.image));
    await getStorage().put(projectKey(id, image.file), bytes, mime);
    sample = found.id;
  }
  const now = Date.now();
  const project: Project = {
    id,
    createdAt: now,
    updatedAt: now,
    image,
    scene,
    sample,
    shots: STARTER_MOVES.map(newShot),
    creditsUsed: 0,
  };
  await writeProject(project);
  return project;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (v: unknown, max: number, fallback: string) => (typeof v === "string" ? v.slice(0, max) : fallback);

/**
 * Apply an editor update. `shots` is the full ordered list; unknown ids are
 * new shots, missing ids are deleted. Prompt text is stored exactly as sent.
 * A prompt that still equals the planner's text follows a move change; an
 * edited prompt is never touched.
 */
export function applyUpdate(p: Project, body: unknown) {
  const b = (body && typeof body === "object" ? body : {}) as { shots?: unknown };
  if (!Array.isArray(b.shots)) return;
  const byId = new Map(p.shots.map((s) => [s.id, s]));
  p.shots = b.shots.slice(0, MAX_SHOTS).map((raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const known = typeof r.id === "string" ? byId.get(r.id) : undefined;
    const prev = known ?? { ...newShot(), id: typeof r.id === "string" && SHOT_ID_RE.test(r.id) ? r.id : newId(4) };
    const move = isMoveId(r.move) ? r.move : prev.move;
    const shotNote = str(r.shotNote, 1000, prev.shotNote ?? "");
    let prompt = str(r.prompt, 4000, prev.prompt);
    const seeded = prev.prompt === "" || prev.prompt === planPrompt(prev.move, prev.shotNote);
    if (prompt === prev.prompt && seeded) prompt = planPrompt(move, shotNote);
    return {
      ...prev,
      move,
      duration: Math.round(clamp(r.duration, MIN_DURATION, MAX_DURATION, prev.duration)),
      shotNote,
      prompt,
    };
  });
}
