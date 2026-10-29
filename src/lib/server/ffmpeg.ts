import "server-only";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

/** Path to the bundled ffmpeg binary (ffmpeg-static, never the system one). */
export function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string | null;
  if (!p) throw new Error("ffmpeg-static has no binary for this platform");
  return p;
}

export async function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const bin = ffmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-nostdin", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with ${code ?? signal}: ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

/** Duration in seconds, parsed from `ffmpeg -i` (ffmpeg-static ships no ffprobe). */
export async function probeDuration(file: string): Promise<number> {
  const bin = ffmpegPath();
  const out = await new Promise<string>((resolve) => {
    const child = spawn(bin, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let s = "";
    child.stderr.on("data", (d: Buffer) => (s += d.toString()));
    child.on("close", () => resolve(s));
    child.on("error", () => resolve(s));
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`could not read duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Shared encode settings so every clip can be xfaded without re-timing. */
export const VIDEO = { width: 1280, height: 720, fps: 24 } as const;
export const ENCODE_ARGS = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-pix_fmt", "yuv420p", "-r", String(VIDEO.fps), "-movflags", "+faststart", "-an",
];
