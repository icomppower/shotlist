import "server-only";
import {
  DEFAULT_DURATION, DEFAULT_MANUAL_CAMERA, MANUAL_LIMITS, MAX_DURATION, MIN_DURATION,
  isMode, isMoveId, planPrompt, type ManualCamera, type MoveId,
} from "../moves";
import type { Project, Shot } from "../types";
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
    camera: { ...DEFAULT_MANUAL_CAMERA },
    duration: DEFAULT_DURATION,
    note: "",
    prompt: "",
    promptSeeded: false,
    take: 0,
    renderCount: 0,
  };
}

export async function createProject(image: File): Promise<Project> {
  const ext = IMAGE_TYPES[image.type];
  if (!ext) throw new HttpError(415, "Upload a JPEG, PNG or WebP image.");
  if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is larger than 20 MB.");
  const id = newId(6);
  const file = `source.${ext}`;
  await getStorage().put(projectKey(id, file), Buffer.from(await image.arrayBuffer()), image.type);
  const now = Date.now();
  const project: Project = {
    id,
    createdAt: now,
    updatedAt: now,
    mode: "director",
    image: { file, name: image.name.slice(0, 200) || "image", mime: image.type },
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

function readCamera(v: unknown, prev: ManualCamera): ManualCamera {
  const c = (v && typeof v === "object" ? v : {}) as Partial<ManualCamera>;
  const { zoom, pan, roll } = MANUAL_LIMITS;
  return {
    zoomStart: clamp(c.zoomStart, zoom.min, zoom.max, prev.zoomStart),
    zoomEnd: clamp(c.zoomEnd, zoom.min, zoom.max, prev.zoomEnd),
    panX: clamp(c.panX, pan.min, pan.max, prev.panX),
    panY: clamp(c.panY, pan.min, pan.max, prev.panY),
    roll: Math.round(clamp(c.roll, roll.min, roll.max, prev.roll)),
  };
}

const str = (v: unknown, max: number, fallback: string) => (typeof v === "string" ? v.slice(0, max) : fallback);

/**
 * Apply an editor update. `shots` is the full ordered list; unknown ids are
 * new shots, missing ids are deleted. Prompt text is stored exactly as sent.
 */
export function applyUpdate(p: Project, body: unknown) {
  const b = (body && typeof body === "object" ? body : {}) as { mode?: unknown; shots?: unknown };

  if (Array.isArray(b.shots)) {
    const byId = new Map(p.shots.map((s) => [s.id, s]));
    p.shots = b.shots.slice(0, MAX_SHOTS).map((raw) => {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const known = typeof r.id === "string" ? byId.get(r.id) : undefined;
      const prev = known ?? { ...newShot(), id: typeof r.id === "string" && SHOT_ID_RE.test(r.id) ? r.id : newId(4) };
      const prompt = str(r.prompt, 4000, prev.prompt);
      return {
        ...prev,
        move: isMoveId(r.move) ? r.move : prev.move,
        camera: r.camera === undefined ? prev.camera : readCamera(r.camera, prev.camera),
        duration: Math.round(clamp(r.duration, MIN_DURATION, MAX_DURATION, prev.duration)),
        note: str(r.note, 1000, prev.note),
        prompt,
        promptSeeded: prompt === prev.prompt ? prev.promptSeeded : false,
      };
    });
  }

  if (isMode(b.mode) && b.mode !== p.mode) {
    // Leaving Director: the planner's prompts become editable starting text,
    // without clobbering anything the user already typed.
    if (p.mode === "director") {
      for (const s of p.shots) {
        if (s.prompt === "" || s.promptSeeded) {
          s.prompt = planPrompt(s.move, s.note);
          s.promptSeeded = true;
        }
      }
    }
    p.mode = b.mode;
  }
}
