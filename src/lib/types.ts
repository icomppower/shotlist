import type { ManualCamera, Mode, MoveId } from "./moves";

export type RenderState = "queued" | "running" | "done" | "failed";

export interface ShotRender {
  /** Runner job id. */
  jobId: string;
  runner: string;
  /** Render key of the shot settings this job was submitted with. */
  key: string;
  /** Mode the job was submitted in. */
  mode: Mode;
  /** The exact prompt string handed to the runner. */
  sentPrompt: string;
  state: RenderState;
  /** 0..1 */
  progress: number;
  /** Short reason shown to the user when failed, e.g. "Refused by LTX". */
  failReason?: string;
  /** Full error detail when failed. */
  error?: string;
  /** File name of the clip inside the project dir, once done. */
  clip?: string;
  credits?: number;
  submittedAt: number;
  finishedAt?: number;
}

export interface Shot {
  id: string;
  /** Preset move (Director and Direct modes). */
  move: MoveId;
  /** Hand-set camera (Manual mode). */
  camera: ManualCamera;
  /** Seconds, MIN_DURATION..MAX_DURATION. */
  duration: number;
  /** Director mode: the user's own scene note, sent verbatim ahead of the shot note. */
  note: string;
  /** Director mode: the planner's shot note (vibe planner); "" = the move's default. */
  shotNote: string;
  /** Direct/Manual mode: the prompt, sent byte-for-byte. */
  prompt: string;
  /** True while `prompt` is still the planner's untouched starting text. */
  promptSeeded: boolean;
  /** Bumped by "new take" to force a re-render with unchanged settings. */
  take: number;
  render?: ShotRender;
  /** How many times this shot has been submitted to a runner. */
  renderCount: number;
}

export interface ProjectOutput {
  /** Stitch key (hash of the ordered clips). */
  key: string;
  state: "stitching" | "done" | "failed";
  /** Latest stitched file (kept from the previous cut while re-stitching). */
  file?: string;
  duration?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Output sizes, all multiples of 32 as LTX requires; the first is the default. Smaller = fewer credits. */
export const SIZES = ["1280x704", "960x544", "768x416"] as const;
export type Size = (typeof SIZES)[number];
export const DEFAULT_SIZE: Size = SIZES[0];
export const isSize = (v: unknown): v is Size => SIZES.includes(v as Size);
export function sizeDims(size: Size | undefined): { width: number; height: number } {
  const [width, height] = (size ?? DEFAULT_SIZE).split("x").map(Number);
  return { width, height };
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: Mode;
  /**
   * Reference still for image-to-video. For a text-only project it is missing
   * until shot 1 renders, then holds shot 1's last frame.
   */
  image?: { file: string; name: string; mime: string };
  /** Text-only project: the scene, sent verbatim as shot 1's text-to-video prompt. */
  scene?: string;
  /** Text-only project: render key of the shot-1 render `image` was extracted from. */
  frameOf?: string;
  /** Bundled sample id, when the project started from one (demo mode). */
  sample?: string;
  /** Output size for every shot and the stitched video; missing = DEFAULT_SIZE. */
  size?: Size;
  shots: Shot[];
  output?: ProjectOutput;
  /** Total credits used across every submitted job. */
  creditsUsed: number;
}

/** Project as returned by the API, with derived fields for the UI. */
export interface ProjectView extends Project {
  /** Server mode: mock | comfy | demo. */
  runner: string;
  shotsView: Array<{
    id: string;
    /** Render matches the current settings and is done. */
    fresh: boolean;
    /** Has a job in flight for the current settings. */
    inFlight: boolean;
    /** Prompt that would be sent right now. */
    prompt: string;
  }>;
  /** Set when renders are blocked and the sample trailer is shown instead. */
  demo: "cap" | "no-key" | null;
  /** Output matches the current shot list and is done. */
  outputFresh: boolean;
  expectedDuration: number;
}
