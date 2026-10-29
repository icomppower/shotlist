import "server-only";
import type { CameraParams, ManualCamera, MoveId } from "../moves";
import { VIDEO } from "./ffmpeg";

/**
 * Builds an ffmpeg filter_complex that fakes a camera move on a still image.
 * Used only by the MockRunner — the real look comes from LTX in step 4.
 *
 * Each move is a zoom/pan curve for `zoompan` (evaluated per frame) plus optional roll (`rotate`), motion blur
 * (`tmix`) or a two-layer vertigo composite for the dolly zoom. In curve
 * expressions `{p}` is progress 0..1 and `{s}` its smoothstep.
 */

const SRC_W = VIDEO.width * 2;
const SRC_H = VIDEO.height * 2;
// Oversized canvas for moves that roll, so rotated corners stay off-screen.
const ROLL_W = Math.round(VIDEO.width * 1.35);
const ROLL_H = Math.round(VIDEO.height * 1.35);

interface Curve {
  z: string;
  cx?: string;
  cy?: string;
}

function zoompan(c: Curve, frames: number, w: number, h: number): string {
  const P = `(in/${Math.max(frames - 1, 1)})`;
  const sub = (e: string) => e.replaceAll("{s}", `(${P}*${P}*(3-2*${P}))`).replaceAll("{p}", P);
  const z = sub(c.z);
  const cx = sub(c.cx ?? "0.5");
  const cy = sub(c.cy ?? "0.5");
  return (
    `zoompan=z='max(1,${z})'` +
    `:x='clip((${cx})*iw-iw/zoom/2,0,iw-iw/zoom)'` +
    `:y='clip((${cy})*ih-ih/zoom/2,0,ih-ih/zoom)'` +
    `:d=1:s=${w}x${h}:fps=${VIDEO.fps}`
  );
}

/** Roll angle expression over time t for `rotate`, then crop back to output size. */
function roll(angle: (pt: string) => string, duration: number): string {
  const pt = `(t/${duration})`;
  return `rotate=a='${angle(pt)}':ow=${ROLL_W}:oh=${ROLL_H}:c=black,crop=${VIDEO.width}:${VIDEO.height}`;
}

const prep = `[0:v]scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,crop=${SRC_W}:${SRC_H},setsar=1`;
const out = `format=yuv420p[v]`;

export function buildMotionFilter(camera: CameraParams, duration: number): string {
  return camera.kind === "manual" ? manualFilter(camera, duration) : presetFilter(camera.move, duration);
}

function manualFilter(c: ManualCamera, duration: number): string {
  const frames = Math.round(duration * VIDEO.fps);
  const curve = {
    z: `${c.zoomStart}+${c.zoomEnd - c.zoomStart}*{s}`,
    cx: `0.5+${0.5 * c.panX}*{s}`,
    cy: `0.5+${0.5 * c.panY}*{s}`,
  };
  if (c.roll === 0) return `${prep},${zoompan(curve, frames, VIDEO.width, VIDEO.height)},${out}`;
  const rad = (c.roll * Math.PI) / 180;
  return (
    `${prep},${zoompan(curve, frames, ROLL_W, ROLL_H)},` +
    `${roll((p) => `${rad.toFixed(4)}*(${p}*${p}*(3-2*${p}))`, duration)},${out}`
  );
}

function presetFilter(move: MoveId, duration: number): string {
  const frames = Math.round(duration * VIDEO.fps);
  const W = VIDEO.width;
  const H = VIDEO.height;

  switch (move) {
    case "slow_push_in":
      return `${prep},${zoompan({ z: "1+0.22*{s}" }, frames, W, H)},${out}`;

    case "crash_zoom": {
      // Hold ~30%, then a 0.12-long ease-out snap to 2.5x with a decaying shake.
      const e = "clip(({p}-0.3)/0.12,0,1)";
      const E = `(1-pow(1-${e},3))`;
      const shake = `(0.007*${E}*max(0,1-({p}-0.42)*2.5))`;
      return (
        `${prep},${zoompan(
          { z: `1+0.04*{p}+1.5*${E}`, cx: `0.5+${shake}*sin(in*2.1)`, cy: `0.48+${shake}*cos(in*2.7)` },
          frames, W, H,
        )},tmix=frames=3,${out}`
      );
    }

    case "dolly_zoom": {
      // Vertigo: the centre (subject) holds its size while the surround
      // zooms from tight to wide, blended through a soft radial mask.
      const mask =
        `color=c=black:s=${W}x${H}:r=${VIDEO.fps}:d=1,format=gray,` +
        `geq=lum='255*clip((1-hypot((X-W/2)/W,(Y-H/2)/H)/0.38)*2.2,0,1)',` +
        `trim=end_frame=1,loop=loop=-1:size=1[m]`;
      return (
        `${prep},split[a][b];` +
        `[a]${zoompan({ z: "1.7-0.7*{s}" }, frames, W, H)}[bg];` +
        `[b]${zoompan({ z: "1.25" }, frames, W, H)}[fg0];` +
        `${mask};[fg0][m]alphamerge[fg];` +
        `[bg][fg]overlay=format=auto:shortest=1,${out}`
      );
    }

    case "bullet_orbit":
      // Lateral arc + counter roll on a frozen frame.
      return (
        `${prep},${zoompan({ z: "1.28+0.08*{s}", cx: "0.39+0.22*{s}" }, frames, ROLL_W, ROLL_H)},` +
        `${roll((p) => `-0.09+0.18*(${p}*${p}*(3-2*${p}))`, duration)},${out}`
      );

    case "fpv_dive":
      // Accelerating push down into the frame with banking roll.
      return (
        `${prep},${zoompan({ z: "1.15+1.6*{p}*{p}", cx: "0.5+0.04*sin(2*PI*{p})", cy: "0.32+0.26*{p}" }, frames, ROLL_W, ROLL_H)},` +
        `${roll((p) => `0.10*sin(1.5*PI*${p})`, duration)},tmix=frames=2,${out}`
      );

    case "crane_reveal":
      // Start tight and low, rise and pull back to the full frame.
      return `${prep},${zoompan({ z: "1.75-0.75*{s}", cy: "0.78-0.28*{s}" }, frames, W, H)},${out}`;

    case "whip_pan": {
      // Drift, a fast blurred whip across the frame, then settle.
      const e = "clip(({p}-0.45)/0.14,0,1)";
      const S = `(${e}*${e}*(3-2*${e}))`;
      return (
        `${prep},${zoompan({ z: "1.6", cx: `0.33+0.02*{p}+0.33*${S}` }, frames, W, H)},` +
        `tmix=frames=5,${out}`
      );
    }
  }
}
