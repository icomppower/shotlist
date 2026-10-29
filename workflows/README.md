# workflows/

The ComfyUI graph the `ComfyRunner` sends to the Comfy Cloud API, one job per shot.

- `shotlist.json` is an **API-format** LTX image-to-video graph. It's a template:
  load it in ComfyUI, choose your LTX 2.5 checkpoint and text encoder, check that
  it runs, then export it again with *Export (API)* over this file.
- `shotlist-t2v.json` + `shotlist-t2v.map.json` is the **text-to-video** graph for
  shot 1 of a text-only project (a scene description, no image). The scene text
  goes into the prompt node exactly as typed. Shots 2+ then use `shotlist.json`
  with shot 1's last frame as the image. Treat it like `shotlist.json`: a
  template to load, fix and re-export.
- `shotlist.map.json` lists the node inputs Shotlist fills for each shot: the
  image, the prompt (inserted byte-for-byte), the frame count (8n+1), fps, size,
  seed and, if you map it, the camera move. If re-exporting renumbers the nodes,
  update the node ids here.

The template has no camera-control node yet. To make the preset moves drive LTX
camera motion, add one (for example a camera LoRA loader) and map `camera.move` to it:

```json
{ "from": "camera.move", "node": "12", "input": "lora_name",
  "lookup": { "slow_push_in": "<your dolly-in LoRA>.safetensors" } },
{ "from": "camera.move", "node": "12", "input": "strength_model",
  "lookup": { "slow_push_in": 1 }, "default": 0 }
```

None of this is used with `RUNNER=mock`.
