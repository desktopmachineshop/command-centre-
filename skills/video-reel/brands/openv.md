# OpenV video guidelines

`product: "openv"`. Read with the master `video-reel` skill.

## What OpenV is

An open requirements-management SaaS: projects, requirements and other artifacts,
traceability links, baselines, V&V coverage and quality findings. Viewers are systems and
quality engineers and their leads. That line is orientation, not a fact you may put in a video:
everything shown comes from the checks below.

## Where facts come from

Verify every feature with the OpenV MCP tools in this task:

| Find | Read |
| --- | --- |
| `list_projects`, `get_project_map`, `list_artifacts` | `get_artifact` |

- Use the UI's exact words for buttons, tabs and messages.
- Work items that are not done are not features. Say "coming soon" only if Dave asked for a teaser.
- Source refs look like `openv:<project>/<artifact id>`.

## What may be shown

- **Demo projects only.** Never a customer's project, org, user list, email address or token.
- Captures use the `openv-demo` signed-in profile on the worker (`authProfile`) when it exists;
  otherwise ask Dave.

## Voice

Second person, plain and precise, like a good engineer showing a colleague. No hype words,
no unexplained acronyms: say "verification and validation" once before "V and V".

## Brand kit

Placeholder colours and fonts until Dave confirms the real ones (docs/VIDEO.md, open questions).
Copy this into the spec's `brand` unchanged:

```json
{ "name": "OpenV", "colours": { "primary": "#7c3aed", "background": "#1a1033", "text": "#ffffff", "accent": "#22d3ee" }, "fonts": { "heading": "Inter", "body": "Inter" } }
```

## Call to action

One action: try the demo, or read the relevant guide. Use a URL only from a source you read
in this task or that Dave gave you.
