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

## Cost control and run guardrails

**Budgets.** Set `AGENT_DAILY_BUDGET_USD` for a global daily cap, and/or `dailyBudgetUsd` in a
vertical's manifest for a cap on that vertical (e.g. `dailyBudgetUsd: 5` in
`packages/verticals/src/dms.ts`). "Today" is the calendar day in `DAY_TIMEZONE` (default
`Europe/London`). Before each run the server checks today's spend. Over a cap:

- The task isn't run. Its status becomes **deferred**, and its page shows which budget stopped it.
- You get one push per budget per day (global, or per vertical).
- Deferred tasks re-queue automatically just after midnight, and on server start. Any task still
  over budget is deferred again, quietly.
- **Retry** (or **Run now**) on the task page, or `POST /api/tasks/:id/retry`, runs it straight
  away, ignoring the budget once. The same button re-runs failed tasks.

**Chat is never deferred.** A message you send in Chat (`source: "chat"`) always runs, because you
asked for it. Budgets only hold back work that started itself: schedules, webhooks, email and
Odoo. (`bypassesBudget` in `apps/server/src/budget.ts`.)

Spend is counted from finished runs, so runs already in flight when a cap is reached can go over
it by their own cost. `/api/stats` shows today's cost per vertical and the configured budgets.

**Concurrency.** `AGENT_CONCURRENCY` (default 2) is the total number of runs at once.
`AGENT_MAX_CONCURRENT_PER_VERTICAL` (default 1) caps each vertical, so one noisy vertical can't
take every slot. A task whose vertical is full goes back on the queue for
`AGENT_BUSY_RETRY_SECONDS` (default 20) while the other verticals keep running. A run stuck
"running" for longer than `AGENT_TIMEOUT_MS` plus 5 minutes (a crashed process) stops holding
its slot.

**Duplicates.** An event whose prompt exactly matches a task already queued, running or deferred
in the same vertical, created within `AGENT_DEDUPE_WINDOW_MINUTES` (default 10, `0` = off), isn't
run again. Its task is marked dropped, with a link to the original. A chat message is only
matched against queued or running work, since chat would run right away anyway.

## Daily digest

At `DIGEST_CRON` (default `30 18 * * *`, in `DAY_TIMEZONE`; set `off` to disable) the server writes
a digest for each vertical that had activity. It covers:

- tasks done and failed;
- tasks deferred;
- actions executed under the `auto-with-digest` policy (the report that policy promises);
- approvals still pending;
- the day's spend, against the budget;
- finished worker jobs. Jobs are counted under `payload.vertical`, or under `personal` if they
  don't have one.

The digest is built from the database, not by an agent, so it costs no tokens. It is saved as a
brain note at `<brainFolder>/digests/YYYY-MM-DD.md`, and one push gives the headline numbers for
every vertical. Just after midnight the notes are rewritten, without a push, so that they cover the
whole day. The Inbox's **Today** card shows the same numbers live. Any day's digest is at
`GET /api/digest?date=YYYY-MM-DD&vertical=dms` (both parameters optional).

## Morning brief

The personal vertical has a weekday 07:00 (Europe/London) `morning-brief` schedule. The agent:

1. reads yesterday's digests and journal (Friday to Sunday on a Monday);
2. lists pending approvals;
3. works out today's priorities;
4. sends you a 3–5 line push through a `notify` action.

`notify` is `auto-with-digest` for the personal vertical, so the brief arrives without an approval
step and is listed in that evening's digest.

The brief is **off by default**. To turn it on, set `enabled: true` on the `morning-brief` line in
`packages/verticals/src/personal.ts` and redeploy. It is an agent run, so it counts towards the
budgets.

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
