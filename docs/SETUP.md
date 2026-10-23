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
