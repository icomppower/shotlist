# Shotlist

**Turn one still image into a directed, multi-shot video.** Upload an image, build a
shot list of camera moves, hit Generate. Each shot becomes a clip, and the clips
are joined with 0.5s crossfades into one MP4.

Shotlist is an open-source rebuild of the idea behind Higgsfield's Cinema Studio
(it has its own name and look, and contains no Higgsfield code, branding or assets). It
runs on the [Comfy Developer Platform](https://docs.comfy.org) and uses
**LTX 2.5** as its core image-to-video model.

> **Design principle: the video model is the only judge — Direct mode sends your words as written.**
> Shotlist never rewrites, filters or pads your prompt. If LTX refuses a shot,
> you see that LTX refused it, and you decide what to change.

> **Status:** everything works end to end with the **mock runner**, which fakes
> each shot locally with ffmpeg. The `ComfyRunner` (real LTX renders) is written
> but **untested**: it was built without an API key and has never been run
> against the live Comfy API.

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
5. **If a shot fails**, its tile says why (for example *Refused by LTX* or
   *Render failed*) and **Edit & retry** re-renders only that shot. Nothing is
   stitched while any shot is failed, so no shot is ever skipped silently.

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
in the job JSON (`mock-jobs/<jobId>.json` or `comfy-jobs/<jobId>.json` →
`input.prompt`).

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

To check the whole flow from the command line:

```bash
npm run e2e:mock
```

This builds the app and starts its own server on port 3199, with a throwaway
data directory, `MOCK_FAIL_SHOT=2` and `DAILY_SHOT_CAP=10`. It then checks that:

- the upload pre-fills 4 shots
- shot 2 is refused and nothing is stitched until it is fixed
- **Edit & retry** re-renders only shot 2
- the stitched MP4 is 14.5s long (4×4s with three 0.5s crossfades)
- swapping one move re-renders only that shot
- reordering only re-stitches
- Direct mode sends the prompt byte-for-byte
- going over the daily cap shows the demo state

### What the mock does

`MockRunner` doesn't call any network service or GPU. For each shot it:

- animates the uploaded still with the chosen move, using ffmpeg zoom, pan,
  rotate and motion-blur filters (`src/lib/server/motion.ts`)
- waits a random 3–8s and reports progress over that time, so the UI behaves
  like a real queue
- reports made-up credits (2 per second of video) so the credits counter has
  something to show

With `MOCK_FAIL_SHOT=<n>`, the first render of shot *n* (counting from 1) comes
back as *Refused by LTX*, so you can try the failure and retry path.

## Run it with Comfy on your own machine

> Untested: the runner follows the [Comfy Cloud API docs](https://docs.comfy.org/development/cloud/api-reference),
> but it has never been run against the live API.

1. **Get an API key** at [platform.comfy.org](https://platform.comfy.org). Create
   it in the workspace whose credits you want to spend (keys belong to a
   workspace). Comfy says API access needs a paid plan.
2. **Import the workflow.** In ComfyUI, open `workflows/shotlist.json`, choose your
   LTX 2.5 checkpoint and text encoder, and check that one render works. Then use
   *Export (API)* to save it over `workflows/shotlist.json`. If the node ids
   changed, update `workflows/shotlist.map.json` (see `workflows/README.md`).
3. **Configure and run:**

   ```bash
   # .env.local
   RUNNER=comfy
   COMFY_API_KEY=<your key>
   ```

   then `npm run dev`.

What the `ComfyRunner` does for each shot (`src/lib/runners/comfy.ts`):

- uploads the image to `POST /api/upload/image`
- injects the image, prompt, frame count (8n+1), fps, size, seed and any
  mapped camera inputs into the nodes listed in `shotlist.map.json`
- submits the workflow to `POST /api/prompt` with the `X-API-Key` header
- polls `GET /api/job/{id}/status`, then finds the clip in `GET /api/jobs/{id}`
- downloads the clip from `GET /api/view`, following the signed-URL redirect
  without sending the key
- reads `X-Comfy-Credits-Used` when the API sends it

At most 3 jobs run at once; the rest wait in a queue. Moderation or refusal
errors become **Refused by LTX** on the shot. A bad key, missing credits or a
rate limit each get their own one-line reason.

If `RUNNER=comfy` is set without `COMFY_API_KEY`, the app shows the demo
sample instead of trying to render.

The workflow template has no camera-control node yet, so with Comfy the preset
moves only steer the image through Director-mode prompt text. To get real
camera control, map `camera.move` to a camera LoRA as shown in
`workflows/README.md`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `RUNNER` | `mock` | `mock` or `comfy` |
| `COMFY_API_KEY` | — | Needed for `RUNNER=comfy` |
| `STORAGE` | `local` | `local` (files on disk) or `blob` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | — | Needed for `STORAGE=blob` |
| `DAILY_SHOT_CAP` | `60` | Renders allowed per UTC day across all users. Counted in storage |
| `SHOTLIST_DATA_DIR` | `./.data` (`/tmp/shotlist` on Vercel) | Root folder for `STORAGE=local` |
| `MOCK_FAIL_SHOT` | — | Mock only: refuse the first render of this shot number |

There is no settings page; the app uses sensible defaults: 1280×720, 24 fps,
H.264, 0.5s crossfades.

### Live-link protection

Two cases block rendering: the day's renders reach `DAILY_SHOT_CAP`, or
`RUNNER=comfy` has no key. When either happens and there is something left to
render, the player shows *Demo limit reached — here's a sample* and plays
`public/sample-trailer.mp4`. A cut the user already finished stays on screen.
The current sample is a placeholder made with the mock; replace it with a real
LTX render.

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
      mock.ts               MockRunner (+ MOCK_FAIL_SHOT)
      comfy.ts              ComfyRunner (Comfy Cloud API, untested)
    server/
      storage/              StorageDriver: LocalStorage, BlobStorage (STORAGE=local|blob)
      pipeline.ts           render keys, submit stale shots, poll → collect clips → stitch
      limits.ts             DAILY_SHOT_CAP counter and demo state
      stitch.ts             xfade chain (0.5s crossfades)
      motion.ts             mock camera moves as ffmpeg filter graphs
      ffmpeg.ts             ffmpeg-static wrapper
workflows/                  shotlist.json (API-format LTX graph) + shotlist.map.json (node mapping)
public/sample-trailer.mp4   demo-state sample (placeholder)
```

The `JobRunner` interface is built for polling, which is how the Comfy
Developer Platform works:

```ts
interface JobRunner {
  submitShot(input: ShotJobInput): Promise<{ jobId: string }>;
  getStatus(jobId: string): Promise<{ state; progress; reason?; error? }>;
  getClipUrl(jobId: string): Promise<string>;   // http(s):// or file://
  getCreditsUsed(jobId: string): Promise<number>;
}
```

`ShotJobInput.prompt` is final. A runner must pass it through unchanged and use
`ShotJobInput.camera` only for camera control. No background worker is needed:
each poll of a project (`GET /api/projects/:id`) moves its jobs forward, downloads
finished clips and starts the stitch once every shot is current.

All state goes through the `StorageDriver`: projects, media, job records, the
Comfy queue and the daily counter.

- **`LocalStorage`** writes files under `SHOTLIST_DATA_DIR`. It is what the tests use.
- **`BlobStorage`** uses a private Vercel Blob store and streams media back through
  the app with Range support. It is implemented but not covered by the tests.
- **Locking** happens in-process. With Blob storage on several serverless
  instances, locking is best-effort rather than a distributed lock.

## Deploying to Vercel

The project builds as a standard Next.js app. The ffmpeg binary and the
workflow JSON are traced into the serverless functions. For a hosted deploy:

- **Use shared storage.** Set `STORAGE=blob` and connect a Blob store, which
  provides `BLOB_READ_WRITE_TOKEN`. Local `/tmp` is per-instance, so projects
  would get lost between requests.
- **Keep the cap on.** `DAILY_SHOT_CAP` protects the public link.
- **Mind the upload size.** Vercel limits request bodies to about 4.5 MB, so
  keep uploads under that.

## Tools used

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and the [Comfy Developer Platform](https://docs.comfy.org) (Comfy Cloud API): the render backend
- [LTX 2.5](https://www.lightricks.com/ltxv): the image-to-video model
- [Next.js](https://nextjs.org) (App Router, TypeScript): the app
- [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static): mock renders and crossfade stitching
- [Vercel](https://vercel.com): hosting
- [Vercel Blob](https://vercel.com/docs/vercel-blob): shared storage for hosted deploys

## Roadmap

- [x] 1. App shell and shot list editor
- [x] 2. `JobRunner` interface and `MockRunner` (`RUNNER=mock|comfy`)
- [x] 3. Stitching with 0.5s crossfades, output view, per-shot regenerate
- [x] Polish: shot failures with Edit & retry, storage drivers, daily cap and demo sample
- [ ] 4. Verify the `ComfyRunner` and `workflows/shotlist.json` with real LTX 2.5 renders (written, untested)

## License

[MIT](./LICENSE)
