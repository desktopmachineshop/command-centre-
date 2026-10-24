---
name: video-scriptwriter
description: How to write OpenV and OpenD product videos (demos, feature walkthroughs, announcements, 9:16 shorts and 16:9 YouTube explainers) as a VideoSpec and propose them with video.produce. Covers hooks for short-form, length targets, scene and Playwright step design, and the accuracy rule that every feature shown is verified with the products' MCP tools (OpenD search_docs/read_topic/get_navigation, OpenV list_projects/get_project_map/list_artifacts/get_artifact). Use whenever you are asked for a product video, demo, walkthrough, explainer, reel or short for OpenV or OpenD.
---

# Video scriptwriter (OpenV and OpenD)

You never render or publish anything. You write a **VideoSpec** and propose it with the
`actions` tool `propose_action`, action type `video.produce`. Dave approves the spec, a
desktop worker records and renders it, and the finished video comes back to him as a
`social.campaign` draft to approve again before anything is posted. Pair this skill with
`social-platform-guide` for the post text that goes with the video.

- **OpenV** is an open requirements-management SaaS (projects, requirements and other
  artifacts, traceability links, baselines, V&V coverage, quality findings).
- **OpenD** is an open documentation SaaS: DITA docs sites with per-reader filtering,
  context-sensitive help, PDF publications, a web editor and push-to-publish hosting.

Those one-liners are orientation, not facts you may put in a video. Everything a video says
or shows comes from the checks below.

## Accuracy: only real, verified features

Before writing a scene, verify the feature in this task with the product's MCP tools:

| Product | Find | Read |
| --- | --- | --- |
| OpenD (site `opend`, docs.opend.app) | `get_navigation`, `search_docs` | `read_topic` |
| OpenV | `list_projects`, `get_project_map`, `list_artifacts` | `get_artifact` |

Rules:
- **Show only what exists.** Every button, tab, menu name and message in a capture scene or
  narration must appear in a doc topic (OpenD) or in the live product data (OpenV) you read in
  this task. Use the UI's exact words ("Show the page for", "Update and publish").
- **No roadmap as fact.** Topics under "Coming soon", release notes for unreleased versions and
  work items that are not done are not features. Leave them out, or say "coming soon" only if
  Dave asked for a teaser.
- **No invented numbers.** No customer counts, speed-ups, prices or benchmarks unless a source
  you read states them. Prices and plans: leave out unless Dave gave them in the task.
- **Demo data, not customer data.** Capture only demo projects and public or demo docs sites.
  Never show a customer's project, org, reader list, email address or token. If the only data
  available is a customer's, stop and say so in your summary.
- **Record your sources** in the spec's `sources`: one entry per lookup, with the tool, the
  ref (`opend:topics/editor/editor-publish`, `openv:<project>/<artifact id>`) and what it
  confirms. The reviewer checks the video against them.
- If you can't verify something, cut it. A shorter true video beats a longer wrong one.

## Pick the type and format

| Type | Format | Length | Use for |
| --- | --- | --- | --- |
| `short` | 9:16 | 20–60 s (aim 30–45) | Instagram Reels, Threads, X, YouTube Shorts |
| `announcement` | 9:16 or 1:1 | 20–90 s | A new feature or release |
| `demo` | 16:9 | 30–180 s | One task, start to finish |
| `walkthrough` | 16:9 | 1–5 min | A workflow across several screens |
| `explainer` | 16:9 | 3–12 min | YouTube: a concept plus a demo |

Narration runs at about 2.6 words per second, so a 45 s short is about 110 words. The spec
lint warns when the estimate is outside the target.

## Structure

**Short-form (9:16):**
1. **Hook, under 3 s** (title scene or the first capture). Name the viewer's problem or show
   the result first: "Spotted a mistake in your docs? Fix it without leaving the browser."
   No logo intro, no "Hi, in this video…".
2. **One idea**, 2–4 capture scenes, each showing one action and saying one thing.
3. **Payoff**: the result on screen (the published page, the trace, the coverage).
4. **Outro/CTA**: one action (read the guide, try it) and a short URL.

**Long-form (16:9):** title → what you'll learn (slide, 3 bullets max) → chapters of capture
scenes, one task each → recap slide → outro. Put chapter titles in your summary for the
YouTube description.

**Narration style:** plain, second person, present tense, UK English, short sentences that fit
a caption line. Say what the viewer sees as it happens ("Choose Publish. The editor opens a pull
request."). Spell out what TTS would misread: "docs dot open D dot app", "D-I-T-A" if needed.
No hype words, at most one exclamation mark per video.

## Writing the spec

```json
{
  "id": "opend-editor-short-2026-10",
  "title": "OpenD: fix a doc in the browser",
  "product": "opend",
  "type": "short",
  "format": "9:16",
  "brand": { "name": "OpenD", "colours": { "primary": "#1f6feb", "background": "#0d1b2a", "text": "#ffffff", "accent": "#ffb703" }, "fonts": { "heading": "Inter", "body": "Inter" } },
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

Scene kinds: `title` (heading, subheading), `capture` (scripted browser steps), `slide`
(heading + up to 6 bullets that appear in turn), `image` (an https image with a slow zoom),
`outro` (heading, cta, url). Every scene can have `narration`; its length sets the scene's
duration, so don't write timings. `minDurationSec` only when a scene must hold longer.

Capture steps (Playwright, run on Dave's PC): `goto` (http/https only, must be first), `click`,
`hover`, `type` (text, delayMs), `press` (a key), `select` (value), `scroll` (selector or y),
`wait` (ms), `highlight` (outline an element, ms), `zoom` (push in on an element, scale, ms).
- Prefer stable selectors: `text=Publish`, `role=button[name="Save"]`, `[data-testid=…]`.
- One scene, one action. Keep each capture under about 15 s of clicking; the voice should
  cover it. Add `wait` or `highlight` where the viewer needs to read something.
- `authProfile` names a signed-in browser profile set up on the worker (for example
  `opend-demo`). Never put passwords or tokens in steps. If no profile exists for the app you
  need, use the public docs site or ask Dave.
- 9:16 records a phone-width viewport (540×960), so pick pages that work narrow, or set
  `fit: "cover"` and a `viewport`.

`voice.provider`: leave `silent` for drafts (captions still work). Use `elevenlabs` or
`openai` only when Dave has set the key and asked for a finished voice-over.

## Proposing

`propose_action` with `actionType: "video.produce"` and
`payload: { spec, targets: [{ accountId, text, title? }], publishAt? }`:
- `targets` are the social accounts for the finished video, each with post text written for
  its platform (see `social-platform-guide`). Leave it empty for a YouTube-only video and say
  so in the summary.
- The summary says what the video shows, its type and estimated length, and lists the sources.
- One video per proposal. For a series, propose the first and describe the rest.
