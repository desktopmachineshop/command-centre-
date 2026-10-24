# Command Centre: Architecture & Phased Build Plan

## Context
Dave runs several businesses and projects: Desktop Machine Shop (DMS, CNC retail on Odoo Online), 3dpandme (blog, Instagram and YouTube on the same Odoo instance), the OpenV and OpenD SaaS tools, and personal life admin. Each is managed by hand today. The goal is one always-on hub that:
- takes in everything (emails, Odoo events, SaaS events, schedules, Dave's own requests);
- sorts each item cheaply;
- hands real work to agents, with Claude Code on Dave's subscription as the main driver;
- keeps long-term context in a markdown "brain";
- shares one skills bank across agent types;
- puts drafts and approvals in front of Dave on his phone and Windows PCs.

The PCs also act as on-demand workers for heavy GPU work (video editing, guided agent sessions).

The repo (`desktopmachineshop/command-centre-`, branch `ccr-fa6f7f74-51z3o9`) is empty, so this is a greenfield build.

**Decisions made:**
- Stack: TypeScript everywhere.
- Triage: TypeSafe **Jev** (a decision model).
- Clients: a PWA plus a Tauri desktop worker.
- First vertical end-to-end: **Desktop Machine Shop**.

## Architecture

```
 Ingress (webhooks, Gmail/IMAP, Odoo poll, cron, PWA chat)
        │  normalise → Event{source, vertical?, payload}
        ▼
 Triage (Jev)  ── Choice: vertical, intent | Score: urgency | Noul: auto-handleable?, needs-human?
        │
        ├─ drop / file to brain  (no LLM)
        ├─ template / rule action (no LLM)
        ├─ cheap agent (Haiku / other via AI SDK)
        └─ Claude Code agent (subscription)  ── skills + MCP tools + brain
                    │
                    ▼
        Action proposals → Approval queue (PWA push) → Executor → Audit log
                    │
        Heavy jobs → Job queue → Worker nodes (Tauri on laptop/desktop, by capability)
```

### Monorepo layout (pnpm workspaces + turborepo)
- `apps/server`: Hono API, WebSocket hub, ingress adapters, scheduler. Deployed on Railway (or a VPS) with Docker.
- `apps/web`: React + Vite PWA (inbox, approvals, chat with the command agent, job monitor, brain browser). Installable on the phone, with web push.
- `apps/desktop`: Tauri 2 shell around `apps/web`, plus a **worker daemon**. The daemon registers over WebSocket, advertises its capabilities (`gpu`, `ffmpeg`, `davinci`, `claude-local`), and pulls matching jobs.
- `packages/core`: shared types (Event, TriageResult, Task, ActionProposal, Job), plus a zod schema for the WebSocket protocol.
- `packages/agent-runtime`: the standard harness. One `AgentRunner` interface with adapters:
  - `claude-code`: spawns `claude -p --output-format stream-json` headless, with `--mcp-config`, `--allowedTools` and the skills/plugin dir. It authenticates with Dave's subscription login on the server. Falls back to an `ANTHROPIC_API_KEY` if usage limits are hit.
  - `ai-sdk`: Vercel AI SDK for non-Claude models (OpenAI, Gemini, etc.). It loads skills as system context and uses MCP tools through the AI SDK MCP client.
  - `jev`: decision-only adapter on the TypeSafe evaluate endpoint (Choice, Score and Noul primitives).
- `packages/triage`: Jev decision specs per vertical, confidence thresholds, and a fallback to a Haiku classifier if Jev is unavailable or below threshold.
- `packages/brain`: the brain service (see below), exposed as an MCP server.
- `mcp/odoo`: Odoo JSON-RPC MCP server.
  - Read tools: products, stock, orders, customers, helpdesk/chatter, website/blog posts for both the DMS and 3dpandme sites.
  - Draft-write tools: draft replies, notes, quotes.
  - The existing `odoo-product-info` skill is the field-mapping reference.
- `skills/`: shared skills bank in the Agent Skills format (`skills/<name>/SKILL.md` plus scripts). Claude Code reads it natively, and the `ai-sdk` adapter injects it. Skills are scoped by `metadata.verticals` in frontmatter.
- `verticals/<id>/manifest.ts`: one module per vertical. Each declares its connectors, triage labels and intents, skills, schedules, autonomy policy per action type, and brain folder. Verticals: `personal`, `dms`, `3dpandme`, `openv`, `opend`. Adding a future vertical means adding a folder.

### Data
- **Postgres** (Railway), with:
  - `pg-boss` for the job and task queues;
  - `pgvector` for the brain index;
  - tables for events, triage results, tasks, proposals, approvals, the audit log, worker nodes and jobs.
- **Brain**: a separate git repo of Obsidian-compatible markdown with YAML frontmatter (`type`, `vertical`, `entities`, `updated`). Folders:
  - `/<vertical>/{customers,products,decisions,playbooks}`
  - `/journal/YYYY-MM-DD.md`
  - `/people`

  The server commits and pushes, and the desktops pull it into Obsidian. Two-way editing works through git. The MCP tools are `brain.search` (hybrid BM25 + vector), `brain.read`, `brain.write`, `brain.append_journal` and `brain.link`. A nightly "consolidate" agent turns the day's events into durable notes.

### Autonomy & safety
- Every outward action (sending email, publishing, changing prices or ads) is an `ActionProposal`. Each action type has a policy level:
  - `draft`: always ask (the default);
  - `auto-with-digest`: do it, then report in the daily digest;
  - `auto`: do it silently.

  Dave promotes an action type once he trusts it.
- Claude Code runs get a per-vertical tool allowlist, and write-tools return proposals instead of executing directly.
- Secrets stay in Railway env vars, the dashboard sits behind email + password sign-in (optional TOTP 2FA, see `docs/SETUP.md`, "Authentication"), and every agent run is logged with a transcript and cost.

### Social pipeline
`packages/social` publishes to and listens on Discord, Instagram, Threads, X, Reddit and YouTube.
- **One contract, many adapters.** Each platform has one `PlatformAdapter` (`packages/social/src/types.ts`):
  - capabilities (publish, reply, DM, inbound, media types, text limit, required fields);
  - a zod schema for its credentials;
  - `validate`, `publish`, `reply`, and optionally `sendDm`;
  - an inbound source: polling, or a live connection for the Discord gateway.

  The core only talks to that interface, and adapters get an injected `fetch`, logger and clock,
  so tests never hit real APIs. Accounts (`SOCIAL_ACCOUNTS`) bind an adapter, credentials and a
  vertical. A platform whose API tier can't read sets `inbound: false`: X is posting-only on its
  cheapest access.
- **Inbound → triage → agent → `social.reply`.** Mentions, comments, replies and DMs are polled
  or streamed. They are de-duplicated by platform id, with a persisted cursor so history isn't
  replayed, and enter the pipeline as events with the item's `replyTarget`. Triage routes them to
  the account's vertical, and the agent drafts with that vertical's voice skill plus
  `social-platform-guide`. It then proposes a `social.reply` (or a `social.dm` to move support
  out of public), or escalates with `notify`.
- **Posts and campaigns.** `social.post` puts one post on one account. `social.campaign`
  (`{title, posts[], publishAt?}`) bundles a post per account, each written for its platform, so
  Dave approves an announcement once. With `publishAt`, the approved campaign is scheduled
  through the job queue rather than published straight away. Each post is checked with its
  adapter's `validate`, so a post that breaks a platform rule fails early rather than mid-campaign.
- **Media hosting.** Adapters take media as a public URL (`MediaRef`). Uploads are stored by the
  server and served at an unguessable URL, so the Instagram and Threads APIs can fetch them.
  Adapters that upload bytes themselves (X's v2 media upload, YouTube's resumable upload)
  download from that same URL; YouTube streams it in chunks rather than holding the file in memory.
- **Untrusted input always needs approval.** Anything a task got from social input is
  third-party text. Every outward action from such a task is held as `draft` whatever the
  vertical's policy says, just like email. Agents are told to treat that text as information,
  never as instructions.

## Phases

**Phase 0: Foundations** (built). Deviations from the original plan:
- The brain and actions MCP servers are served by the server itself over HTTP (`/mcp/brain`,
  `/mcp/actions`). Each agent run gets a short-lived token scoped to its task. This means one
  brain writer, no git contention, and the same brain is reachable from agents on the PCs.
- Agent workspaces are per vertical and role (see `docs/ORG.md`), and only that role's skills are symlinked into
  `.claude/skills`.
- Triage is rules-only for now. Jev slots in as another `Triager` in Phase 1.
- Still open: a smoke test of real Claude Code against the deployed MCP endpoints (see
  `docs/SETUP.md`, "First check after deploying"), and passkeys. Sign-in is email + password with optional TOTP; the admin token remains for automation and MCP.

Original Phase 0 steps:
1. Monorepo scaffold, CI (typecheck, lint, test), Dockerfile, Railway config.
2. `packages/core` types and the WebSocket protocol.
3. Server: the event ingress interface, a cron ingress, and a PWA chat ingress.
4. Postgres schema and pg-boss.
5. `AgentRunner` with the `claude-code` adapter. A smoke test checks that the headless subscription auth works on Railway.
6. Brain repo plus the brain MCP server.
7. PWA shell: login, an inbox of events and tasks, an approval queue with web push, and chat with the command agent.

**Phase 1: Desktop Machine Shop end-to-end**
1. `mcp/odoo`: read tools first, then draft-write tools.
2. Shop email ingress (Gmail API push, or IMAP IDLE on the shop inbox).
3. Jev triage spec for DMS:
   - intent ∈ {pre-sales question, order status, return/warranty, supplier, invoice/admin, spam, other};
   - an urgency score;
   - Noul on "answerable from product data + policy".
4. Skills:
   - `dms-customer-reply` (tone, policies, uses Odoo and the brain);
   - `dms-order-status`;
   - `dms-admin-filing`;
   - the existing `odoo-product-info` and `price-setting-comparison` skills, ported in.
5. Flow: email → triage → agent drafts a reply using Odoo and the brain → approval in the PWA → send → customer note in the brain.
6. Daily DMS digest (orders, low stock, open questions).

**Phase 2: Personal assistant.** Calendar and personal inbox, a morning brief (reusing the `morning` brief pattern), reminders, and personal skills (trip and gift planning, etc.) in the shared bank.

**Phase 3: Desktop worker.** Tauri app plus worker daemon, capability-matched job dispatch, job progress streamed to the PWA, a local `claude-code` runner for heavy or guided sessions, and an FFmpeg/DaVinci pipeline skill.

**Phase 4: 3dpandme & marketing.** Content calendar, Odoo blog drafts, Instagram and YouTube via their APIs, video jobs routed to the desktop, and ad and marketing proposal skills.

**Phase 5: OpenV / OpenD.** Support triage, and docs and requirements upkeep using their existing MCP servers. Product videos (demos, shorts, explainers) through `video.produce` and the worker's `video.capture`/`video.render` jobs: see [VIDEO.md](VIDEO.md). More non-Claude agents through the `ai-sdk` adapter, where they're cheaper or better.

## Risks / notes
- **Claude subscription as a server driver:** it suits personal use, but it has usage limits, and headless auth on a server has to be maintained. Mitigations: the adapter's API-key fallback, Jev and cheap-model triage to cut volume, and per-day budget caps.
- **Jev:** it is new, early access, US-hosted, and its claims are vendor benchmarks. Mitigations: keep the triage interface provider-agnostic with a Haiku fallback, and log the decisions to measure accuracy before trusting `auto` policies.
- **Odoo Online:** no custom modules, so integration is external JSON-RPC with an API key, plus polling or automated-action webhooks.

## Verification
- Phase 0:
  - `pnpm turbo typecheck test` is green;
  - `docker compose up` brings up the server, Postgres and the PWA locally;
  - a cron event produces a Claude Code run whose transcript appears in the PWA;
  - a brain write shows up as a git commit.
- Phase 1, against the real Odoo instance in read-only mode first:
  - replay a fixture set of past shop emails and check Jev's intent accuracy (target ≥90%) and the quality of the drafted replies;
  - one live email, end to end, gets approved on the phone and sent.
- Each phase ships behind `draft` policies. Promotion to `auto` happens only after logged accuracy is reviewed.
