# workflows/

ComfyUI workflow definitions used by the `ComfyRunner` live here.

- `shotlist.json` — **coming in step 4.** The API-format ComfyUI graph that turns
  one source image + a camera-move prompt into a single LTX 2.5 image-to-video
  clip. The `ComfyRunner` will load it, patch the input nodes (image, prompt,
  duration/frame count, seed) and submit it to the Comfy Developer Platform
  (https://docs.comfy.org).

Until then the app runs with `RUNNER=mock`, which fakes each shot locally with
ffmpeg and never touches this folder.
