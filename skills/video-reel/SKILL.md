---
name: video-reel
description: The master skill for every marketing video, reel and short (Instagram Reels, Shorts, TikTok-style 9:16 clips, demos, walkthroughs, announcements and 16:9 YouTube explainers) for any brand: OpenV, OpenD, Desktop Machine Shop or 3dpandme. Covers writing the VideoSpec, hooks, length targets, scene and Playwright step design, sources, and proposing it with video.produce. Brand-specific rules (voice, what may be shown, where facts come from, brand kit, CTA) live in brands/<brand>.md beside this file; always read the brand's file first. Use whenever you are asked for a video, reel, short, demo, walkthrough or explainer.
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
  "voice": { "provider": "silent" },
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
slow zoom, plus `alt`), `outro` (heading, cta, url). Every scene can have `narration`; its
length sets the scene's duration, so don't write timings. `minDurationSec` only when a scene
must hold longer. Optional `music` needs a `url`; leave it out unless Dave gave you a track.

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

`voice.provider`: leave `silent` for drafts (captions still work). Use `elevenlabs` or
`openai` only when Dave has set the key and asked for a finished voice-over.

## Proposing

`propose_action` with `actionType: "video.produce"` and
`payload: { spec, targets: [{ accountId, text, title? }], publishAt? }`:
- `targets` are the brand's social accounts for the finished video, each with post text in the
  brand's social voice (see the brand file) and `social-platform-guide`. Leave it empty for a
  YouTube-only video and say so in the summary.
- The summary says what the video shows, its type and estimated length, and lists the sources.
- One video per proposal. For a series, propose the first and describe the rest.
