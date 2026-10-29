// Director moves: shared by the editor UI, the mock renderer and (later) the
// Comfy/LTX prompt builder. Keep ids stable — they are persisted in projects.

export const MOVE_IDS = [
  "crash_zoom",
  "dolly_zoom",
  "bullet_orbit",
  "fpv_dive",
  "crane_reveal",
  "whip_pan",
  "slow_push_in",
] as const;

export type MoveId = (typeof MOVE_IDS)[number];

export interface MoveDef {
  id: MoveId;
  label: string;
  /** One-line description shown in the editor. */
  blurb: string;
  /** Camera instruction appended to the LTX prompt by the Comfy runner. */
  cameraPrompt: string;
}

export const MOVES: Record<MoveId, MoveDef> = {
  crash_zoom: {
    id: "crash_zoom",
    label: "Crash zoom",
    blurb: "Beat, then a violent snap zoom onto the subject.",
    cameraPrompt: "sudden aggressive crash zoom into the subject, fast snap zoom with slight camera shake",
  },
  dolly_zoom: {
    id: "dolly_zoom",
    label: "Dolly zoom",
    blurb: "Vertigo: subject holds while the world stretches away.",
    cameraPrompt: "dolly zoom vertigo effect, camera dollies in while zooming out, background warps and stretches",
  },
  bullet_orbit: {
    id: "bullet_orbit",
    label: "Bullet-time orbit",
    blurb: "Frozen moment, camera arcs around the subject.",
    cameraPrompt: "bullet time, frozen moment, camera orbits smoothly around the subject in a half circle",
  },
  fpv_dive: {
    id: "fpv_dive",
    label: "FPV drone dive",
    blurb: "Banking, accelerating dive straight into the scene.",
    cameraPrompt: "FPV drone shot diving fast down into the scene, banking and rolling, accelerating forward",
  },
  crane_reveal: {
    id: "crane_reveal",
    label: "Crane reveal",
    blurb: "Rises up and pulls back to unveil the whole frame.",
    cameraPrompt: "crane shot rising up and pulling back to reveal the full scene, smooth and majestic",
  },
  whip_pan: {
    id: "whip_pan",
    label: "Whip pan",
    blurb: "Settled frame, then a blurred whip to a new angle.",
    cameraPrompt: "fast whip pan to the side with heavy motion blur, then settles on the new framing",
  },
  slow_push_in: {
    id: "slow_push_in",
    label: "Slow push-in",
    blurb: "Patient, steady creep toward the subject.",
    cameraPrompt: "slow steady cinematic push in toward the subject, smooth dolly forward",
  },
};

export const MIN_DURATION = 3;
export const MAX_DURATION = 6;
export const DEFAULT_DURATION = 4;
export const CROSSFADE_SECONDS = 0.5;

export function isMoveId(v: unknown): v is MoveId {
  return typeof v === "string" && (MOVE_IDS as readonly string[]).includes(v);
}

// --- Modes ---------------------------------------------------------------

export const MODES = ["director", "direct", "manual"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, { label: string; hint: string }> = {
  director: { label: "Director", hint: "Pick a move per shot; the planner writes the prompt." },
  direct: { label: "Direct", hint: "You write each prompt; it is sent to LTX exactly as typed." },
  manual: { label: "Manual", hint: "Set the camera numbers yourself; your prompt is sent as typed." },
};

export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

/** Hand-set camera for Manual mode. Pan is -1..1 across the frame, roll in degrees. */
export interface ManualCamera {
  zoomStart: number;
  zoomEnd: number;
  panX: number;
  panY: number;
  roll: number;
}

export const DEFAULT_MANUAL_CAMERA: ManualCamera = { zoomStart: 1, zoomEnd: 1.3, panX: 0, panY: 0, roll: 0 };

export const MANUAL_LIMITS = {
  zoom: { min: 1, max: 3, step: 0.05 },
  pan: { min: -1, max: 1, step: 0.05 },
  roll: { min: -10, max: 10, step: 1 },
} as const;

/** What a runner gets for camera control. Never carries prompt text. */
export type CameraParams = { kind: "preset"; move: MoveId } | ({ kind: "manual" } & ManualCamera);

/**
 * Director-mode planner: a deterministic template (no LLM). Turns an optional
 * scene note + the chosen move into the prompt text.
 */
export function planPrompt(move: MoveId, note: string): string {
  const scene = note.trim().replace(/[.\s]+$/, "") || "The scene in the reference image";
  return `${scene}. ${MOVES[move].cameraPrompt}, cinematic lighting, consistent with the reference image.`;
}
