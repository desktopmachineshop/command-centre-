# Setup

## Run locally

Requirements: Node 22, pnpm 10 (`corepack enable`), Docker (for Postgres).

```bash
pnpm install
docker compose up -d postgres
cp .env.example .env              # set ADMIN_TOKEN; AGENT_RUNNER=echo to try without a model
pnpm --filter @cc/server dev      # API on :8080 (reads ../../.env)
pnpm --filter @cc/web dev         # PWA on :5173, proxied to the API
```

Open http://localhost:5173, leave the server URL blank and paste your `ADMIN_TOKEN`.

With `AGENT_RUNNER=claude-code`, the server runs your local `claude` CLI. You need to be logged
in, or have `CLAUDE_CODE_OAUTH_TOKEN` set.

Checks: `pnpm typecheck`, and `TEST_DATABASE_URL=postgres://cc:cc@localhost:5432/cc_test pnpm test`.
Create the `cc_test` database first. Without `TEST_DATABASE_URL`, the server integration tests are skipped.

## Deploy to Railway

1. **New project → Deploy from GitHub repo** → `desktopmachineshop/command-centre-`. Railway
   picks up `railway.json` and builds the `Dockerfile`.
2. **Add a Postgres service.** Reference its `DATABASE_URL` from the server's variables.
3. **Add a volume** to the server, mounted at `/data`. It holds the brain checkout, agent
   workspaces and Claude Code's config.
4. **Set the variables** (see `.env.example`):
   - `ADMIN_TOKEN`: `openssl rand -hex 32`
   - `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on your PC (logged in to your Claude
     subscription) and paste the token. This is what lets the server drive Claude Code headless
     on your subscription.
   - `ANTHROPIC_FALLBACK_API_KEY` (optional): used only when the subscription hits its usage limit.
   - `BRAIN_REMOTE_URL`: see "Brain" below.
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: `npx web-push generate-vapid-keys`.
   - `WEBHOOK_SECRET`: `openssl rand -hex 24`, if you'll use webhook ingress.
5. **Generate a domain** under Settings → Networking. That URL is your command centre.
6. Keep **one replica**. Live updates and run tokens are held in memory in Phase 0.

### First check after deploying

In the app's Chat tab, send: `Search the brain for anything about shipping, then propose a
journal entry saying the command centre is live.`

The task should show brain tool calls in its transcript, and a `brain.journal` proposal should
appear under Approvals. If the run fails, its error is on the task page.

## Triage

Every event goes through a chain of triagers, cheapest first. The first answer at or above
`TRIAGE_MIN_CONFIDENCE` (default 0.7) wins. If none is that confident, the most confident one is
used, and with no answer at all the event goes to the agent in the `personal` vertical.

1. **Rules** (always on, free): chat, cron, and events whose ingress already set a vertical.
2. **Jev** (set `JEV_API_KEY`): TypeSafe's decision model. One `POST /v1/systemone` call asks
   for the vertical (a Choice), the intent (a Choice over `vertical/intent` pairs), urgency
   (a Score) and three yes/no Nouls (noise, FYI-only, simple). Those pick the route: `drop`,
   `file`, `cheap-agent` or `agent`. To go through a LiteLLM proxy, set
   `JEV_BASE_URL=http://<proxy>/typesafe` and use the LiteLLM key as `JEV_API_KEY`.
3. **Claude Haiku** (set `ANTHROPIC_TRIAGE_API_KEY`): the fallback when Jev is down or unsure.
   It costs about $0.10 per million input tokens and uses its own key, separate from the agent's
   `ANTHROPIC_FALLBACK_API_KEY`.

Model triagers fail soft. On an error or timeout they return nothing, the chain moves on, and
the server logs a `[triage]` warning.

**Measure accuracy before trusting `auto` policies.** The target is ≥90% intent accuracy:

```bash
JEV_API_KEY=... pnpm --filter @cc/triage eval fixtures/dms-sample.jsonl --triager jev
# --triager chain|rules|jev|haiku   --json   --fail-under 0.9
```

It prints vertical, intent and route accuracy, the mistakes (expected → got), latency, and
estimated cost. Each event is a real, billed call. A fixture is one JSON line:
`{"event": {"source": "email", "kind": "message", "title": "...", "payload": {"from": "...", "text": "..."}}, "expected": {"vertical": "dms", "intent": "order-status", "route": "cheap-agent"}}`.
`fixtures/dms-sample.jsonl` holds synthetic examples. For a real measure, export a few hundred
past shop emails into the same format.

## Phone (PWA)

Open the Railway URL on your phone, sign in with the admin token, then **Add to Home Screen**.
On iPhone, push notifications only work from the home-screen app. In the app, go to
**Settings → Enable on this device** to get approval notifications.

## Brain

The brain is a separate private git repo of markdown notes.

1. Create an empty private repo, e.g. `desktopmachineshop/brain`.
2. Create a fine-grained GitHub token with *Contents: read & write* on that repo only.
3. Set `BRAIN_REMOTE_URL=https://x-access-token:<token>@github.com/desktopmachineshop/brain.git`.

The server clones it on boot, and every agent write becomes a commit that it pushes. On your PCs,
clone the same repo and open it as an **Obsidian** vault. The Obsidian Git plugin keeps it in sync,
and edits you make there are pulled on the next server boot.

### Use the brain from other agents

The brain is also an MCP server, so Claude Code or Claude Desktop on your PC can share the same
memory:

```bash
claude mcp add --transport http brain https://<your-domain>/mcp/brain \
  --header "Authorization: Bearer <ADMIN_TOKEN>"
```

Or run it locally over stdio against a clone: `BRAIN_DIR=~/brain pnpm --filter @cc/brain mcp`.

## Extending

- **New vertical:** add `packages/verticals/src/<id>.ts` (copy an existing one) and list it in
  `packages/verticals/src/index.ts`. The brain folder is created on the next boot.
- **New skill:** add `skills/<name>/SKILL.md` and list `<name>` in the verticals that should use it.
- **Schedules:** add to a vertical's `schedules` (cron in its timezone, plus the prompt to run).
- **New outward action** (email, Odoo, social): add an executor to `builtinExecutors` in
  `apps/server/src/actions.ts`. It defaults to `draft` (needs approval) unless a vertical's
  `policies` says otherwise.
- **New ingress** (an email inbox, Odoo polling): call `pipeline.ingest({...})` with a `source`,
  `kind`, `title` and `payload`. Set `dedupeKey` so repeats are ignored.
