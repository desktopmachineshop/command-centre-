# Command Centre

Central hub for day-to-day management of Dave's businesses, side projects and life admin:
Desktop Machine Shop, 3dpandme, OpenV, OpenD and personal.

- An always-on **server** takes in events (chat, schedules, webhooks; email and Odoo in Phase 1).
- A **triage** step sorts each event cheaply (rules now, Jev in Phase 1).
- Real work goes to an **agent**, driven by Claude Code on the Claude subscription.
- Agents read and write a markdown **brain** and use a shared **skills bank**.
- Anything outward-facing becomes a **proposal**, which runs straight away or waits for approval
  depending on policy.
- A **PWA** (phone and desktop) shows the inbox, approvals, chat, brain and worker devices.

```
apps/server            API, WebSocket hub, pipeline, scheduler, MCP endpoints (/mcp/brain, /mcp/actions)
apps/web               PWA
apps/worker            worker daemon for PCs: runs ffmpeg, GPU and local Claude Code jobs
apps/desktop           Tauri app for Windows: the PWA in a window, the worker as a sidecar, tray icon
packages/core          shared types and WebSocket protocol
packages/agent-runtime AgentRunner harness + Claude Code adapter (+ API-key fallback)
packages/brain         git-backed markdown brain + MCP server
packages/email         IMAP inbox poller + email.reply / email.send executors
packages/odoo          Odoo client (JSON-RPC / JSON-2), read-only MCP server (/mcp/odoo), Odoo actions
packages/pa            personal assistant: reminders, to-do lists, Google Calendar, MCP server (/mcp/pa)
packages/social        social platform adapters, inbound watcher, social.* executors, scheduled posts
packages/triage        triagers (rules, Jev, Haiku fallback) + accuracy eval
packages/verticals     one manifest per business / life area
skills/                shared skills bank (Agent Skills format)
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture and phased plan
- [docs/SETUP.md](docs/SETUP.md): running locally and deploying to Railway
