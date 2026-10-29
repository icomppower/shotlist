// Bundled sample images for demo mode (RUNNER=demo). Each has one pre-made
// clip per move at public/demo/<id>/<move>.mp4, rendered by
// scripts/make-demo-clips.mjs with the Director prompt planPrompt(move, "").

export interface Sample {
  id: string;
  label: string;
  /** Public URL of the source still. */
  image: string;
}

export const SAMPLES: Sample[] = [{ id: "dusk-ridge", label: "Dusk ridge", image: "/demo/dusk-ridge/image.jpg" }];

/** Length of every pre-made clip; shots trim it to 3–6 s. */
export const DEMO_CLIP_SECONDS = 6;

export const findSample = (id: unknown) => SAMPLES.find((s) => s.id === id);
