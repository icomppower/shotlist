# Shotlist

**Shotlist turns one image, or one sentence, into a short cinematic trailer.**

> Live demo replays real LTX 2.5 renders. Paste your own Comfy key to render your own.

1. Drop an image or describe a scene.
2. Shotlist fills in four camera shots: push-in, orbit, crash zoom, crane reveal.
   Change any move, or type a vibe like "horror trailer" to get a different set.
3. Click Generate. Each shot renders with LTX 2.5 on Comfy Cloud, and the clips
   are stitched into one video.

Don't like one shot? Change it and only that shot re-renders.

Every shot shows exactly what was sent to LTX. Edit it and your words go through
as typed. No hidden rewriting. The video model is the only judge — what you type
is what LTX gets.

No tutorial. One screen, one model, one click.

Built with ComfyUI (Comfy Cloud API), LTX 2.5, Next.js, ffmpeg and Vercel.
MIT licensed. Independent project; not affiliated with or endorsed by Higgsfield.

**Live:** https://shotlist-one-khaki.vercel.app

## Three ways to run it

| | Who pays | What renders | Set up |
| --- | --- | --- | --- |
| **Demo mode** (the public link) | Nobody | Pre-made real LTX clips for the bundled sample image and sample scene, trimmed to each shot and stitched live | `RUNNER=demo` (the default on Vercel). No key on the server |
| **Bring your own key** (on the demo link) | The visitor | Anything: their own image, prompts and moves, via the `ComfyRunner` | The visitor pastes their key into **Comfy API key (renders on your credits)** |
| **Local `RUNNER=comfy`** | You | Anything, via the `ComfyRunner` with your key | `COMFY_API_KEY` in `.env.local` on your machine |

**Demo mode.** The live link holds no API key. The visitor picks the bundled
sample image, and Generate replays the pre-made LTX clip for each shot's move
from `public/demo/<sample>/<move>.mp4`, after a short fake delay, then stitches
them as usual. The UI shows one line: *Demo mode — real LTX renders,
pre-made.* A replay happens only when it is exact: the sample image, a preset
move, and the prompt the clip was rendered with (the planner's text for that
move). An upload or an edited prompt shows *Paste a Comfy key to render your own.*

In demo mode, the scene box comes pre-filled with the bundled sample scene, so
pressing Enter works right away. Shot 1 replays the pre-made text-to-video
clip, and the other shots replay clips that were rendered from its last frame.
That replay needs shot 1 to stay a 4s slow push-in. Any other scene needs a key.

**Bring your own key.** If the visitor fills the one optional key field, their
requests use the `ComfyRunner` with their key, billed to their credits. The key:

- is kept only in page memory. Nothing is written to localStorage, cookies or
  the URL, and a reload clears it.
- is sent only to our own server, as an `x-comfy-key` header on each request.
- is used for that request only: never written to storage or Blob, never
  logged, and scrubbed from error messages. The e2e test checks this.

Jobs on a visitor's key are only polled while their page is open and holding
the key. Renders on a visitor's key don't count against `DAILY_SHOT_CAP`.

## What it does

1. **Drop an image, or describe a scene.** You get four starter shots right away
   (slow push-in → bullet-time orbit → crash zoom → crane reveal), so Generate
   works immediately. Type a scene into **Describe a scene** and press Enter to
   start with no image (see *Text only* below).
2. **Shot list.** Type what it should feel like (e.g. *horror trailer*) and press
   Enter to get a different set of shots. Drag ⋮⋮ to reorder. Tap a shot to swap
   its move: each move is a card with a small looping preview played on your own
   image. Each shot is 3–6 seconds long. Add up to 12 shots, or remove them.
3. **Every shot shows its prompt** under **Sent to LTX:**. It starts as the
   planner's text for the move and follows the move until you edit it. Tap it to
   edit; your text is then sent byte-for-byte, and changing the move no longer
   touches it. There is no LLM and no rewriting anywhere.
4. **Generate.** A progress strip shows one tile per shot, and each tile fills as
   its shot finishes. You then get a large player, **Download MP4** and
   **Copy share link** (`/p/<id>`). Output is 1280×704, 24 fps, 0.5s crossfades.
5. **Change one shot.** Pick a different move, edit its prompt, or ↻ New take, and
   the button becomes *Update video · re-render 1 shot*. Only that shot
   re-renders, and the video is stitched again. Reordering only re-stitches.
6. **If a shot fails**, its tile says why (for example *Refused by LTX* or
   *Render failed*) and **Edit & retry** re-renders only that shot. Nothing is
   stitched while any shot is failed, so no shot is ever skipped silently.

Moves: **crash zoom, dolly zoom, bullet-time orbit, FPV drone dive, crane
reveal, whip pan, slow push-in.** Comfy Cloud has no camera LoRA for LTX 2.5,
so a move travels as the camera wording in the planner's prompt.

### Text only (no image)

With a scene and no image:

1. **Shot 1 renders text-to-video** using `workflows/shotlist-t2v.json`. The
   scene text is its prompt, sent exactly as typed, so nothing is rewritten or
   added. It also goes to the server as JSON, because
   multipart encoding would change its line breaks.
2. **Shot 1's last frame becomes the source still.** It is extracted with
   ffmpeg-static and shown on the monitor where an uploaded image would be.
3. **Shots 2+ render image-to-video from that frame,** using the existing
   workflow. They are submitted automatically once the frame exists.

Changing shot 1 changes the frame, so every later shot re-renders to match it.
Changing any other shot re-renders only that shot. If you upload an image, all
of this is skipped and the app behaves exactly as before.

The exact string that was submitted is also logged in the job JSON
(`mock-jobs/<jobId>.json` or `comfy-jobs/<jobId>.json` → `input.prompt`). A
render is keyed on what is actually sent (prompt, camera move, duration, take,
image), so saving without changing that content re-renders nothing.

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
data directory, `MOCK_FAIL_SHOT=2` and `DAILY_SHOT_CAP=11`. It then checks that:

- the upload pre-fills 4 shots
- shot 2 is refused and nothing is stitched until it is fixed
- **Edit & retry** re-renders only shot 2
- the stitched MP4 is 14.5s long (4×4s with three 0.5s crossfades)
- swapping one move re-renders only that shot, and an unedited prompt follows the move
- reordering only re-stitches
- an edited prompt is sent byte-for-byte, and a later move change leaves it alone
- going over the daily cap shows the demo state

A text-only pass then checks that:

- a scene project starts with shot 1 alone, as text-to-video with no image
- the scene arrives verbatim, including odd spacing, unicode and a newline
- shot 1's last frame becomes the served source still, and shots 2+ render
  image-to-video from it
- the cut stitches to 14.5s
- changing shot 3 re-renders only shot 3
- changing shot 1 re-renders everything from a new frame
- an uploaded image still uses image-to-video for every shot

A final pass restarts the server with `RUNNER=demo` and no server key. It
checks that:

- the sample image replays the pre-made clips into a 14.5s cut
- the sample scene replays its text-to-video shot 1, then the clips made from
  its frame
- an upload, a custom prompt or any other scene asks for a key
- bring-your-own-key text-only sends the scene to the text-to-video workflow,
  then sends shots 2+ to the image-to-video workflow
- bring-your-own-key renders through the `ComfyRunner` against a local stub of
  the Comfy API, so no real network calls are made
- prompts arrive byte-for-byte and credits are read from `X-Comfy-Credits-Used`
- a bad key fails the shot with a clear reason
- the key never appears in stored files or the server log

### What the mock does

`MockRunner` doesn't call any network service or GPU. For each shot it:

- animates the uploaded still with the chosen move, using ffmpeg zoom, pan,
  rotate and motion-blur filters (`src/lib/server/motion.ts`)
- for text-to-video, first paints a gradient still seeded from the scene text,
  then animates it the same way
- waits a random 3–8s and reports progress over that time, so the UI behaves
  like a real queue
- reports made-up credits (2 per second of video) so the credits counter has
  something to show

With `MOCK_FAIL_SHOT=<n>`, the first render of shot *n* (counting from 1) comes
back as *Refused by LTX*, so you can try the failure and retry path.

## Run it with Comfy on your own machine

1. **Get an API key** at [platform.comfy.org](https://platform.comfy.org). Create
   it in the workspace whose credits you want to spend (keys belong to a
   workspace). Comfy says API access needs a paid plan.
2. **Import the workflow.** In ComfyUI, open `workflows/shotlist.json`, choose your
   LTX 2.5 checkpoint and text encoder, and check that one render works. Then use
   *Export (API)* to save it over `workflows/shotlist.json`. If the node ids
   changed, update `workflows/shotlist.map.json` (see `workflows/README.md`).
   Do the same for `workflows/shotlist-t2v.json`, the text-to-video graph used
   for shot 1 of a text-only project.
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

### Render the demo clips (on your machine)

```bash
npm run demo:clips -- --sample=dusk-ridge --only=slow_push_in   # one shot first: check its credit cost
npm run demo:clips                                              # everything, then the sample trailer
```

This uses `COMFY_API_KEY` from `.env.local` and starts the app with
`RUNNER=comfy`. For each sample image it renders one 6s shot per move with the
planner's prompt for that move, the same prompt that demo mode replays.

For the sample scene (`harbor-light`), the script runs the text-only path:

- `t2v.mp4` is shot 1, a 4s slow push-in rendered text-to-video
- `frame.jpg` is that clip's last frame
- one clip per move is rendered from that frame

Each scene run renders shot 1 again, which changes the frame, so it keeps
only the moves rendered in that same run. The clips go to
`public/demo/<sample>/<move>.mp4`, and the credits for each clip and the total
are printed. Each clip is recorded in `public/demo/<sample>/clips.json`.

Once all seven moves are real renders, the script rebuilds
`public/sample-trailer.mp4` from the starter 4-shot list. It builds the trailer
from those clips with `RUNNER=demo`, so that step costs no credits. The demo
line only says "real LTX renders" once `clips.json` shows every move as rendered.

The workflow template has no camera-control node, so with Comfy the preset
moves steer the image through the prompt text. To get real camera control, map
`camera.move` to a camera LoRA as shown in `workflows/README.md`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `RUNNER` | `mock` (`demo` on Vercel) | `mock`, `comfy` or `demo` |
| `COMFY_API_KEY` | — | Your key for local `RUNNER=comfy` and `npm run demo:clips`. **Never set it on the public deploy** |
| `STORAGE` | `local` (`blob` on Vercel when a Blob store is connected) | `local` (files on disk) or `blob` (Vercel Blob) |
| `BLOB_READ_WRITE_TOKEN` | — | Needed for `STORAGE=blob` |
| `DAILY_SHOT_CAP` | `60` | Renders the server pays for (mock, or `RUNNER=comfy` with the server key) per UTC day. Counted in storage. Demo replays and visitors' own keys don't count |
| `SHOTLIST_DATA_DIR` | `./.data` (`/tmp/shotlist` on Vercel) | Root folder for `STORAGE=local` |
| `MOCK_FAIL_SHOT` | — | Mock only: refuse the first render of this shot number |

There is no settings page; the app uses fixed defaults: 1280×704, 24 fps,
H.264, 0.5s crossfades.

### Live-link protection

The public link runs in demo mode with no server key, so it can't spend
anyone's credits. On a server that pays for renders (mock, or `RUNNER=comfy`
with a server key), two cases block rendering: the day's renders reach
`DAILY_SHOT_CAP`, or `RUNNER=comfy` has no key. When either happens and there is
something left to render, the player shows *Demo limit reached — here's a
sample* and plays `public/sample-trailer.mp4`. A cut the user already finished
stays on screen. The sample trailer is built from real LTX clips by `npm run demo:clips`.

## Architecture

```
src/
  app/                      Next.js App Router: one screen (/ and /p/[id]) + API
    api/projects/…          create · get (advances jobs) · patch · generate · files (Range)
  components/               Studio, Monitor (drop zone / player / progress strip), ShotEditor, MovePreview
  lib/
    moves.ts                move catalog and the planner's prompt template
    planner.ts              "what should it feel like" → shot list (deterministic, no LLM)
    runners/
      index.ts              per-request choice: visitor key → Comfy, else RUNNER (demo | comfy | mock)
      types.ts              JobRunner interface
      demo.ts               DemoRunner: replays public/demo/<sample>/<move>.mp4
      mock.ts               MockRunner (+ MOCK_FAIL_SHOT)
      comfy.ts              ComfyRunner (Comfy Cloud API)
    samples.ts              bundled sample image(s) for demo mode
    server/
      storage/              StorageDriver: LocalStorage, BlobStorage (STORAGE=local|blob)
      pipeline.ts           render keys, submit stale shots, poll → collect clips → stitch
      limits.ts             DAILY_SHOT_CAP counter and demo state
      stitch.ts             xfade chain (0.5s crossfades)
      motion.ts             mock camera moves as ffmpeg filter graphs
      ffmpeg.ts             ffmpeg-static wrapper
workflows/                  shotlist.json + .map.json (image-to-video), shotlist-t2v.json + .map.json (text-to-video, shot 1 of a text-only project)
public/demo/<sample>/       sample image + one pre-made real LTX clip per move (from demo:clips)
public/sample-trailer.mp4   demo-state sample trailer
scripts/                    e2e-mock.mjs (tests), make-demo-clips.mjs (real LTX demo clips)
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

The project builds as a standard Next.js app. The ffmpeg binary, the workflow
JSON and the demo clips are traced into the serverless functions. For a hosted deploy:

- **Run in demo mode with no server key.** Leave `RUNNER` unset (it defaults to
  `demo` on Vercel) or set `RUNNER=demo`. **Do not set `COMFY_API_KEY`.** Visitors
  who want their own renders paste their own key.
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
- [ElevenLabs](https://elevenlabs.io) text-to-speech API: the demo video's narration only (not part of the app)

### Voiceover generated with ElevenLabs API (`voiceover.py`)

The narration on the demo video is `narration.txt` read by an ElevenLabs premade voice in one API call, then muxed onto the silent screen recording with ffmpeg:

```bash
pip install requests            # ffmpeg + ffprobe must be on PATH
export ELEVENLABS_API_KEY=...   # never committed
python voiceover.py --list-voices
python voiceover.py --text narration.txt --voice VOICE_ID --video demo.mp4 --out final_with_voiceover.mp4
```

The script speeds the narration up (at most 1.12×) to fit the video, and `--mix` keeps the video's own audio underneath at 25%.

## Roadmap

- [x] 1. App shell and shot list editor
- [x] 2. `JobRunner` interface and `MockRunner` (`RUNNER=mock|comfy`)
- [x] 3. Stitching with 0.5s crossfades, output view, per-shot regenerate
- [x] Polish: shot failures with Edit & retry, storage drivers, daily cap and demo sample
- [x] Demo mode (pre-made clips, no server key) and bring-your-own-key
- [x] 4. `ComfyRunner` and `workflows/shotlist.json` verified with real LTX 2.5 renders on Comfy Cloud
- [x] Text only: describe a scene; shot 1 renders text-to-video, and its last frame drives shots 2+
- [x] Real demo clips and sample trailer rendered with `npm run demo:clips`

## License

[MIT](./LICENSE)
