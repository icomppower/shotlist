import "server-only";
import type { JobRunner, JobStatus, ShotJobInput } from "./types";

/**
 * ComfyRunner — renders shots with LTX 2.5 on the Comfy Developer Platform
 * (https://docs.comfy.org) using workflows/shotlist.json. Step 4; not built yet.
 */
export class ComfyRunner implements JobRunner {
  readonly name = "comfy";

  constructor() {
    if (!process.env.COMFY_API_KEY) {
      console.warn("[shotlist] RUNNER=comfy but COMFY_API_KEY is empty");
    }
  }

  async submitShot(_input: ShotJobInput): Promise<{ jobId: string }> {
    throw new Error("ComfyRunner.submitShot: not implemented");
  }

  async getStatus(_jobId: string): Promise<JobStatus> {
    throw new Error("ComfyRunner.getStatus: not implemented");
  }

  async getClipUrl(_jobId: string): Promise<string> {
    throw new Error("ComfyRunner.getClipUrl: not implemented");
  }

  async getCreditsUsed(_jobId: string): Promise<number> {
    throw new Error("ComfyRunner.getCreditsUsed: not implemented");
  }
}
