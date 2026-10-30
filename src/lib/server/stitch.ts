import "server-only";
import { promises as fs } from "node:fs";
import { CROSSFADE_SECONDS } from "../moves";
import { ENCODE_ARGS, VIDEO, probeDuration, runFfmpeg } from "./ffmpeg";

/**
 * Concatenate clips with CROSSFADE_SECONDS crossfades into one MP4.
 * Offsets are computed from each clip's real duration so the chain never drifts.
 */
export async function stitchClips(
  clips: string[],
  outFile: string,
  size: { width: number; height: number } = VIDEO,
): Promise<number> {
  if (clips.length === 0) throw new Error("nothing to stitch");
  const part = `${outFile}.part.mp4`;
  const durations = await Promise.all(clips.map(probeDuration));

  if (clips.length === 1) {
    await fs.copyFile(clips[0], part);
  } else {
    const xf = CROSSFADE_SECONDS;
    const norm = clips
      .map((_, i) => `[${i}:v]fps=${VIDEO.fps},scale=${size.width}:${size.height},setsar=1,format=yuv420p,settb=AVTB[c${i}]`)
      .join(";");
    const chain: string[] = [];
    let prev = "c0";
    let offset = 0;
    for (let i = 1; i < clips.length; i++) {
      offset += durations[i - 1] - xf;
      const label = i === clips.length - 1 ? "v" : `x${i}`;
      chain.push(`[${prev}][c${i}]xfade=transition=fade:duration=${xf}:offset=${offset.toFixed(3)}[${label}]`);
      prev = label;
    }
    await runFfmpeg([
      ...clips.flatMap((c) => ["-i", c]),
      "-filter_complex", `${norm};${chain.join(";")}`,
      "-map", "[v]", ...ENCODE_ARGS, part,
    ], { timeoutMs: 300_000 });
  }
  await fs.rename(part, outFile);
  return probeDuration(outFile);
}
