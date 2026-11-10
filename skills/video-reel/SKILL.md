---
name: video-reel
description: The master skill for every marketing video, reel and short (Instagram Reels, Shorts, TikTok-style 9:16 clips, demos, walkthroughs, announcements and 16:9 YouTube explainers) for any brand: OpenV, OpenD, Desktop Machine Shop or 3dpandme. Covers writing the VideoSpec, hooks, length targets, scene and Playwright step design, sources, proposing it with video.produce, changing an existing video with video.revise (never by producing it again), exporting it for Dave to edit in DaVinci Resolve with video.export, and the quality rules. Brand-specific rules (voice, what may be shown, where facts come from, brand kit, CTA) live in brands/<brand>.md beside this file; always read the brand's file first. Use whenever you are asked for a video, reel, short, demo, walkthrough or explainer.
---

# Video reels (all brands)

You never render or publish anything. You write a **VideoSpec** and propose it with the
`actions` tool `propose_action`, action type `video.produce`. Dave approves the spec, a
desktop worker records and renders it, and the finished video comes back to him as a
`social.campaign` draft to approve again before anything is posted. Pair this skill with
`social-platform-guide` for the post text that goes with the video.

## Step 1: read the brand's guidelines

This file is the same for every brand. What differs per brand is in `brands/`, next to this
file. Read the one for the video you're making **before** writing anything:

| Brand | `product` in the spec | Guidelines |
| --- | --- | --- |
| OpenV | `openv` | [brands/openv.md](brands/openv.md) |
| OpenD | `opend` | [brands/opend.md](brands/opend.md) |
| Desktop Machine Shop | `dms` | [brands/dms.md](brands/dms.md) |
| 3dpandme | `3dpandme` | [brands/3dpandme.md](brands/3dpandme.md) |

The brand file sets the voice, where facts come from, what may and may not be shown, the
brand kit (copy its `brand` JSON into the spec unchanged) and the usual call to action. Where
it disagrees with this file, the brand file wins. If the brand isn't listed, stop and ask Dave.

## Accuracy: only real, checked facts

- **Show only what exists.** Every feature, product, price, button, setting and result in a
  scene or narration must come from a source you read in this task, as the brand file says.
  Use the exact on-screen words.
- **No roadmap as fact**, **no invented numbers** (customer counts, speed-ups, prices,
  benchmarks, stock) unless a source you read states them.
- **No private data on screen.** Demo data and public pages only. Never show a customer's
  name, order, project, email address or token. If the only data available is a customer's,
  stop and say so in your summary.
- **Record your sources** in the spec's `sources`: one entry per lookup, with the tool, the
  ref and what it confirms. The reviewer checks the video against them.
- If you can't verify something, cut it. A shorter true video beats a longer wrong one.

## Pick the type and format

| Type | Format | Length | Use for |
| --- | --- | --- | --- |
| `short` | 9:16 | 20–60 s (aim 30–45) | Instagram Reels, Threads, X, YouTube Shorts |
| `announcement` | 9:16 or 1:1 | 20–90 s | A new feature, product, restock or release |
| `demo` | 16:9 | 30–180 s | One task, start to finish |
| `walkthrough` | 16:9 | 1–5 min | A workflow across several screens |
| `explainer` | 16:9 | 3–12 min | YouTube: a concept plus a demo |

Narration runs at about 2.6 words per second, so a 45 s short is about 110 words. The spec
lint warns when the estimate is outside the target.

## Structure

**Reels and shorts (9:16):**
1. **Hook, under 3 s** (title scene or the first visual). Name the viewer's problem or show
   the result first. No logo intro, no "Hi, in this video…".
2. **One idea**, 2–4 scenes, each showing one thing and saying one thing.
3. **Payoff**: the result on screen.
4. **Outro/CTA**: one action and a short URL, from the brand file.

**Long-form (16:9):** title → what you'll learn (slide, 3 bullets max) → chapters, one task
each → recap slide → outro. Put chapter titles in your summary for the YouTube description.

**Narration:** plain, present tense, UK English, short sentences that fit a caption line, in
the brand's voice. Say what the viewer sees as it happens. Spell out what TTS would misread
("docs dot open D dot app", "E-R-eleven"). No hype words, at most one exclamation mark.

## Writing the spec

```json
{
  "id": "opend-editor-short-2026-10",
  "title": "OpenD: fix a doc in the browser",
  "product": "opend",
  "type": "short",
  "format": "9:16",
  "brand": { "...": "copied from the brand file" },
  "voice": { "provider": "auto" },
  "scenes": [
    { "id": "hook", "kind": "title", "heading": "Fix a doc without leaving the browser", "narration": "Spotted a mistake in your docs? Fix it right here." },
    { "id": "edit", "kind": "capture", "narration": "Open the topic and edit it on the Visual tab.",
      "steps": [
        { "action": "goto", "url": "https://<editor host>/files" },
        { "action": "click", "selector": "text=widget.dita" },
        { "action": "highlight", "selector": "[data-tab=visual]", "ms": 1200 }
      ] },
    { "id": "cta", "kind": "outro", "heading": "OpenD", "cta": "Read the editor guide", "url": "docs.opend.app", "narration": "Read the editor guide at docs dot open D dot app." }
  ],
  "sources": [{ "tool": "opend.read_topic", "ref": "opend:topics/editor/editor-edit", "note": "Visual tab, Files page" }]
}
```

Required at the top level: `id` (lowercase letters, digits, dashes), `title`, `product`,
`type`, `format`, `brand`, `scenes`. The server refuses a proposal that doesn't match and tells
you what to fix.

Scene kinds (the field is `kind`): `title` (heading, subheading), `capture` (scripted browser
steps), `slide` (heading + up to 6 bullets that appear in turn), `image` (an https image with a
slow zoom, plus `alt`), `outro` (heading, cta, url), `logo` (the brand's logo alone on its
background for about 1.5 s: an optional intro sting as the very first scene of a long-form video,
never on a short, where the hook comes first; needs `logoUrl` in the brand kit). Every scene can have `narration`; its
length sets the scene's duration, so don't write timings. `minDurationSec` only when a scene
must hold longer. Optional `music` needs a `url`; leave it out unless Dave gave you a track.
A capture scene can use part of its recording with `clip: { startSec, endSec }` (an edit: nothing
is recorded again). Top-level `captions: { style: "word" | "plain", background: "outline" | "box" }`
(use `box` over busy footage) and `transition: { style: "fade" | "cut" }` are optional.

Capture steps (Playwright, run on Dave's PC): `goto` (http/https only, must be first), `click`,
`hover`, `type` (text, delayMs), `press` (a key), `select` (value), `scroll` (selector or y),
`wait` (ms), `highlight` (outline an element, ms), `zoom` (push in on an element, scale, ms).
- Prefer stable selectors: `text=Publish`, `role=button[name="Save"]`, `[data-testid=…]`.
- One scene, one action. Keep each capture under about 15 s of clicking; the voice should
  cover it. Add `wait` or `highlight` where the viewer needs to read something.
- `authProfile` names a signed-in browser profile set up on the worker. Never put passwords or
  tokens in steps. If no profile exists for the app you need, use public pages or ask Dave.
- 9:16 records a phone-width viewport (540×960), so pick pages that work narrow, or set
  `fit: "cover"` and a `viewport`.

`voice` picks the voice-over. Leave it out, or `{ "provider": "auto" }`: the server uses the most
natural voice it has (ElevenLabs or OpenAI when their key is set, else its own voices, else the
robotic `flite`, which is for drafts only). `{ "provider": "silent" }` gives captions and no voice.
To choose a voice yourself, use the same voices chat reads replies aloud with: `"provider": "local"`
plus a `voiceId`:

| voiceId | Voice |
| --- | --- |
| `piper:cori`, `piper:jenny_dioco`, `piper:southern_english_female` | British female (fast) |
| `piper:alba` | Scottish female (fast) |
| `piper:alan`, `piper:northern_english_male` | British male (fast) |
| `kokoro:bf_emma`, `kokoro:bf_isabella` | British female (most natural) |
| `kokoro:bm_george`, `kokoro:bm_lewis` | British male (most natural) |

Prefer a `kokoro:` voice for a finished video. Use the voice Dave names, if he names one. Without
a `voiceId`, the server's default voice speaks. `elevenlabs` and `openai` work only once their API
key is set on the server. If the voice you pick isn't available, `propose_action` refuses it and
lists the voices that are, so pick one of those and propose again.

## Proposing

`propose_action` with `actionType: "video.produce"` and
`payload: { spec, targets: [{ accountId, text, title? }], publishAt? }`:
- `targets` are the brand's social accounts for the finished video, each with post text in the
  brand's social voice (see the brand file) and `social-platform-guide`. Leave it empty for a
  YouTube-only video and say so in the summary.
- The summary says what the video shows, its type and estimated length, and lists the sources.
- One video per proposal. For a series, propose the first and describe the rest.

The result has `warnings`: fix the ones about quality (see below) before Dave sees a render.

## Changing a video that exists: revise, never recreate

Every produced video is a **project**: its spec, its recordings and narration are kept. When Dave
(or you) wants a change to a video that already exists ("make the hook shorter on last week's
OpenD reel", "square version for LinkedIn", "new CTA"), **do not write a new spec and do not
propose `video.produce` again**: that re-records the browser and re-voices everything. Instead:

1. `list_video_projects` (video tools) to find it, then `get_video_project` for its current
   spec, scenes (with which narration and recordings are stored) and history.
2. Propose `video.revise` with a **patch**, the smallest edit that makes the change:

```json
{
  "projectId": "<id from list_video_projects>",
  "patch": {
    "set": { "format": "1:1", "captions": { "background": "box" } },
    "scenes": [
      { "op": "update", "id": "hook", "set": { "narration": "Spotted a typo? Fix it here.", "heading": "Fix it in the browser" } },
      { "op": "remove", "id": "extra-slide" },
      { "op": "add", "scene": { "id": "why", "kind": "slide", "heading": "Why", "bullets": ["No build step"] }, "after": "hook" },
      { "op": "move", "id": "preview", "before": "edit" }
    ]
  },
  "keepCaptures": true
}
```

- `set` changes top-level settings (`title`, `format`, `brand`, `captions`, `music`, `voice`,
  `transition`, `fps`); nested objects merge, `null` removes (e.g. `"music": null`).
- `scenes` operations run in order: `update` (fields of one scene; `null` removes an optional
  field; not its `id` or `kind`), `remove`, `add` (a whole scene, with `after` / `before` /
  `at: "start" | "end"`), `move`. `order: [ids]` reorders everything at once.
- `fromRevision: n` edits (or, with an empty patch, goes back to) an earlier revision.
- `keepCaptures: true` on a format change fits the existing recordings into the new frame
  instead of recording the pages again at the new shape. Use it for a quick 9:16 ↔ 16:9 ↔ 1:1
  cut; leave it off when the page should be laid out for the new shape.
- `targets` / `publishAt` as for `video.produce`, if the new cut should be posted.

**What is re-used** (the approval says so, e.g. "new voice for hook; re-uses 5 of 6 narrations
and 3 of 3 recordings"): only a scene whose `narration` (or the `voice`) changed is voiced again;
only a capture scene whose `steps`, viewport, cursor or profile changed is recorded again;
headings, bullets, CTA, captions, order, `clip` trims, timing, music, brand colours and fonts,
format with `keepCaptures`, and removed scenes only re-compose. So change the words you must and
leave the rest of a scene alone. `video.rerender { projectId }` renders the same spec again
(another encoder, or after a failed render).

## Handing a video to Dave to edit

When Dave wants to cut it himself, or the change is a matter of taste (pacing, music, a custom
shot), propose `video.export { projectId, format: "resolve-draft" }`: DaVinci Resolve on his PC
opens the video as a draft timeline, one clip per scene (title and end cards included), each
scene's narration on its own audio track under it, the music on another, and `captions.srt`
beside it, for him to edit and render. `format: "fcpxml"` only stores the timeline file (FCPXML,
which Resolve, Final Cut and Premiere import) and its media. An edit Dave makes in Resolve stays
in Resolve: it does not come back into the project, so say so if he later asks for a `video.revise`.

`video.archive { projectId }` deletes a finished project's stored recordings and narration.
Only propose it when Dave asks: an archived project can't be revised.

## Quality rules (what makes a video look amateur)

- **A natural voice** for anything that gets posted: never `flite` or `silent` on a public video.
- **Hook in the first 3 seconds**, one idea per scene, and no card held longer than about 9 s on
  a short (20 s on long-form): split it or show the product.
- **Few words on screen**: a heading of a few words, at most 3 bullets on 9:16 / 1:1 (5 on
  16:9), each short enough to read at a glance. The narration carries the detail.
- **Captions on** for every short and every 9:16 / 1:1 video; `background: "box"` when the
  footage behind them is busy. Captions and card text are placed inside the safe margins for
  each format: don't fight them with long lines.
- **A proper end card**: an `outro` with the heading, a CTA and the URL, and the brand's
  `logoUrl` in the brand kit (the logo is drawn on the title and end cards and in the corner of
  content scenes). It is held for at least 4 s.
- **Stills move**: leave `kenBurns` on for `image` scenes.
- **Music under the voice, not over it**: -18 to -24 dB, with a `credit`. It is ducked under
  the narration, faded in and out, and the mix is levelled to -14 LUFS for you.
- **Say what the viewer is looking at** in every capture scene, and trim dead time with `clip`
  rather than leaving the viewer watching a page load.
