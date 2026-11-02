// Camera moves: shared by the editor UI, the mock renderer and the
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

/** What a runner gets for camera control. Never carries prompt text. */
export type CameraParams = { kind: "preset"; move: MoveId };

/** The planner's note for a move when no vibe plan has set one. */
export function defaultShotNote(move: MoveId): string {
  return `${MOVES[move].cameraPrompt}, cinematic lighting, consistent with the reference image.`;
}

/**
 * The planner's prompt for a shot: the vibe planner's note, or the move's
 * default. Every shot starts with this text and follows the move until the
 * user edits it; from then on their text is sent as typed.
 */
export function planPrompt(move: MoveId, shotNote = ""): string {
  return shotNote || defaultShotNote(move);
}
