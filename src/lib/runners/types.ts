import type { CameraParams, Mode } from "../moves";

/** Everything a runner needs to render one shot into one clip. */
export interface ShotJobInput {
  projectId: string;
  shotId: string;
  /** 0-based position in the shot list. */
  shotIndex: number;
  /** 1 for the shot's first render, 2 for the next, … */
  attempt: number;
  /** Set when the project uses a bundled sample image (demo mode). */
  sampleId?: string;
  /**
   * "t2v": shot 1 of a text-only project, rendered from the prompt alone.
   * "i2v": image-to-video from `imagePath` (an upload, or shot 1's last frame).
   */
  kind: "i2v" | "t2v";
  /** Absolute path of the reference image on this server (i2v only). */
  imagePath?: string;
  imageMime?: string;
  mode: Mode;
  /**
   * The prompt to send, final and exact. Runners MUST pass it through
   * byte-for-byte: no rewriting, no added style or camera words.
   */
  prompt: string;
  /** Camera control only — never used to alter `prompt`. */
  camera: CameraParams;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  seed: number;
}

export type JobState = "queued" | "running" | "done" | "failed";

export interface JobStatus {
  state: JobState;
  /** 0..1 */
  progress: number;
  /** Short user-facing reason when failed, e.g. "Refused by LTX". */
  reason?: string;
  error?: string;
}

/**
 * A backend that renders shots. Designed for poll-based backends (the Comfy
 * Developer Platform): submit returns immediately, the app polls status, then
 * fetches the clip. Implementations must be safe to call from any request.
 */
export interface JobRunner {
  readonly name: string;
  /** Optional pre-flight: a user-facing reason this shot can't be rendered here, or null. */
  check?(input: ShotJobInput): string | null;
  submitShot(input: ShotJobInput): Promise<{ jobId: string }>;
  getStatus(jobId: string): Promise<JobStatus>;
  /**
   * Where to fetch the finished clip: an http(s) URL or a file:// URL on this
   * server. Only valid once getStatus() reports "done".
   */
  getClipUrl(jobId: string): Promise<string>;
  /** Credits charged for this job (0 until known). */
  getCreditsUsed(jobId: string): Promise<number>;
}
