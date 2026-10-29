# Shotlist

**Turn one still image into a directed, multi-shot video.** Upload an image, build a
shot list of camera moves, hit Generate. Each shot becomes a clip, and the clips
are joined with 0.5s crossfades into one MP4.

Shotlist is an open-source rebuild of the idea behind Higgsfield's Cinema Studio
(it has its own name and look, and contains no Higgsfield code, branding or assets). It
runs on the [Comfy Developer Platform](https://docs.comfy.org) and uses
**LTX 2.5** as its core image-to-video model.

> **Status:** steps 1–3 are done. The app works end to end with the **mock runner**,
> which fakes each shot locally with ffmpeg. The real LTX renders through Comfy
> (`ComfyRunner`) are step 4 and haven't been built yet.

## What it does

1. **Drop an image.** You get four starter shots right away (slow push-in →
   bullet-time orbit → crash zoom → crane reveal), so Generate works immediately.
2. **Shot list.** Drag ⋮⋮ to reorder. Tap a shot to swap its move: each move is a
   card with a small looping preview played on your own image. Each shot is
   3–6 seconds long. Add up to 12 shots, or remove them.
3. **Generate.** A progress strip shows one tile per shot, and each tile fills
   as its shot finishes. You then get a large player, **Download MP4** and
   **Copy share link** (`/p/<id>`).
4. **Change one shot.** Pick a different move (or ↻ New take) and the button
   becomes *Update video · re-render 1 shot*. Only that shot re-renders, and the
   video is stitched again. Reordering only re-stitches; no shots re-render.

Director moves: **crash zoom, dolly zoom, bullet-time orbit, FPV drone dive,
crane reveal, whip pan, slow push-in.**

### Modes: Director | Direct | Manual

| Mode | Camera | Prompt sent to the model |
| --- | --- | --- |
| **Director** (default) | Preset move | Built by the planner: a fixed template (no LLM) that combines your optional scene note with the move's camera wording |
| **Direct** | Preset move | **Your text, byte-for-byte.** Nothing is rewritten and no style words are added. The move only sets camera parameters |
| **Manual** | Your numbers: zoom start/end, pan X/Y, roll | Your text, byte-for-byte |

When you switch from Director to Direct or Manual, each shot keeps the planner's
prompt as editable starting text. Under every rendered shot, a **Sent to LTX:**
line shows the exact string that was submitted. The same string is also logged
in the job JSON (`.data/mock-jobs/<jobId>.json` → `input.prompt`).

A render is keyed on what is actually sent (prompt, camera, duration, take,
image). Switching modes without changing that content therefore re-renders nothing.

## Run it locally (mock runner)

Requires Node 20+. ffmpeg comes from the
[`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) npm package, not
from your system, so the app behaves the same on a Mac and in the cloud.

```bash
npm install
cp .env.example .env.local   # RUNNER=mock, no API key needed
npm run dev                  # http://localhost:3000
```

To check the whole flow from the command line, start the server and run:

```bash
npm run e2e:mock             # or: npm run e2e:mock -- http://localhost:3100
```

The script uploads an image, renders the 4-shot list, and checks that the stitched
MP4 is 14.5s long (4×4s with three 0.5s crossfades). It then swaps one shot's move
and asserts that only that shot re-renders, checks that reordering only
re-stitches, and checks that Direct mode sends the prompt byte-for-byte.

### What the mock does

`MockRunner` doesn't call any network service or GPU. For each shot it:

- animates the uploaded still with the chosen move, using ffmpeg zoom, pan,
  rotate and motion-blur filters (`src/lib/server/motion.ts`)
- waits a random 3–8s and reports progress over that time, so the UI behaves
  like a real queue
- reports made-up credits (2 per second of video) so the credits counter has
  something to show

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `RUNNER` | `mock` | `mock` or `comfy`. `comfy` is a stub that throws "not implemented" |
| `COMFY_API_KEY` | — | Needed for step 4 |
| `SHOTLIST_DATA_DIR` | `./.data` (`/tmp/shotlist` on Vercel) | Where uploads, clips and stitched output are stored |

There is no settings page; the app uses sensible defaults: 1280×720, 24 fps,
H.264, 0.5s crossfades.

## Architecture

```
src/
  app/                      Next.js App Router: one screen (/ and /p/[id]) + API
    api/projects/…          create · get (advances jobs) · patch · generate · files (Range)
  components/               Studio, Monitor (drop zone / player / progress strip), ShotEditor, MovePreview
  lib/
    moves.ts                move catalog, modes, planner template, manual camera limits
    runners/
      types.ts              JobRunner interface
      mock.ts               MockRunner
      comfy.ts              ComfyRunner stub (step 4)
    server/
      pipeline.ts           render keys, submit stale shots, poll → collect clips → stitch
      stitch.ts             xfade chain (0.5s crossfades)
      motion.ts             mock camera moves as ffmpeg filter graphs
      ffmpeg.ts             ffmpeg-static wrapper
workflows/                  ComfyUI workflow JSON (shotlist.json arrives in step 4)
```

The `JobRunner` interface is built for polling, which is how the Comfy
Developer Platform works:

```ts
interface JobRunner {
  submitShot(input: ShotJobInput): Promise<{ jobId: string }>;
  getStatus(jobId: string): Promise<{ state; progress; error? }>;
  getClipUrl(jobId: string): Promise<string>;   // http(s):// or file://
  getCreditsUsed(jobId: string): Promise<number>;
}
```

`ShotJobInput.prompt` is final. A runner must pass it through unchanged and use
`ShotJobInput.camera` only for camera control. No background worker is needed:
each poll of a project (`GET /api/projects/:id`) moves its jobs forward, downloads
finished clips and starts the stitch once every shot is current.

## Deploying to Vercel

The project builds as a standard Next.js app, and the ffmpeg binary is traced
into the serverless functions. With the mock runner, however, data is stored in
per-instance `/tmp`, so a hosted deploy is only a demo. Shared storage (for
example Vercel Blob) comes with step 4. Vercel also limits request bodies to
about 4.5 MB, so keep uploads under that size there.

## Roadmap

- [x] 1. App shell and shot list editor
- [x] 2. `JobRunner` interface and `MockRunner` (`RUNNER=mock|comfy`)
- [x] 3. Stitching with 0.5s crossfades, output view, per-shot regenerate
- [ ] 4. `ComfyRunner` and `workflows/shotlist.json`: real LTX 2.5 renders on the Comfy Developer Platform

## License

[MIT](./LICENSE)
