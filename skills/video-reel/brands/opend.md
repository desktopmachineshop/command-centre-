# OpenD video guidelines

`product: "opend"`. Read with the master `video-reel` skill.

## What OpenD is

An open documentation SaaS: DITA docs sites with per-reader filtering, context-sensitive
help, PDF publications, a web editor and push-to-publish hosting. Viewers are technical
writers and the people who run docs for a product. That line is orientation, not a fact you may
put in a video: everything shown comes from the checks below.

## Where facts come from

Verify every feature with the OpenD MCP tools in this task (site `opend`, docs.opend.app):

| Find | Read |
| --- | --- |
| `get_navigation`, `search_docs` | `read_topic` |

- Every button, tab, menu name and message must appear in a topic you read. Use its exact
  words ("Show the page for", "Update and publish").
- Topics under "Coming soon" and release notes for unreleased versions are not features.
- Source refs look like `opend:topics/editor/editor-publish`.

## What may be shown

- The public docs site and demo sites only. Never a customer's site, reader list, email
  address or token.
- Captures of the editor use the `opend-demo` signed-in profile on the worker (`authProfile`)
  when it exists; otherwise use the public docs site or ask Dave.

## Voice

Second person, plain and helpful, like a writer showing another writer a shortcut. Spell out
"D-I-T-A" for TTS when it matters, and "docs dot open D dot app" for the URL.

## Brand kit

Placeholder colours and fonts until Dave confirms the real ones (docs/VIDEO.md, open questions).
Copy this into the spec's `brand` unchanged:

```json
{ "name": "OpenD", "colours": { "primary": "#1f6feb", "background": "#0d1b2a", "text": "#ffffff", "accent": "#ffb703" }, "fonts": { "heading": "Inter", "body": "Inter" } }
```

## Call to action

One action: read the guide for what the video showed, at docs.opend.app.
