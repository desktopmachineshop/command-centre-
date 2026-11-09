# Video pipeline (OpenV and OpenD)

A steady stream of product video for OpenV (requirements management) and OpenD (DITA docs
sites): demos and walkthroughs, feature announcements, 9:16 social shorts (30–60 s) and 16:9
YouTube explainers. Agents write the script from real product content, a desktop worker records
and renders it, and Dave approves twice: the script, then the finished video before it's posted.

Sample output (rendered here with no paid APIs, flite voice, 42 s, 1920×1080, 2.5 MB):
[`docs/media/sample-opend-walkthrough.mp4`](media/sample-opend-walkthrough.mp4).

## Stages

```
 brief ─▶ script + VideoSpec ─▶ approve ─▶ voice ─▶ capture ─▶ captions + compose/render ─▶ approve ─▶ publish
 (Dave,    (agent: video-        (Dave:     (server   (worker:   (worker: ffmpeg, GPU)         (Dave:      (social.campaign;
  cron)     scriptwriter skill    video.     for cloud  browser)                               social.     YouTube: later)
            + OpenV/OpenD MCP)    produce)   TTS)                                              campaign)
```

| Stage | Runs on | What happens | Code |
| --- | --- | --- | --- |
| Brief | Dave (chat) or a schedule | "A 45 s short on OpenD's web editor for X and Instagram" | vertical schedules |
| Script → spec | Server, Claude Code agent | Reads the docs/product with the MCP tools, writes narration and scripted capture steps as a `VideoSpec`, lists its sources | `skills/video-reel` (master) + `skills/video-reel/brands/<brand>.md`, `packages/video/src/spec.ts` |
| Storyboard check | Server | zod validation + `lintSpec` (length vs type, slow hook, missing CTA, no sources); warnings go back in the proposal result | `spec.ts` |
| Approve script | Dave | `video.produce` proposal (draft) | `apps/server/src/video.ts` |
| Voice | Server for cloud TTS and its own voices (keys stay on the server; `voice.provider: "auto"` picks the most natural one configured); worker for `silent`/`flite` | Narration per scene + word timings; scene length = lead-in + voice + tail (or the recording, if longer) | `src/tts/*`, `src/timeline.ts` |
| Capture | Worker with `browser` | Playwright plays each capture scene's steps in Chromium and records the viewport (WebM). Cursor, highlight and zoom are drawn in the page | `src/node/capture.ts`, job `video.capture` |
| Captions | Worker | Word timings → cues → ASS (burned in, word highlight) + SRT (sidecar for YouTube) | `src/captions.ts` |
| Compose/render | Worker with `ffmpeg` (+ `gpu` → NVENC) | One ffmpeg filter graph: fit/freeze/trim each scene, brand-colour cards with libass text, logo, captions, voice at its offsets, ducked music, −14 LUFS | `src/compose.ts`, `src/node/render.ts`, job `video.render` |
| Review | Dave | `social.campaign` proposal holding the video URL, always draft (`forceDraft`), whatever the vertical's policy | `video.ts` |
| Publish | Server | `social.campaign` (Instagram Reels, Threads, X…); YouTube upload is not built yet | `packages/social` |

### How the server chains it

`video.produce` (approved) → `VideoProductions.start`:
- cloud voice: synthesise each scene on the server, store the audio in the media store;
- **with a media store**: submit `video.capture` (`requires: [browser]`) with a PUT URL per
  recording → when it succeeds, submit `video.render` (`requires: [ffmpeg]`) with the recording
  URLs and a PUT URL for the MP4 → when that succeeds, propose `social.campaign` with the video
  as `media: [{ url, type: "video" }]` on each target account;
- **without one** (today, until media hosting lands): one `video.render` job with
  `captureInline: true` (`requires: [ffmpeg, browser]`) does both on one PC, and Dave gets a
  notification with the file's path on that PC.

The chain is driven by `WorkerService.onJobSettled`; each job carries its project and revision
in `payload.meta.production`, and the project itself (specs, asset manifest, history) is in
Postgres (see "Projects" below). A failed job marks the revision failed and notifies Dave. Jobs
requeue on worker disconnect like any other job.

**Wiring still to do** (kept out of this change because the social core and media hosting are
being built concurrently): pass the server's media store to `createServer` as
`overrides.videoMedia` (or construct it there). `createUpload` returns a short-lived,
unguessable PUT URL (so the worker uploads without holding a server token) plus the public URL;
`put` stores bytes made on the server. Until then the chain stops at "video ready on PC X".

## Projects: videos that can be edited later

Every production is a **project**, so a video can be changed (by Dave or by an agent) without
recording the browser again, voicing it again or writing it again from scratch.

**What is kept.**
- The **VideoSpec** is the editable source of truth. Each run is a **revision** holding the full
  spec, what changed, what was re-used, and what it rendered (video, captions, scene timings,
  exports). Table `video_revisions`.
- The expensive **assets** made from it, in a pool on the project (table `video_projects`,
  column `pool`): each scene's narration (audio + word timings) and each capture scene's screen
  recording. An entry maps an **asset key** to the file in the media store.
- Images, music and the logo are the spec's own URLs and are fetched at render time; captions
  (ASS/SRT) are derived from the word timings on every render, which costs nothing.

Why this design: the files were already in the media store with a `work` tag, and Postgres was
already there, so two tables (one row per project with the manifest as JSON, one row per
revision) are the least that survives a restart and can be listed, compared and rolled back. No
new service, no project file format to keep in step with the code.

**Asset keys and what gets redone** (`packages/video/src/project.ts`, all pure). A key is a hash
of exactly the inputs that produce the asset:

| Asset | Its key covers | So it is made again when |
| --- | --- | --- |
| Narration | the scene's text; voice provider, voice id, speed; the server's model/default voice | that scene's words or the voice change |
| Screen recording | the steps; the viewport (the scene's, or the format's default); cursor; `authProfile`; the accent colour if a step highlights | that scene's steps, viewport, cursor or profile change |
| The render | everything drawn or heard (the spec minus title, id, type and sources), every scene's asset keys, encoder/preset if set | anything visible or audible changes |

`planRevision` compares a spec's keys with the pool: a key that is there is re-used, one that
isn't is made, and two scenes with the same key share one asset. Because the pool is keyed by
content rather than by scene, moving or renaming a scene, duplicating it, or going back to an
earlier wording finds the asset again. Everything else (headings, bullets, CTA, captions,
typography, brand colours, order, `clip` trims, timing, music, removing or adding card and image
scenes) only re-composes: one ffmpeg run over the stored files. A change to nothing that is
drawn (the title, the sources) renders nothing. The silent voice is never stored (the worker
makes it for free); flite narration made on the worker is uploaded back into the pool.

A **format change** (9:16 ↔ 16:9 ↔ 1:1) changes the default capture viewport, so by default the
capture scenes are recorded again, laid out for the new shape. `keepCaptures: true` writes the
old viewport into those scenes instead, and the existing recordings are fitted into the new frame.

**Actions** (each approved like `video.produce`, by the vertical's policy):

| Action | Payload | What it does |
| --- | --- | --- |
| `video.revise` | `{ projectId, patch, fromRevision?, keepCaptures?, targets?, publishAt?, encoder? }` | Applies the patch to the latest (or `fromRevision`) spec, records a new revision, makes only what the plan says, renders. The approval shows what changed and what is re-used |
| `video.rerender` | `{ projectId, revision?, encoder?, preset? }` | The same spec rendered again |
| `video.export` | `{ projectId, revision?, format: "fcpxml" \| "resolve-draft" }` | An editable timeline (below) |
| `video.archive` | `{ projectId }` | Deletes the stored assets; the spec and history stay |

A **patch** (`SpecPatch`): `set` merges top-level settings (brand, voice, captions, music and
transition one level deep; `null` removes), `scenes` is a list of `update` / `remove` / `add` /
`move` operations applied in order, `order` lists every scene id. The result must be a valid
VideoSpec. Rolling back is `video.revise` with `fromRevision` and an empty patch; it costs one
compose because the old assets are still in the pool.

**Read tools** (the read-only `video` MCP server at `/mcp/video`, given to the businesses that
make videos; a business's runs see only its own projects): `list_video_projects` (find one by
words in the title) and `get_video_project` (the spec, each scene with whether its narration and
recording are stored, the outputs and exports, lint warnings, the revision history).

**Retention.** Project files are kept after the video is posted (they used to be deleted as
work in progress). `video.archive`, or `VIDEO_PROJECT_RETENTION_DAYS` (default 90) without a
change, deletes the pool and export clips; the nightly render clean-up never deletes a file an
active project still refers to. Rendered videos follow `STORAGE_RENDER_RETENTION_DAYS` once
their project is archived. Only the latest revision's MP4 is protected: an older revision's
render ages out like any other, and rolling back to it re-composes it from the pool.

**Without a media store** (no `PUBLIC_BASE_URL`) projects are still recorded, but nothing can be
kept between renders, so every revision captures and voices again on one PC.

### Editing by hand: export as a timeline

`video.export` hands a revision to an editor as a timeline rather than a flattened MP4:

- the worker renders **each scene as its own clip** (`video.render` with `stemsOnly`): the
  picture only, card text drawn, no captions, no fades from black; H.264 at the video's size, so
  title cards, slides, stills and screen recordings are all ordinary clips;
- the server writes an **FCPXML 1.9** document (`packages/video/src/edit.ts`, pure): the scene
  clips end to end on the video track, each scene's narration connected to its clip on an audio
  lane below it (so it moves with the scene), the music on a second lane across the whole video
  at the spec's level, the narration text as a marker on each clip; the captions travel as
  `captions.srt` beside it;
- `format: "fcpxml"` stores the document and lists its media on the project;
  `format: "resolve-draft"` also submits a `davinci.render` draft job: Resolve on Dave's PC
  downloads the clips, the document is pointed at them and imported as a new timeline
  (`MediaPool.ImportTimelineFromFile`), and the project is left open for him.

FCPXML rather than an EDL because an EDL carries one video track, no audio levels and no clip
names worth having; FCPXML is imported by Resolve, Final Cut and Premiere and keeps tracks,
offsets and volume. OTIO would need its Python library on the server or the PC.

Limits, stated plainly: this is **not tested against a real Resolve** (the Resolve script runs
against a stand-in in tests, and the document is checked for structure, frame-exact lengths and
that every file exists, not by an NLE; a generated document was also read back once with
OpenTimelineIO's FCPX adapter, which found the video track, the narration lane at the right
offsets and the music lane). The SRT is not placed on a subtitle track for him
(Resolve: File → Import → Subtitle, then drag it on). The music clip is as long as the video;
a shorter track is looped in the render but not in the timeline. Edits made in Resolve do not
come back into the project.

## Quality pass

What the compositor and linter now do so a render doesn't look home-made (each checked by a
local render in `packages/video/test/e2e.test.ts`):

- **Transitions:** scenes meet through a short dip to the brand background (`transition`,
  default 0.2 s; `"cut"` for hard cuts) instead of jumping; the video still fades from and to
  black. Real crossfades would overlap scenes and move every caption and voice offset, so they
  are not used.
- **Captions:** a heavier stroke and shadow, or `captions.background: "box"` for busy footage;
  side margins inside the title-safe area for each format (wider on 9:16); secondary card text
  a size larger on 9:16 and 1:1.
- **Audio:** music ducks earlier and releases more slowly under the voice, the mix is levelled
  to -14 LUFS and then limited (measured peak ≤ -1 dBFS in the tests), and the sound fades out
  with the picture.
- **End card:** an outro is held at least 4 s, with the logo above the heading when the brand
  kit has one.
- **Trims:** `clip: { startSec, endSec }` on a capture scene cuts dead time out of a recording
  without recording again.
- **Voice:** `voice.provider` defaults to `"auto"`: ElevenLabs, then OpenAI, when their key is
  set, else the server's own voices, else flite. flite is only the keyless fallback, and the
  lint says so.
- **Lint** (`lintQuality`): robotic or silent voice, no logo, captions off on short-form, a card
  or still held too long, long headings and walls of bullets for the format, silent screen
  recordings, loud or uncredited music, a video of only text cards, a short end card.

- **Intro sting (optional):** a `logo` scene shows the brand's logo alone on its background for
  about 1.5 s; put first, it fades up from black and dips into the first scene. It is a still
  logo, not an animation.

Not built: an animated logo sting, true crossfades, brand fonts shipped to the PC, and anything
a designer would call motion graphics.

## Stack choices

### Composition and rendering: ffmpeg filter graphs (chosen)

| | ffmpeg filter graph | Remotion (React) |
| --- | --- | --- |
| Licence | LGPL/GPL tool, free | Free for individuals and for-profit companies **with up to 3 employees**; otherwise a Company Licence: Creators $25/seat/month, or Automators $0.01/render with a $100/month minimum; Enterprise from $500/month. Remotion 5.0 (draft) counts contractors toward team size |
| Runs where | Already a worker capability (`ffmpeg`); NVENC on Dave's GPU | Node + headless Chrome renders each frame; GPU helps little for the compositing |
| Determinism / tests | The command is a pure function → unit-tested; renders are byte-stable for the same inputs | Testable, but renders need Chrome |
| Look | Cards via libass (fonts, colours, fades); fine for product demos | Best for rich motion design |

ffmpeg wins for v1: zero licence risk whatever DMS's headcount, it runs on the worker that
exists, NVENC makes renders fast, and screen-capture demos need fitting, cutting, captions and
audio mixing more than motion graphics. If Dave later wants animated templates, Remotion slots
in as another compositor behind the same `VideoSpec` (and is free if his company has ≤3
employees, an open question below).

### Screen capture: Playwright `recordVideo` (chosen)

Scripted steps (`goto`, `click`, `type`, `select`, `scroll`, `wait`, `highlight`, `zoom`…) run
in Chromium via `playwright-core`; the context records the viewport to WebM (VP8, ~25 fps). The
runner trims the blank page before the first load, shows a gliding cursor, outlines elements
and zooms with a CSS transform, so the compositor only fits the clip. Signed-in apps use
Playwright storage-state profiles that live on the PC (`captureProfiles` in `worker.json`),
never credentials in the spec. Viewports: 1280×720 (16:9), 540×960 (9:16), 900×900 (1:1).
Higher-quality option for later: CDP `Page.startScreencast` at 2× device scale, or OBS on the PC.

### Voice-over (TTS): adapter, ElevenLabs first for finished videos

| Provider | Approx. cost / min of audio | Word timings | Notes |
| --- | --- | --- | --- |
| ElevenLabs Multilingual v2 / v3 | ~$0.09 ($0.10 per 1k chars); Flash/Turbo ~$0.045 | Yes, per character (`/with-timestamps`) → exact captions | Best-rated quality; implemented (`elevenLabsProvider`) |
| OpenAI `gpt-4o-mini-tts` | ~$0.015 (OpenAI's estimate; $0.60/M text in, $12/M audio out) | No (estimated, or align with Whisper) | Style instructions ("upbeat product demo"); implemented (`openAiProvider`) |
| Gemini 3.8 Flash TTS | ~$0.0135 through 2026, ~$0.027 from 2027 (25 audio tokens/s) | No | Cheapest cloud option; not implemented |
| Cartesia Sonic, Azure, Google Chirp 3 HD, Polly | varies | Polly/Azure have speech marks | Alternatives behind the same interface |
| `flite` (ffmpeg filter), `silent` | free | estimated | Drafts and tests; flite is robotic and missing from common Windows ffmpeg builds |

All providers sit behind `TextToSpeech` (`synthesize(text, { voiceId?, speed?, signal? }) →
{ audio, mime, words?, durationSec }`), the same shape as `packages/voice` on main, so the two
can converge (a `packages/voice` provider plugs in directly; `durationSec` is the one addition,
needed for the timeline). Cloud providers get an injected `fetch`. Keys and voices are the voice settings (see SETUP.md):
`ELEVENLABS_API_KEY` (+ `VOICE_ELEVENLABS_VOICE`, `VOICE_ELEVENLABS_TTS_MODEL`) or `OPENAI_API_KEY`
(+ `VOICE_OPENAI_VOICE`, `VOICE_OPENAI_TTS_MODEL`). Neither has been called live.

### Captions

Burned-in captions use the provider's word timings when it has them (ElevenLabs), else timings
estimated from the text over the clip's measured length (weighted by word length, pauses at
punctuation), which is close enough for short TTS lines because the text is known. If drift
shows up, the next step is forced alignment with WhisperX (Whisper + phoneme alignment, word-level
timestamps) on the GPU worker. Style: 1–2 short lines, the spoken word in the brand accent
colour, placed at ~30% from the bottom on 9:16 so platform UI doesn't cover it. An SRT goes
alongside for YouTube.

### Music and SFX (optional)

`spec.music` loops a track under the voice, ducked with a sidechain compressor, faded in/out.
Sources: YouTube Audio Library (safe for YouTube), Pixabay Music (Pixabay licence allows
commercial use without attribution, but open uploads can still trigger Content ID claims, so
keep the licence page as evidence). Keep a small vetted library in the media store rather than
letting agents pick tracks.

### AI video generation (B-roll): survey only, optional

Product demos should be real screen captures. Generated clips could serve as abstract B-roll
for hooks and explainers, as `image` scenes now and a future `clip` scene kind:

| Model (API) | Approx. price | Notes |
| --- | --- | --- |
| Google Veo 3.1 | $0.40/s (720p–1080p), Fast $0.10/s, Lite $0.05/s; audio included | Gemini API |
| Kling 3.0 | ~$0.08/s (no audio) to ~$0.14/s (1080p) | via Kling or resellers |
| Runway Gen-4.5 | ~$0.12/s (credits at $0.01) | |
| OpenAI Sora 2 | was ~$0.10/s (720p) | API sunset 24 Sept 2026; don't build on it |

A 5 s B-roll clip costs about $0.25–$2. Never use generated footage to depict the product UI.

## Costs

| Item | Per 45 s short | Per 8 min explainer |
| --- | --- | --- |
| Script (Claude Code on the subscription) | $0 marginal | $0 marginal |
| Voice: ElevenLabs v2 / OpenAI mini / flite | ~$0.07 / ~$0.01 / $0 | ~$0.75 / ~$0.12 / $0 |
| Capture + render on Dave's PC | electricity | electricity |
| Music | $0 (free libraries) | $0 |
| Optional AI B-roll (3 × 5 s, Veo Fast) | +$1.50 | +$1.50 |
| Remotion (not used) | $0 if ≤3 employees, else ≥$25/month | |

Render speed here (CPU, 2 cores, x264 `veryfast`): 42 s of 1080p in ~10 s; NVENC on a desktop
GPU will be faster. ElevenLabs subscriptions bundle credits; the per-character API rate above
is the pay-as-you-go figure.

## Worker setup

- `ffmpeg` on PATH (already a capability); `subtitles` needs a build with libass (gyan.dev
  "full" builds have it). NVENC is used when the node has `gpu` (`encoder: auto` falls back to
  x264 if NVENC fails).
- Capture works out of the box with the desktop app (`apps/worker/src/browser.ts`):
  - **Browser:** the installed Chrome, else Edge (always there on Windows), else Chromium.
    `chromiumBin` in `worker.json` (or `CC_CHROMIUM_BIN`) picks another.
  - **Playwright:** `playwright-core` can't go inside the single executable (it ships driver
    files), so `build:sea` copies it to `binaries/playwright-core/` and Tauri installs it beside
    the worker (`bundle.resources`). The worker loads it from there with `createRequire`
    (`CC_PLAYWRIGHT_DIR` points elsewhere; under Node it uses the package as usual).
  - **Recorder:** Playwright records with its own small ffmpeg build (not the system ffmpeg).
    On start, if it's missing, the worker runs Playwright's installer once (a few MB into the
    ms-playwright cache). Playwright runs its scripts with `process.execPath`, which in the app
    is the worker, so the worker runs any script from its `playwright-core` folder it's given.
  - `browser` is offered only when all three are in place; the log says why not
    (`[capture] screen capture off: …`).
  - Checked end to end by `apps/worker/test/sea.e2e.test.ts` (opt-in: build the executable,
    then `CC_SEA_WORKER=…`), including the first-run recorder download.
- Signed-in captures: save a Playwright storage state for a demo account and add
  `"captureProfiles": { "opend-demo": "C:\\...\\opend-demo.json" }`.
- Brand fonts not installed on the PC: not yet supported (`fontsDir` exists in the compositor).

## Run the sample

```bash
pnpm install
pnpm --filter @cc/video render:sample -- --out sample.mp4            # flite voice if available
pnpm --filter @cc/video render:sample -- --voice silent --preset slow --quality 26
```

It serves `packages/video/sample/opend-editor/index.html` (a stand-in for the OpenD web
editor built from the "Edit and save a topic" and "Publish your changes" docs) on 127.0.0.1,
records four capture scenes, voices seven scenes, and prints ffprobe's duration, resolution
and audio stream. `CC_CHROMIUM_BIN` / `CC_FFMPEG_BIN` override the binaries.

`render:sample` and `docs/media/sample-opend-walkthrough.mp4` predate the quality pass (the
committed file has hard cuts); run the script for a current one.

## Roadmap

1. **Built:** spec, TTS adapters, capture runner, captions, compositor, worker
   jobs, `video.produce` with the job chain, skill, local e2e render; projects with
   `video.revise` / `video.rerender` / `video.export` / `video.archive`, the `video` read tools
   and the quality pass (see "Projects" and "Quality pass").
2. **Next:** wire the media store and `social.campaign` (attach the MP4 to Reels/Threads/X);
   brand kits confirmed by Dave (logo files,
   colours, fonts); demo accounts and storage-state profiles for OpenV and OpenD; wire the
   OpenD/OpenV MCP servers into those verticals' agent runs; first real ElevenLabs voice.
3. **Then:** YouTube upload action (`youtube.upload` with title, description, chapters, SRT,
   thumbnail; Data API OAuth); a review page in the PWA with the video player and the
   spec's sources side by side; thumbnail generation; WhisperX alignment.
4. **Later:** a series planner (schedule: one short a week per product from release notes and
   new docs topics), A/B hooks, AI B-roll scene kind, Remotion templates for announcements if
   wanted, localisation (ElevenLabs multilingual + translated captions).

## Open questions for Dave

1. **Company size**: does Desktop Machine Shop (or whoever owns OpenV/OpenD) have more than 3
   employees, contractors included? That decides whether Remotion is free, if we ever want it.
2. **Brand kits**: logo files, colours and fonts for OpenV and OpenD (the spec has placeholders).
3. **Voice**: ElevenLabs (best, ~$0.09/min, a stock or cloned voice?) or OpenAI (~$0.015/min)?
   Your own cloned voice, or a stock one? Same voice for both products?
4. **Demo environments**: which OpenV project and OpenD site can be shown on camera, and a demo
   login for each (storage-state profiles on the PC)? Never customer data.
5. **Channels**: which accounts per product (Instagram, Threads, X, YouTube, LinkedIn?) and
   is a YouTube channel per product wanted? YouTube upload needs its own OAuth setup.
6. **Cadence and approval**: how many videos a week, and is approving the script and the final
   video both needed, or only the final video?
7. **Which PC renders**: the GPU desktop only, and should video jobs avoid gaming hours
   (the tray's "Worker on" toggle already pauses everything)?
8. **Music**: background music on shorts (YouTube Audio Library / Pixabay), or voice only?
9. **AI B-roll**: worth trying for hooks at ~$0.50–2 per clip, or screen captures only?

## Sources

- Remotion licence: <https://github.com/remotion-dev/remotion/blob/main/LICENSE.md>; pricing:
  <https://www.remotion.pro/license>; 5.0 licence changes (draft):
  <https://github.com/remotion-dev/remotion/pull/3750>
- Playwright video recording: <https://playwright.dev/docs/videos>
- ElevenLabs timestamps API: <https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps>;
  pricing summaries: <https://www.happyrobot.ai/hub/elevenlabs-pricing>,
  <https://developer.puter.com/tutorials/elevenlabs-api-pricing/>
- OpenAI gpt-4o-mini-tts: <https://developers.openai.com/api/docs/models/gpt-4o-mini-tts>;
  per-minute estimate discussion: <https://community.openai.com/t/understanding-gpt-4o-mini-tts-pricing-input-characters-cost/1151816>
- Gemini TTS pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- TTS landscape (Cartesia, Chirp, Polly): <https://smallest.ai/blog/best-elevenlabs-alternatives-in-2026-top-tts-tools-compared>,
  <https://futureagi.com/blog/best-text-to-speech-providers-2026/>
- WhisperX: <https://arxiv.org/abs/2303.00747>
- AI video pricing: <https://invideo.io/blog/ai-video-model-pricing>,
  <https://modelslab.com/blog/api/veo-3-1-vs-kling-3-sora-2-ai-video-api-cost-2026>,
  <https://www.atlascloud.ai/blog/cheapest-ai-video-generation-api-2026>
- Music licensing: <https://pixabay.com/service/faq/>,
  <https://help.heygen.com/en/articles/8986144-how-to-remove-your-content-id-claim-in-youtube>

Prices are from October 2026 and mostly third-party summaries; check the vendors' pages before
committing to a plan.
