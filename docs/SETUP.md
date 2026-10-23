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

## Desktop app & worker

The desktop app (`apps/desktop`, Tauri 2) shows the same UI as the PWA in a window and, while it
runs, makes the PC a **worker node** that takes heavy jobs: ffmpeg renders, GPU work, DaVinci
Resolve and local Claude Code sessions. The worker itself (`apps/worker`) is a Node daemon, bundled
into the app as a single executable, so the PC doesn't need Node installed.

### Install on Windows

1. On Railway, set `WORKER_TOKEN` (`openssl rand -hex 32`). Without it, workers use `ADMIN_TOKEN`.
2. In GitHub, go to **Actions → Desktop → Run workflow** (or push a `desktop-v0.1.0` tag). When the
   run finishes, download the `command-centre-windows` artifact and run the `-setup.exe` inside
   (or the `.msi`). The installer is unsigned, so SmartScreen asks you to confirm (**More info → Run anyway**).
3. On first start, the app shows its settings page. Enter:
   - **Server URL**: your Railway domain, e.g. `https://command-centre.up.railway.app`;
   - **Worker token**: the `WORKER_TOKEN` value;
   - **Computer name** (optional): shown on the Devices page, defaults to the hostname.

   Then **Save and connect**. The window loads the server's app, where you sign in with
   `ADMIN_TOKEN` as on the phone.

Closing the window keeps the app in the tray. The tray menu has the worker's status (online/idle,
busy with a job and its progress, or offline and retrying), **Open**, **Worker on** (untick it to
stop taking jobs, for example while gaming), **Settings…** (including **Start Command Centre when
I sign in**) and **Quit**. Quitting stops the worker; a job it was running goes back on the queue.

Settings live in `%APPDATA%\CommandCentre\worker.json`, which the worker reads too. Work files go
in `%APPDATA%\CommandCentre\work\jobs\<job id>\`.

### Capabilities

At startup the worker checks what the PC can do, and the server only sends it jobs whose
`requires` it has:

| Capability     | Detected when                                                                         |
| -------------- | ------------------------------------------------------------------------------------- |
| `ffmpeg`       | `ffmpeg` is on `PATH` (e.g. `winget install Gyan.FFmpeg`)                             |
| `gpu`          | `nvidia-smi` lists a GPU, or Windows reports an NVIDIA, AMD or Intel Arc adapter      |
| `davinci`      | DaVinci Resolve or its scripting module is in the default install location            |
| `claude-local` | `claude` is on `PATH` and logged in (use the native installer, which gives `claude.exe`) |
| `browser`      | never detected; turn it on in config                                                  |

To force one on or off, add to `worker.json`, then use **Worker on** to restart the worker:

```json
{ "capabilities": { "gpu": true, "davinci": false } }
```

Other `worker.json` keys: `ffmpegBin` and `claudeBin` (full paths, if they're not on `PATH`),
`workDir`, and `claudeDirs`, the folders `claude.local` jobs may use as their working directory
(besides the work dir).

### Job kinds

The worker only runs the job kinds it has a handler for, after validating the payload. It never
runs a shell command sent by the server. Anything else fails with a clear error.

- `echo` `{message?, steps?}`: a test job.
- `ffmpeg.run` `{args, inputUrl?, outputName, durationSec?}`: downloads `inputUrl` (http/https)
  and runs ffmpeg in the job folder. In `args`, write `{input}` for the downloaded file and end with
  `{output}`, which becomes `<job folder>/<outputName>`. Paths, URLs, extra outputs and file-reading
  options or filters (`-filter_script`, `movie=`…) are rejected. The result is `{outputPath, bytes}`.
- `claude.local` `{prompt, cwd?, maxTurns?}`: runs headless Claude Code on the PC's own login. The
  result is `{result, sessionId, costUsd}`.

### Try it

```bash
curl -X POST https://<your-domain>/api/jobs \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"kind":"echo","payload":{"message":"hello from the server"}}'

curl -X POST https://<your-domain>/api/jobs \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"kind":"ffmpeg.run","requires":["ffmpeg"],"payload":{
        "inputUrl":"https://<any public video URL>.mp4",
        "args":["-i","{input}","-vf","scale=640:-2","-c:v","libx264","{output}"],
        "outputName":"small.mp4"}}'
```

The job's progress and result show in the app, and in `GET /api/jobs`.

### Run the worker without the app

On any machine with Node 22 (including Linux or a Mac):

```bash
pnpm --filter @cc/worker start --server https://<your-domain> --token <WORKER_TOKEN>
```

Flags and env vars: `--config` / `CC_WORKER_CONFIG`, `--server` / `CC_SERVER_URL`, `--token` /
`CC_WORKER_TOKEN`, `--name` / `CC_NODE_NAME`, `--work-dir` / `CC_WORK_DIR`, and
`--capabilities ffmpeg,gpu` / `CC_CAPABILITIES` (an exact list that skips detection). The node id
is generated on first run and saved in the config file, so the server keeps seeing the same device.

### Build the desktop app yourself

On Windows, install Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
(WebView2 is already part of Windows 11), then:

```bash
pnpm install
pnpm --filter @cc/worker build:sea      # → apps/desktop/src-tauri/binaries/cc-worker-<target>.exe
pnpm --filter @cc/desktop tauri build   # installers in apps/desktop/src-tauri/target/release/bundle
```

`pnpm --filter @cc/desktop tauri:dev` runs it in development.

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

## Email

Inboxes feed the command centre over IMAP, and replies go out over SMTP, so any provider works:
Gmail, Google Workspace, Microsoft 365 / Outlook.com, or Odoo's own mail server.

- **In:** each account's mailbox (default `INBOX`) is watched with IMAP IDLE, and re-checked
  every `EMAIL_POLL_INTERVAL_SECONDS` (default 300) in case IDLE is missing or stalls. Every
  new message becomes an `email` event in the account's vertical, so the agent gets a task with
  the email laid out for reading. Mail from the account's own address and from `ignoreFrom` is
  skipped. The last seen UID per account is stored in Postgres (`email_checkpoints`). On the
  very first start an account begins at its newest message, so older mail is not replayed.
- **Out:** agents propose `email.reply` (threaded, with `In-Reply-To`/`References` and "Re:") or
  `email.send`. Both are `draft` policy, so nothing is sent until you approve it under Approvals.
  A copy is then appended to the IMAP Sent folder (`saveSent`; off by default for Gmail, which
  files SMTP-sent mail itself).
- A mailbox that fails to connect is retried with backoff (5 s doubling to 5 min) and logged as
  `[email]`. It never stops the server or the other inboxes.

Set `EMAIL_ACCOUNTS` to a one-line JSON array (an example is in `.env.example`):

```json
[{
  "id": "shop", "vertical": "dms",
  "address": "support@desktopmachineshop.com", "displayName": "Dave at Desktop Machine Shop",
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "support@desktopmachineshop.com", "pass": "<app password>" },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "support@desktopmachineshop.com", "pass": "<app password>" },
  "ignoreFrom": ["noreply@odoo.com", "@mailchimp.com"]
}]
```

- `id`: short and stable. It appears in dedupe keys, checkpoints and reply payloads, so don't
  rename it once the account is live.
- `vertical`: where the mail's tasks go (`dms`, `personal`, `openv`, `opend`, ...).
- `displayName`: the From name, and how the agent signs replies.
- `secure: true` means implicit TLS (IMAP 993, SMTP 465). With `secure: false` (SMTP 587),
  STARTTLS is used when the server offers it.

### Gmail and Google Workspace

1. Turn on **2-Step Verification** for the Google account (app passwords need it).
2. Go to <https://myaccount.google.com/apppasswords>, create an app password called
   "Command Centre", and use the 16 characters (without spaces) as both `imap.pass` and `smtp.pass`.
   Your normal password will not work.
3. Hosts: `imap.gmail.com:993` and `smtp.gmail.com:465`, both `secure: true`. The user is the
   full email address.
4. **Google Workspace:** an admin may need to allow it. In the Admin console, check that IMAP
   access is on (Apps → Google Workspace → Gmail → End user access → POP and IMAP access), and
   that users may create app passwords (Security → Authentication → 2-Step Verification). In
   Gmail itself, check Settings → See all settings → Forwarding and POP/IMAP → IMAP is enabled.

### Other providers

- **Microsoft 365 / Outlook.com:** `outlook.office365.com:993` (IMAP) and `smtp.office365.com:587`
  (`secure: false`, STARTTLS). Microsoft has been switching off password ("basic") auth, so
  IMAP/SMTP AUTH must be enabled for the mailbox, and an app password may be needed. OAuth is not
  supported yet. If sent replies show up twice in Sent Items, set `"saveSent": false`.
- **Odoo mail or any other host:** use the IMAP/SMTP settings the provider gives you.

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

## Odoo

The server talks to Odoo Online through its external API. No custom modules are needed. When
Odoo is configured, the DMS and 3dpandme agents get the read-only `odoo` MCP server (products,
stock, orders, customers, chatter, websites and blogs). They also get three actions, all `draft`
(approve each one):

- `odoo.message.post`: a chatter message to the customer, or an internal note;
- `odoo.blog.draft`: an unpublished blog post;
- `odoo.product.update_price`: a price change.

Without the Odoo variables, all of this is simply left out.

1. **Use a dedicated user** if your plan allows one, e.g. "Command Centre bot". Give it only the
   access it needs: Sales and Inventory read, Website/Blog editor, and Contacts. Every action it
   takes is logged in Odoo under that user. Odoo notes that the external API needs a **Custom**
   plan on Odoo Online; it isn't available on One App Free or Standard.
2. **Create an API key** while logged in as that user: click your avatar (top right) → **My
   Preferences** (or **Preferences**) → **Account Security** tab → **New API Key**. Confirm your
   password, name the key "command centre", pick a duration if asked, and copy the key. Odoo
   only shows it once.
3. **Set the variables** (all four, or Odoo stays off):
   - `ODOO_URL`: e.g. `https://yourcompany.odoo.com`
   - `ODOO_DB`: the database name. On Odoo Online, this is usually the subdomain (`yourcompany`).
     You can confirm it in Settings, at the bottom of the page, with developer mode on.
   - `ODOO_USERNAME`: the user's login (its email address)
   - `ODOO_API_KEY`: the key from step 2
   - `ODOO_API` (optional): `jsonrpc` (the default) works on Odoo 14 and later. Set `json2` on
     Odoo 19+ to use the newer `/json/2` API. Odoo has deprecated `/jsonrpc`, with removal
     planned for Odoo 22 (Odoo Online 21.1), so switch once your instance is on 19.

To check the setup from your PC:

```bash
claude mcp add --transport http odoo https://<your-domain>/mcp/odoo \
  --header "Authorization: Bearer <ADMIN_TOKEN>"
```

Then ask Claude to `list_websites`. You should see both the Desktop Machine Shop and 3dpandme
sites, with their blogs.

## Extending

- **New vertical:** add `packages/verticals/src/<id>.ts` (copy an existing one) and list it in
  `packages/verticals/src/index.ts`. The brain folder is created on the next boot.
- **New skill:** add `skills/<name>/SKILL.md` and list `<name>` in the verticals that should use it.
- **Schedules:** add to a vertical's `schedules` (cron in its timezone, plus the prompt to run).
- **New outward action** (email, social): add an executor to `builtinExecutors` in
  `apps/server/src/actions.ts`, or export them from a package, as `packages/odoo` does with
  `createOdooExecutors`. It defaults to `draft` (needs approval) unless a vertical's
  `policies` says otherwise.
- **New ingress** (an email inbox, Odoo polling): call `pipeline.ingest({...})` with a `source`,
  `kind`, `title` and `payload`. Set `dedupeKey` so repeats are ignored.
