import "server-only";
import { ComfyRunner } from "./comfy";
import { DemoRunner } from "./demo";
import { MockRunner } from "./mock";
import type { JobRunner } from "./types";

export type { JobRunner, JobStatus, ShotJobInput } from "./types";

export type RunnerMode = "mock" | "comfy" | "demo";

/**
 * Server-wide mode from RUNNER=mock|comfy|demo. Defaults to demo on Vercel
 * (the public link never holds a key) and mock everywhere else.
 */
export function runnerMode(): RunnerMode {
  const kind = (process.env.RUNNER || (process.env.VERCEL ? "demo" : "mock")).trim().toLowerCase();
  if (kind === "mock" || kind === "comfy" || kind === "demo") return kind;
  throw new Error(`Unknown RUNNER "${kind}" (expected mock, comfy or demo)`);
}

const mock = new MockRunner();
const demo = new DemoRunner();

/**
 * Who renders for this request. A visitor's own key (bring-your-own-key)
 * always means Comfy on their credits; it lives only in this request.
 */
export interface RunContext {
  runner: JobRunner;
  /** The visitor's key, if they sent one. Never stored or logged. */
  userKey?: string;
  /** True when renders cost the server (counted against DAILY_SHOT_CAP). */
  billedToServer: boolean;
}

export function runContext(userKey?: string): RunContext {
  const key = userKey?.trim() || undefined;
  if (key) return { runner: new ComfyRunner(key), userKey: key, billedToServer: false };
  switch (runnerMode()) {
    case "demo":
      return { runner: demo, billedToServer: false };
    case "comfy":
      return { runner: new ComfyRunner(process.env.COMFY_API_KEY ?? ""), billedToServer: true };
    default:
      return { runner: mock, billedToServer: true };
  }
}

/** Runner to poll an existing job with; null when it needs a key this request doesn't have. */
export function runnerFor(name: string, ctx: RunContext): JobRunner | null {
  if (name === "mock") return mock;
  if (name === "demo") return demo;
  if (name === "comfy") {
    const key = ctx.userKey ?? process.env.COMFY_API_KEY;
    return key ? new ComfyRunner(key) : null;
  }
  return null;
}

/** Read the visitor's key from a request header (sent per request, never persisted). */
export function userKeyFrom(req: Request): string | undefined {
  const k = req.headers.get("x-comfy-key")?.trim();
  return k && k.length <= 512 ? k : undefined;
}

/** Remove a secret from text before it is stored, shown or logged. */
export function redact(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
