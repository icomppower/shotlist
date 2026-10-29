// Bundled samples for demo mode (RUNNER=demo), all rendered by
// scripts/make-demo-clips.mjs:
// - image samples: one pre-made image-to-video clip per move at
//   public/demo/<id>/<move>.mp4, prompt planPrompt(move, "").
// - scene samples (text only): public/demo/<id>/t2v.mp4 is shot 1 (text-to-
//   video of `scene`, DEMO_T2V_MOVE at DEMO_T2V_SECONDS), and <move>.mp4 are
//   image-to-video clips from that clip's last frame.

import type { MoveId } from "./moves";

export interface Sample {
  id: string;
  label: string;
  /** Image sample: public URL of the source still. */
  image?: string;
  /** Scene sample: the exact scene text. */
  scene?: string;
}

export const SAMPLES: Sample[] = [
  { id: "dusk-ridge", label: "Dusk ridge", image: "/demo/dusk-ridge/image.jpg" },
  {
    id: "harbor-light",
    label: "Harbor light",
    scene: "A lone lighthouse on a rocky cliff at dusk, waves breaking below, a warm light turning in the lamp room.",
  },
];

/** Length of every pre-made image-to-video clip; shots trim it to 3–6 s. */
export const DEMO_CLIP_SECONDS = 6;
/** Shot 1 of a scene sample: the starter shot. */
export const DEMO_T2V_MOVE: MoveId = "slow_push_in";
export const DEMO_T2V_SECONDS = 4;

export const imageSamples = () => SAMPLES.filter((s) => s.image);
export const findSceneSample = (scene: string) => SAMPLES.find((s) => s.scene === scene);

export const findSample = (id: unknown) => SAMPLES.find((s) => s.id === id);
