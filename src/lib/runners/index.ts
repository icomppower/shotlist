import "server-only";
import { ComfyRunner } from "./comfy";
import { MockRunner } from "./mock";
import type { JobRunner } from "./types";

export type { JobRunner, JobStatus, ShotJobInput } from "./types";

let runner: JobRunner | undefined;

/** Pick the runner from RUNNER=mock|comfy (default mock). */
export function getRunner(): JobRunner {
  if (runner) return runner;
  const kind = (process.env.RUNNER ?? "mock").trim().toLowerCase();
  switch (kind) {
    case "mock":
      runner = new MockRunner();
      break;
    case "comfy":
      runner = new ComfyRunner();
      break;
    default:
      throw new Error(`Unknown RUNNER "${kind}" (expected mock or comfy)`);
  }
  return runner;
}
