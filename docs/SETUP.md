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

Open http://localhost:5173. The first time, it shows **Set up Command Centre**: paste your
`ADMIN_TOKEN` and choose your email and password (see "Authentication" below).

With `AGENT_RUNNER=claude-code`, the server runs your local `claude` CLI. You need to be logged
in, or have `CLAUDE_CODE_OAUTH_TOKEN` set.

Checks: `pnpm typecheck`, and `TEST_DATABASE_URL=postgres://cc:cc@localhost:5432/cc_test pnpm test`.
Create the `cc_test` database first. Without `TEST_DATABASE_URL`, the server integration tests are skipped.
The sign-in browser test (`apps/server/test/auth.browser.test.ts`, Playwright) also needs Chromium
at `PW_CHROMIUM` (default `/opt/pw-browsers/chromium`) and a built PWA; `pnpm test` builds the PWA
first, and the test is skipped when Chromium is missing.

## Deploy to Railway

1. **New project → Deploy from GitHub repo** → `desktopmachineshop/command-centre-`. Railway
   picks up `railway.json` and builds the `Dockerfile`.
2. **Add a Postgres service.** Reference its `DATABASE_URL` from the server's variables.
3. **Add a volume** to the server, mounted at `/data`. It holds the brain checkout, agent
   workspaces and Claude Code's config.
4. **Set the variables** (see `.env.example`):
   - `ADMIN_TOKEN`: `openssl rand -hex 32`. You paste it once, at first-run setup; after that
     it is for automation and MCP (see "Authentication").
   - `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on your PC (logged in to your Claude
     subscription) and paste the token. This is what lets the server drive Claude Code headless
     on your subscription.
   - `ANTHROPIC_FALLBACK_API_KEY` (optional): used only when the subscription hits its usage limit.
   - `BRAIN_REMOTE_URL`: see "Brain" below.
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: `npx web-push generate-vapid-keys`.
   - `WEBHOOK_SECRET`: `openssl rand -hex 24`, if you'll use webhook ingress.
5. **Generate a domain** under Settings → Networking. That URL is your command centre.
6. Keep **one replica**. Live updates, run tokens and sign-in rate limits are held in memory in Phase 0.
7. **Open the URL and create your account** (first-run setup, below).

## Authentication

You sign in to the app with your **email and password** (plus an optional authenticator code).
The server keeps you signed in with a session cookie for 30 days, extended each time you use the
app, so on the phone and PCs you rarely need to sign in again.

### First-run setup on Railway

While the server has no users, opening the URL shows **Set up Command Centre**:

1. Paste the `ADMIN_TOKEN` from the server's Railway variables. This proves the server is yours,
   so a stranger who finds the URL first can't claim it. You only need it this once.
2. Enter your name, email and a password (at least 10 characters), then **Create account**.

You're signed in straight away. After that the setup screen is gone for good: setup is refused
once any user exists, even with the admin token.

You can also create the first user from your PC instead (next section).

### Users from the command line: create, reset a password

The `user:*` scripts run against the database directly. Each one asks for the password twice
without echoing it (or reads it from stdin when piped), so it never lands in your shell history.

```bash
pnpm --filter @cc/server user:create -- --email dave@desktopmachineshop.com --name Dave
pnpm --filter @cc/server user:reset-password -- --email dave@desktopmachineshop.com
pnpm --filter @cc/server user:reset-password -- --email dave@desktopmachineshop.com --disable-2fa   # lost your phone
pnpm --filter @cc/server user:list
```

They use `DATABASE_PUBLIC_URL` if set, then `DATABASE_URL` (or `CC_DATABASE_URL` to force one).
Against Railway, from a clone of the repo on your PC with the [Railway CLI](https://docs.railway.com/guides/cli)
linked to the project (`railway link`):

```bash
railway run --service Postgres -- pnpm --filter @cc/server user:reset-password -- --email dave@desktopmachineshop.com
```

`--service Postgres` gives the script the database's public URL, which is reachable from your PC
(the server's own `DATABASE_URL` is a private-network address). Alternatively, open a shell in
the server container with `railway ssh` and run `node dist/cli.js reset-password --email ...`.

A reset clears any lockout and signs you out on every device.

### Two-factor authentication (optional)

**Settings → Two-factor authentication → Set up two-factor** shows a QR code. Scan it with an
authenticator app (1Password, Google Authenticator, Authy, ...). On the phone itself, tap **Open
in your authenticator app** or type the key shown under the QR code. Enter the 6-digit code to
turn it on.

You then get **ten recovery codes**, shown once. Keep them somewhere safe (a password manager).
Each one works once in place of a code. If you lose the phone and the codes, reset with
`user:reset-password -- --disable-2fa` as above. Turning two-factor off needs your password.

### Devices and passwords

- **Settings → Signed-in devices** lists each session (browser, IP, last active). **Sign out**
  ends that device's session at once, including its live connection.
- **Settings → Change password** needs the current password and signs out every other device.
- **Settings → Sign out** ends this device's session only.
- After five wrong passwords or codes, an account is locked for 15 seconds, then 30, 60 and so
  on, doubling up to 15 minutes. An IP that keeps failing is slowed the same way. The error never
  says whether the email or the password was wrong. If you lock yourself out, wait, or reset the
  password from the CLI.

### What the admin token is still for

`ADMIN_TOKEN` is the key for machines, not for you day to day:

- **API automation**: `Authorization: Bearer <ADMIN_TOKEN>` works on every `/api` route, as in
  the `curl` examples below. Bearer requests don't need the CSRF header.
- **MCP**: `claude mcp add ... --header "Authorization: Bearer <ADMIN_TOKEN>"` for the brain, Odoo
  and actions endpoints. `/mcp/*` doesn't accept the session cookie.
- **First-run setup**, once.
- **"Use an admin token instead"** on the sign-in screen: the old token sign-in, kept for
  advanced use (for example pointing the app at a different server). That token is stored in the
  browser until you sign out.

Workers use `WORKER_TOKEN` (or `ADMIN_TOKEN` if that isn't set), as before. Rotating
`ADMIN_TOKEN` (change the variable and redeploy) doesn't sign anyone out.

### How it works (security notes)

- Passwords are hashed with scrypt (N=2^15, r=8, p=1, a random salt per user). The parameters are
  stored with each hash, so they can be raised later: older hashes are upgraded at the next sign-in.
- The session cookie is `HttpOnly`, `SameSite=Lax`, lasts 30 days from last use and, over https,
  is `Secure` and named `__Host-cc_session`. Railway terminates TLS, so https is detected from
  `X-Forwarded-Proto`. Only a SHA-256 of the session token is stored in the database.
- Requests that change something with the cookie must send `X-CC-Request: 1` (the app always
  does) or come from the same origin. Bearer-token requests are exempt.
- Sign-in rate limits key on the client IP taken from `X-Forwarded-For`, counting
  `TRUSTED_PROXY_HOPS` (default 1, Railway's edge) from the right, so a spoofed header can't dodge
  them. Set it to `0` if nothing sits in front of the server.
- TOTP follows RFC 6238 (SHA-1, 6 digits, 30 s), accepts one step either side for clock drift,
  and refuses a code that was already used. The secret is stored in the database unencrypted.

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

Open the Railway URL on your phone and sign in with your email and password (and the code from
your authenticator app, if two-factor is on). Then **Add to Home Screen** (iPhone: Share → Add to
Home Screen; Android: ⋮ → Install app). You stay signed in for 30 days from the last time you
used it. No token is stored on the phone; the session is an HttpOnly cookie.

On iPhone the home-screen app keeps its own cookies, separate from Safari, so sign in once more
inside it after adding it. Push notifications on iPhone only work from the home-screen app. In
the app, go to **Settings → Enable on this device** to get approval notifications.

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

   Then **Save and connect**. The window loads the server's app, where you sign in with your
   email and password, as on the phone. The window keeps its own session cookie (in WebView2's
   profile), so it stays signed in across restarts; it shows up under **Settings → Signed-in
   devices** as Edge on Windows. The worker token is only for the worker, not for signing in.

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

## Social

The command centre watches and posts to social accounts on Discord, Instagram, Threads, X,
Reddit and YouTube (`packages/social`). Each platform is an adapter behind one interface, so the rest of the
pipeline treats them all the same.

- **In:** every account with `inbound: true`, on a platform whose adapter can read (and whose API
  tier allows it), is watched for comments, mentions, replies and DMs. Most platforms are polled:
  every `SOCIAL_POLL_DEFAULT_SECONDS` (default 300), or the adapter's own interval, ±10% jitter.
  Discord keeps a live connection. Each new item becomes a `social` event in the account's
  vertical, with the dedupe key `social:<accountId>:<item id>`, and the agent gets a task laying
  it out for reading. The task's first line is `<Platform> <kind> from <author>: <text>`. Items
  the account wrote itself are skipped (matched on `handle`, or on `options.userId` when set).
- **Checkpoints:** each account's poll cursor is stored in Postgres (`social_checkpoints`). It is
  saved only after every item it covers has been ingested, so a failure means the items are fetched
  again, never lost. On the very first poll an account starts from "now", so old history is not
  replayed.
- **Failures:** an account that fails is retried with backoff (30 s doubling to 15 min) and logged
  as `[social]`. It never stops the server or the other accounts.

### Actions and approvals

Agents never post directly. They propose one of these, all `draft` policy (approve each one):

- `social.reply` `{accountId, target, text}`: answer a comment, mention or DM. The task prompt
  includes this payload ready to fill in; `target` must stay as given.
- `social.post` `{accountId, content}`: one post on one account. `content` is
  `{text, media?: [{url, type: "image"|"video", alt?}], link?, title?, target?, options?}`. Reddit
  needs a `title` and a subreddit `target`; Instagram needs at least one image or video; YouTube
  needs a `title` and exactly one video (and takes `options` such as `privacyStatus`).
- `social.dm` `{accountId, userId, text}`: only on platforms that allow DMs.
- `social.campaign` `{title, posts: [{accountId, content}], publishAt?}`: the same news on several
  accounts with **one approval**, e.g. a new YouTube video announced on Instagram, Threads, X,
  Reddit and Discord.

Every payload is checked when it is proposed (text length, media types, required title or target,
whether the account exists and belongs to the proposing vertical), so a bad one fails at once,
before it reaches Approvals. A campaign is refused whole if any of its posts is invalid. Under
Approvals, social proposals show one card per platform with the text, its character count
against that platform's limit, media thumbnails and where it goes.

**After approval:** without `publishAt`, every post goes out at once. A platform that fails doesn't
stop the others, and the result lists what was published (with links) and what failed. With
`publishAt` (an ISO date-time), the posts are stored in `scheduled_posts` and a system job checks
every minute, publishes the ones that are due, and marks each one published (with its link) or
failed. A failure sends a push notification. **Approving the campaign is the only approval**:
nothing asks again at publish time. A post that is still scheduled can be cancelled on the Social
page. A post interrupted mid-publish (a crash) is marked failed rather than retried, because it may
already be live, so check the platform before posting it again.

**Outside input always needs approval.** Social events are untrusted, like email: whatever a
vertical's `policies` say, no outward action a social-triggered task proposes runs on its own;
only brain notes keep their policy (see "Morning brief" above). Comments are shown to the agent between `BEGIN/END SOCIAL MESSAGE` markers, with an
instruction to treat them as data, never as instructions.

### The Social page

The app's **Social** tab lists the configured accounts (platform, handle, vertical, what each can
do; never credentials), recent social events with their tasks, and scheduled posts with their
status. Its composer writes a campaign: one shared text (customisable per platform), a link,
media, the accounts to post to and an optional time. **Send for approval** puts it under
Approvals as a `social.campaign`, like an agent's proposal.

### Media

Instagram and Threads fetch media from a public URL when publishing, so the server hosts uploads:

- `POST /api/media` (admin token): the file as the raw body with its `content-type`, or multipart
  with a `file` field. JPEG, PNG, GIF, WebP, MP4, MOV and WebM, up to `MEDIA_MAX_MB` (default 200).
  It returns `{url, type, ...}`, ready to use as a `media` entry.
- Files are stored in `DATA_DIR/media/` (on the Railway volume) and served at
  `GET /media/<random id>.<ext>` without auth. The 128-bit random name is what keeps them private
  until posted; there is no listing.
- Set **`PUBLIC_BASE_URL`** to the server's public address, e.g.
  `https://command.desktopmachineshop.com`, so the returned URLs are ones the platforms can reach.
  Without it the URL is built from the request's host.

Agents can also use media they found elsewhere by giving its public URL in `media`.

```bash
curl -X POST https://<your-domain>/api/media -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "content-type: image/jpeg" --data-binary @thumbnail.jpg
```

### Accounts

Set `SOCIAL_ACCOUNTS` to a one-line JSON array. Each account:

- `id`: short and stable. It appears in dedupe keys, checkpoints and action payloads, so don't
  rename it once the account is live.
- `platform`: `discord`, `instagram`, `threads`, `x`, `reddit` or `youtube`.
- `vertical`: where its events go and which agents may post as it (`dms`, `3dpandme`, ...).
- `handle`, `displayName` (optional): shown to agents and in the app; `handle` also identifies the
  account's own posts.
- `inbound` (default `true`): watch it for comments, mentions and messages.
- `credentials`: the platform's tokens (see "Social: platform setup"). They are checked at boot by the
  platform's adapter; a problem stops the server with a message naming the account and field,
  never the value.
- `options` (optional): platform settings, e.g. channels or subreddits to watch, and `userId`
  (the account's own platform user id, for skipping its own items).

Placeholder example, one account per platform (spread over several lines here; keep it on one
line in the variable). The exact `credentials` and `options` keys for each platform are listed
under "Social: platform setup" below.

```json
[
  { "id": "dms-discord", "platform": "discord", "vertical": "dms", "handle": "DMS Bot",
    "credentials": { "botToken": "<bot token>" }, "options": { "channelIds": ["<channel id>"], "announceChannelId": "<channel id>" } },
  { "id": "3dp-instagram", "platform": "instagram", "vertical": "3dpandme", "handle": "3dpandme",
    "credentials": { "accessToken": "<long-lived token>", "igUserId": "17841400000000000" } },
  { "id": "3dp-threads", "platform": "threads", "vertical": "3dpandme", "handle": "3dpandme",
    "credentials": { "accessToken": "<long-lived token>", "threadsUserId": "12345678901234567" } },
  { "id": "3dp-x", "platform": "x", "vertical": "3dpandme", "handle": "3dpandme", "inbound": false,
    "credentials": { "apiKey": "<key>", "apiSecret": "<secret>", "accessToken": "<token>", "accessTokenSecret": "<secret>" } },
  { "id": "3dp-reddit", "platform": "reddit", "vertical": "3dpandme", "handle": "u/3dpandme",
    "credentials": { "clientId": "<id>", "clientSecret": "<secret>", "username": "<user>", "password": "<password>",
      "userAgent": "server:com.3dpandme.commandcentre:v0.1.0 (by /u/your_username)" } },
  { "id": "3dp-youtube", "platform": "youtube", "vertical": "3dpandme", "handle": "@3dpandme",
    "credentials": { "clientId": "<id>.apps.googleusercontent.com", "clientSecret": "<secret>",
      "refreshToken": "<refresh token>", "channelId": "UC<22 characters>" } }
]
```

With `SOCIAL_ACCOUNTS` empty or unset, social is off: no polling, no social actions, and the Social
page says so.

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

At `DIGEST_CRON` (default `30 18 * * *`, in `DAY_TIMEZONE`; set `off` to disable; it runs even with
`SCHEDULES_ENABLED=false`, which only turns off vertical schedules) the server writes
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

**Outside input always needs approval.** A task started by an untrusted event (`source` `email`
or `webhook`, or anything other than `chat`, `cron` and `system`) can't auto-execute actions,
whatever the vertical's `policies` say: its proposals are downgraded to `draft` and wait under
Approvals, with `payload.policyDowngrade` saying which policy was overridden and why. So a crafted
email routed to `personal` can't push its own text to your devices through `notify`. The only
exceptions are the internal-only `brain.journal` and `brain.write`, which keep their policy.
Proposals made with the admin token (no task) keep their policy too. (`ActionService.propose` in
`apps/server/src/actions.ts`.)

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

### Odoo events

When Odoo is configured, the server also **polls** Odoo (every 5 minutes by default) and turns
what happened into events. Odoo Online can't run custom modules, so nothing is pushed to the
server.

| Source | What it watches | Event | Default handling |
| --- | --- | --- | --- |
| `orders` | confirmed sales and website orders (`sale.order` in state sale/done) | `order.created` | filed: a journal line and the digest, no agent |
| `messages` | customer chatter messages (`mail.message` of type comment, not by an internal user) on orders, contacts and tickets | `message.received` | agent drafts a reply (`dms-customer-reply`) |
| `tickets` | new Helpdesk tickets (if Helpdesk is installed) | `message.received` | agent drafts a reply |
| `stock` | a storable product's on-hand quantity dropping below its threshold, once per crossing | `stock.low` | agent proposes a reorder note (`dms-ops`) |
| `deliveries` | an outgoing delivery still not done `lateAfterHours` after its scheduled date, once | `delivery.late` | agent drafts an apology (`dms-ops`) |
| `reviews` | submitted ratings and product reviews (`rating.rating`, if installed) | `review.received` | agent drafts a reply (`dms-ops`) |

- **First run:** each source starts from "now" and doesn't replay old records. Progress is kept
  per source in the `odoo_event_checkpoints` table, so restarts carry on where they stopped.
- **Missing apps:** if an app or field a source needs isn't there (no Helpdesk, for example), that
  source logs `odoo-events: <source>: disabled: ...` once and stops. The others keep running.
  Restart the server after installing the app.
- **Untrusted:** Odoo content can come from customers. Tasks from Odoo events never auto-execute
  outward actions: every proposal waits for your approval, whatever the vertical's policy.
- **Digest:** the daily digest of each vertical gets an **Odoo** section, with the order count
  and revenue, customer messages, low-stock items, late deliveries and reviews.

Set `ODOO_EVENTS` to choose what runs. Leave it unset (or `on`) for every source with the
defaults, or set:

- `off` to disable polling;
- a list such as `orders,stock,deliveries`;
- JSON options:

```json
{
  "sources": ["orders", "messages", "tickets", "stock", "deliveries", "reviews"],
  "pollSeconds": 300,
  "lowStockThreshold": 3,
  "useReorderRules": true,
  "websites": { "1": "dms", "3dpandme": "3dpandme" },
  "defaultVertical": "dms",
  "bigOrderThreshold": 500,
  "lateAfterHours": 24,
  "messageTypes": ["comment"],
  "overlapSeconds": 600
}
```

- `pollSeconds`: how often each source is checked (minimum 30).
- `lowStockThreshold`: a product is low when `qty_available` is **below** this. With
  `useReorderRules`, a product's reordering rule (Inventory → Configuration → Reordering Rules)
  with a min quantity above 0 sets its threshold instead. Services and consumables are never low.
- `websites`: maps an Odoo website, by id or by name, to a vertical. Find the ids with the
  `list_websites` tool. Anything else (and records with no website, such as stock) goes to
  `defaultVertical`.
- `bigOrderThreshold`: an order at or above this total (in its own currency) goes to an agent for
  a check, instead of just being filed.
- `lateAfterHours`: grace period after a delivery's scheduled date. Many orders are scheduled for
  the moment they're placed, so `0` would flag nearly every order.
- `messageTypes`: add `"email"` to also catch customers' email replies to Odoo's own mails
  (quotations, order confirmations), if those don't already reach a polled inbox.
- `overlapSeconds`: how far back each poll looks again, for records committed late. Already-seen
  ids are skipped.

## Social: platform setup

Each social account is one entry in the `SOCIAL_ACCOUNTS` JSON array, with
`credentials` (secrets) and `options` (per-platform settings).

### Discord

The Discord account is a **bot user** in your servers. It posts announcements, answers
@mentions and DMs, and can watch support channels.

1. Go to <https://discord.com/developers/applications>, click **New Application** and name it
   (e.g. "Desktop Machine Shop").
2. Under **Bot**:
   - **Reset Token** and copy it. This is `botToken`. Anyone holding it controls the bot, so
     keep it only in `SOCIAL_ACCOUNTS`.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it the
     gateway closes with code 4014 and the server logs
     `disallowed intents (turn on the Message Content intent ...)`. Presence and Server
     Members are not needed. (A bot in fewer than 100 servers doesn't need Discord's approval
     for this intent.)
   - Turn off **Public Bot** if only you should be able to add it to servers.
3. Invite the bot. Under **OAuth2 → URL Generator**, tick the `bot` scope and these
   permissions: View Channels, Send Messages, Send Messages in Threads, Embed Links,
   Read Message History. Or use this URL with your application id:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=274877991936
   ```

   (`274877991936` = View Channels 1024 + Send Messages 2048 + Embed Links 16384 +
   Read Message History 65536 + Send Messages in Threads 274877906944.)
4. Get the ids. In Discord, turn on **User Settings → Advanced → Developer Mode**, then
   right-click a server or channel and choose **Copy Server ID** / **Copy Channel ID**.

What the bot does:

- **Inbound** uses a live Gateway connection (API v10). It turns these into items:
  - @mentions of the bot anywhere in its servers (or only in `guildIds`);
  - DMs to the bot;
  - every message in the `channelIds` watch list. With `respondToMentionsOnly: true`, only
    messages there that mention the bot.

  Messages from bots (including itself) and webhooks are ignored. It heartbeats, resumes
  after drops, and backs off up to 60 s. A bad token (4004) or disallowed intent (4014)
  stops it with an error instead of retrying.
- **Publish** goes to `content.target` (a channel id) or `announceChannelId`. The limit is
  2000 characters. Images are sent as embeds of their public URL (up to 10), and a link is
  appended to the text so Discord unfurls it. User and role mentions ping; `@everyone` and
  `@here` never do.
- **Replies** are threaded Discord replies. **DMs** only reach users who share a server
  with the bot and allow DMs.
- REST calls honour Discord's rate-limit headers and retry 429s after `retry_after`.

```json
{
  "id": "dms-discord", "platform": "discord", "vertical": "dms", "handle": "Desktop Machine Shop",
  "credentials": { "botToken": "<bot token>" },
  "options": {
    "guildIds": ["<server id>"],
    "channelIds": ["<#support channel id>"],
    "announceChannelId": "<#announcements channel id>",
    "respondToMentionsOnly": false
  }
}
```

### Reddit

Reddit posts as **Dave's own account** through a personal "script" app. It submits to
subreddits like r/hobbycnc and r/3Dprinting and answers replies, mentions and messages.

1. **API access.** Since November 2025 Reddit's Responsible Builder Policy requires approval
   before new OAuth apps get API access; self-service access was closed. Existing apps keep
   working. If a new app's token requests fail with `401`/`invalid_grant` even though the
   credentials are right, request access through Reddit's developer support form.
   Personal, low-volume, non-commercial use within the free rate limit is allowed under the
   Data API Terms. Commercial use (for example a business account running at scale, or
   reselling data) needs a separate agreement with Reddit, so keep this to Dave's own
   account posting and replying by hand-approved proposals.
2. Signed in as the posting account, open <https://www.reddit.com/prefs/apps>, click
   **create another app...**, choose **script**, name it (e.g. `commandcentre`), and set the
   redirect uri to `http://localhost:8080` (it's unused). The string under the app name is
   `clientId`; **secret** is `clientSecret`. Only accounts listed as developers of a script
   app can use it.
3. **User-Agent.** Reddit requires `<platform>:<app id>:<version> (by /u/<username>)`, e.g.
   `server:com.3dpandme.commandcentre:v0.1.0 (by /u/3dpandme)`. Generic agents get
   throttled or blocked, and the adapter rejects a `userAgent` without the `(by /u/...)` part.
4. **Two-factor auth.** The script app logs in with the password grant, which doesn't work
   with 2FA. You'd have to append a fresh 6-digit code to the password (`password:123456`),
   which expires in seconds. Use an account without 2FA (a strong unique password, kept only
   in `SOCIAL_ACCOUNTS`), or keep 2FA and accept that inbound/publishing won't work.

What the adapter does:

- **Token:** the password grant (`POST https://www.reddit.com/api/v1/access_token`). The
  token lasts an hour, is cached, and is refreshed 5 minutes early or after a 401.
- **Publish** (`/api/submit`) goes to the subreddit in `content.target` (`hobbycnc` or
  `r/hobbycnc`). `title` is required (300 characters max).
  - With `content.link`, it's a link post; any `text` is added as your first comment (the
    "submission statement" many subreddits require).
  - With an image and no link, it's a link post to the image's public URL. Native image
    upload isn't implemented.
  - Otherwise it's a text post (40,000 characters max).
  - `content.options` may carry `flairId` (the subreddit's flair template id), `flairText`,
    `nsfw`, `spoiler` and `resubmit`.
  - It returns the permalink.
- **Replies** (`/api/comment`) go to a post, comment or message (10,000 characters max).
  **DMs** use `/api/compose`, with the subject `options.dmSubject` or "Message from u/<you>".
- **Inbound** polls `/message/inbox` every 90 s (comment replies, post replies, username
  mentions and private messages) with a fullname cursor. Each poll is 1-3 requests,
  well inside the limit. It never marks anything read, so the Reddit inbox still shows
  what's new. Each item includes the subreddit, the post title and the parent
  comment/post text.
- **Errors:** Reddit's `json.errors` become readable messages:
  - `RATELIMIT` ("take a break for N minutes"): new or low-karma accounts are throttled hard;
  - `SUBREDDIT_NOEXIST`;
  - flair required;
  - `NO_LINKS`/`NO_SELFS`;
  - `ALREADY_SUB`;
  - locked/archived threads.

  The client secret, password and token never appear in errors or logs.
- **Self-promotion:** the adapter only enforces hard API limits; it doesn't know subreddit
  rules. Reddit's guideline is that self-promotion should be a small part of an account's
  activity (the old "10% / 9-in-10" rule). Many subreddits also add their own rules:
  - required flair;
  - self-promo threads or days;
  - no link posts;
  - account age and karma minimums.

  Breaking them gets posts removed and accounts banned. The drafting agents follow the Reddit
  platform skill for this. When a subreddit rejects a post, the reason comes back in the
  failed proposal.

```json
{
  "id": "3dp-reddit", "platform": "reddit", "vertical": "3dpandme", "handle": "u/<username>",
  "credentials": {
    "clientId": "<client id>", "clientSecret": "<secret>",
    "username": "<username>", "password": "<password>",
    "userAgent": "server:com.3dpandme.commandcentre:v0.1.0 (by /u/<username>)"
  },
  "options": { "dmSubject": "Re: your message to 3dpandme" }
}
```

### X

The X adapter **posts only**: single posts, threads, images (up to 4) or one video, and replies
to a post whose URL you paste. It doesn't read mentions, replies or timelines, and it can't send
DMs, so an X account never produces inbox items. It signs requests with **OAuth 1.0a user
context** (four values that don't expire), so there's no token refresh to look after.

**About the free tier.** X's old Free tier (500 posts a month, and 17 posts per 24 hours per user
and per app, with no read access) was closed on 6 February 2026. Recently active Free apps moved
to **pay-per-use** with a one-time $10 credit. New apps are pay-per-use from the start: you buy
credits in the Developer Console, and each request is deducted from them. In October 2026 the
pricing page lists $0.015 per post, or $0.20 for a post that contains a link. A 15-minute limit
of 100 posts per user also applies. When the credits run out, posting fails with a "no API
credits left" error on the proposal; top up and retry. Because posting is all the adapter does,
it never pays for reads.

1. **Create the app.** Go to the developer portal (<https://developer.x.com>, which forwards to
   the Developer Console) **logged in as the X account that will post**, e.g. @3dpandme. Accept
   the developer agreement, then create a **Project** and an **App** inside it. Apps outside a
   Project get 403 errors on v2 endpoints. Add credits if the console asks for them.
2. **Set up user authentication.** In the app, open **Settings → User authentication settings →
   Set up**:
   - **App permissions**: **Read and write**. Direct messages aren't needed.
   - **Type of App**: **Web App, Automated App or Bot**.
   - **Callback URI** and **Website URL**: required by the form but not used by Command Centre.
     Use `https://<your-domain>/` for both, or the business website.
   - Save.
3. **Copy the keys.** On **Keys and tokens**:
   - **API Key and Secret** (also called the Consumer Key and Secret): click **Regenerate** if
     you don't have them saved. These become `apiKey` and `apiSecret`.
   - **Access Token and Secret**: click **Generate**. These belong to the account you're logged
     in as and become `accessToken` and `accessTokenSecret`. Check that the portal says they were
     created with **Read and Write** permissions. If you changed permissions after generating
     them, **regenerate** them: old tokens keep the old permission, and posting fails with 403.

   X shows each secret only once. Regenerating a value invalidates the old one, so update
   `SOCIAL_ACCOUNTS` whenever you regenerate.
4. **A second X account** (e.g. one for DMS and one for 3dpandme): repeat the steps while logged
   in as that account, with its own developer account and app. The portal's **Generate** button
   only makes tokens for the account that owns the app.
5. **Add the account** to `SOCIAL_ACCOUNTS` with `"inbound": false`. `handle` is used to build
   post links:

   ```json
   [
     {
       "id": "3dp-x",
       "platform": "x",
       "vertical": "3dpandme",
       "handle": "3dpandme",
       "inbound": false,
       "credentials": {
         "apiKey": "<API key>",
         "apiSecret": "<API key secret>",
         "accessToken": "<access token, starts with the account's numeric id>",
         "accessTokenSecret": "<access token secret>"
       }
     }
   ]
   ```

What works and what doesn't:
- **Posts**: up to 280 weighted characters. Links count as 23 and emoji as 2. Longer content is
  posted as a thread via `content.options.thread`, and the proposal links the first post.
- **Media**: up to 4 images (5 MB each, with alt text), or one GIF or video. Video is uploaded in
  chunks and the adapter waits for X to process it.
- **Replies**: only to a post you name, by pasting its URL (e.g.
  `https://x.com/someone/status/1849…`) into the task.
- **Not supported**: reading mentions, replies or timelines, and DMs.
- **Errors**: a 429 says when the limit resets. A 403 lists the usual causes: Read-only
  permissions, stale tokens, an app outside a Project, or duplicate text. Credentials never
  appear in error messages or logs.

### Instagram

The adapter uses the **Instagram API with Instagram Login** (Business Login for Instagram) on
`graph.instagram.com`, Graph API **v26.0**. It needs an Instagram **professional** account
(Business or Creator). Unlike the older Facebook Login route, it does **not** need a linked
Facebook Page.

What it does:

- **Publish:** a single image, a carousel (2–20 items, images and videos mixed), or a video. Single
  videos are published as **reels**.
- **Reply:** answers comments. Instagram threads are one level deep, so a reply to a reply goes on
  the top-level comment and starts with `@author`.
- **DMs:** reads and sends direct messages, but only within 24 hours of the user's last message to
  the account.
- **Inbound:** polls every 5 minutes. It picks up new comments and replies on the last 10 posts
  (change this with `options.recentMedia`) and new DMs (turn these off with
  `options.pollDms: false`).

**@mentions** of the account in other people's posts or comments can't be polled with Instagram
Login. Meta only delivers those through the `mentions` **webhook**, which is a later addition. An
@mention in a comment on one of our own posts arrives as an ordinary comment.

1. **Create the Meta app.**
   - Go to <https://developers.facebook.com/apps> → **Create app**.
   - Pick the use case **Manage messaging & content on Instagram** (a Business app).
   - Open **Instagram → API setup with Instagram login**.
   - Under **Generate access tokens**, click **Add account** and log in as the Instagram
     account (for example 3dpandme). If the dashboard asks, first add the account under **App
     roles → Roles** as an Instagram tester. Then accept the invite in the Instagram app.
2. **Permissions** (scopes) to grant:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_messages`

   For DMs, also turn on **Settings → Messages and story replies → Message controls → Connected
   tools → Allow access to messages** in the Instagram app.
3. **Get a long-lived token.** In **Generate access tokens**, click **Generate token** next to the
   account. This gives a long-lived token that lasts 60 days.

   If you'd rather use the OAuth flow:
   - Send the user to `https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages`.
   - Exchange the returned `code` at `POST https://api.instagram.com/oauth/access_token`. This
     gives a short-lived token that lasts 1 hour.
   - Upgrade it to a long-lived token:

   ```bash
   curl "https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=$IG_APP_SECRET&access_token=$SHORT_TOKEN"
   ```
4. **Get the account id** (`igUserId`). Use the `user_id` field from this call, not the `id`
   field:

   ```bash
   curl "https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=$IG_TOKEN"
   ```
5. **Renew the token every ~50 days.**
   - Long-lived tokens expire after **60 days**.
   - You can refresh a token once it is at least 24 hours old and hasn't expired yet:

     ```bash
     curl "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$IG_TOKEN"
     ```

     Put the new `access_token` into `SOCIAL_ACCOUNTS` and redeploy.
   - The adapter also exports `instagramAdapter.refreshCredentials(account, ctx)` (and
     `refreshInstagramToken`). Until the core calls these on a schedule and saves the result,
     set yourself a reminder.
   - An expired token can't be refreshed. The errors then read "Instagram access token has
     expired (code 190, subcode 463)…", and you need to generate a new token (step 3).
6. **App review and limits.**
   - **Access level:**
     - For accounts you own and have added in the App Dashboard, **Standard Access** is
       enough, so no App Review is needed.
     - Advanced Access (with App Review and business verification) is only needed to serve
       other people's accounts.
   - **Publishing:**
     - Meta allows 100 API-published posts per rolling 24 hours. A carousel counts as one post.
     - The adapter checks `content_publishing_limit` before every publish and fails with "content
       publishing limit reached" when you are over.
     - Media containers are capped at 400 per 24 hours.
   - **Other API calls:** up to 4800 × impressions per 24 hours. When Meta throttles a request, the
     error says "rate limited … retry after ~Ns".
   - **Content rules:**
     - Captions: up to 2200 characters, 30 hashtags and 20 @tags.
     - Images: JPEG only.
     - Links in captions aren't clickable. A post's `link` is appended to the caption.

### Threads

The adapter uses the **Threads API** on `graph.threads.com`, version **v1.0**.

What it does:

- **Publish:** text, an image, a video, or a carousel (2–20 items).
  - Posts are up to 500 characters, with at most 5 unique links.
  - On a text-only post, a `link` becomes the link-preview attachment. On a post with media, the
    link is appended to the text.
- **Reply:** replies to any thread, reply or mention through `reply_to_id`.
- **Inbound:** polls every 5 minutes.
  - It picks up replies, including nested ones, on the account's last 10 threads. Change this
    with `options.recentThreads`.
  - It also picks up **mentions** of the account. Turn these off with
    `options.pollMentions: false`.
- **DMs:** Threads has no DM API.

1. **Create the Meta app.**
   - Create an app with the use case **Access the Threads API**. It can be the same Meta
     developer account as the Instagram app, but it is a separate app.
   - Under **App roles → Roles**, add the Threads account as a **Threads Tester**.
   - Accept the invite in the Threads app, under **Settings → Account → Website permissions →
     Invites**.
2. **Permissions** to grant:
   - `threads_basic`
   - `threads_content_publish`
   - `threads_read_replies`
   - `threads_manage_replies`
   - `threads_manage_mentions`
3. **Get a long-lived token.**
   - **Easiest:** use the dashboard's **User Token Generator** (Threads use case → settings).
   - **Or the OAuth flow:**
     - Authorize at `https://threads.net/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_mentions`.
     - Exchange the `code` at `POST https://graph.threads.com/oauth/access_token`. This gives a
       short-lived token that lasts 1 hour.
     - Upgrade it to a long-lived token:

     ```bash
     curl "https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret=$THREADS_APP_SECRET&access_token=$SHORT_TOKEN"
     ```
4. **Get the user id** (`threadsUserId`):

   ```bash
   curl "https://graph.threads.com/v1.0/me?fields=id,username&access_token=$THREADS_TOKEN"
   ```
5. **Renew the token every ~50 days.**
   - Long-lived tokens last **60 days**. You can refresh one once it is at least 24 hours old and
     hasn't expired yet:

     ```bash
     curl "https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token&access_token=$THREADS_TOKEN"
     ```
   - The adapter exports `threadsAdapter.refreshCredentials(account, ctx)` and
     `refreshThreadsToken`.
   - An expired token has to be generated again.
6. **App review and limits.**
   - **Without App Review** (testers only), publishing and replies work for your own account.
     Mentions are the exception: without **Advanced Access** for `threads_manage_mentions`, the
     mentions endpoint only returns mentions made by the app's testers. To see mentions from the
     public, submit that permission for App Review.
   - **Posting:** Meta allows 250 posts and 1000 replies per rolling 24 hours. The adapter checks
     `threads_publishing_limit` before each post.
   - **Other API calls:** up to 4800 × impressions per 24 hours per app and user. Impressions
     count as at least 10.

### YouTube

The adapter uses the **YouTube Data API v3** for one channel (e.g. 3dpandme, or a channel for
OpenV / OpenD videos), with OAuth 2.0 and a refresh token.

What it does:

- **Publish:** uploads one video per post with the resumable upload protocol. The file is
  streamed from its `MediaRef` URL in 8 MiB chunks, so large videos aren't held in memory, and
  a dropped chunk or a 5xx is resumed rather than restarted.
  - `content.title` is the video title (required, at most 100 characters, no `<` or `>`).
  - `content.text` is the description, with `content.link` added on its own line. The limit is
    5000 **bytes** (UTF-8), so emoji and accented letters count for more than one.
  - `content.options`:
    - `privacyStatus`: `private` (the default), `unlisted` or `public`. Nothing goes public
      unless the post says so.
    - `publishAt`: an ISO time for YouTube's own scheduling. It needs `privacyStatus: "private"`
      (or no `privacyStatus`); YouTube makes the video public at that time. This is different from
      a campaign's `publishAt`, which decides when Command Centre uploads.
    - `tags` (500 characters in all, counting commas, and quotes around tags with spaces),
      `categoryId` (e.g. `"28"` Science & Technology, `"26"` Howto & Style; the account's
      `options.defaultCategoryId` is used when it's missing), `madeForKids` (default `false`),
      `notifySubscribers` (default `true`), `containsSyntheticMedia`, `defaultLanguage`.
    - `thumbnailUrl`: a JPEG or PNG at a public URL, set with `thumbnails.set` after the upload.
      Custom thumbnails need a verified channel. If setting the thumbnail fails, the upload still
      counts as published and the server logs why; set the thumbnail in YouTube Studio.
  - It returns `https://youtu.be/<id>`.
  - **Shorts:** there's no separate API. A square or vertical video up to 3 minutes long is a
    Short. Adding `#Shorts` to the title or description is optional.
- **Reply:** answers a comment or a reply with `comments.insert`. YouTube threads are one level
  deep, so a reply to a reply goes on the thread and starts with the author's `@handle`.
- **Inbound:** polls `commentThreads.list` with `allThreadsRelatedToChannelId` every 15 minutes
  (set `SOCIAL_YOUTUBE_POLL_SECONDS` to change it, minimum 60) for new top-level comments and
  replies on the channel's videos. Each item has the video link and title. The channel's own
  comments are skipped. The first poll only notes what's there. Each poll scans the newest
  `options.pollPages` pages of threads (default 2, 100 threads each, 1 quota unit a page), plus
  one `comments.list` call for a thread whose reply count went up but whose new replies YouTube
  left out of the listing. A new reply on a very old thread that is further down than those pages
  isn't seen. Comments held for review appear once you approve them, if that is within 15 minutes;
  otherwise answer them from YouTube Studio.
- **DMs:** YouTube has none.
- **Errors:**
  - `quotaExceeded` says the project's daily quota is used up and resets at midnight Pacific
    Time.
  - `uploadLimitExceeded` is the channel's own upload limit, not API quota.
  - Disabled comments, an invalid `publishAt`, a missing scope or a revoked refresh token each
    get their own message.
  - The client secret, refresh token, access tokens and upload session ids never appear in
    errors or logs.

**Quota.** Checked in October 2026 against Google's quota pages (updated 2026-10-15):

- Since 1 June 2026, `videos.insert` and `search.list` each have **their own quota bucket**, by
  default **100 calls a day**, at 1 unit per call. So an upload no longer eats about 1,600 of the
  10,000 general units (that was the old cost; it fell to about 100 in December 2025 before the
  separate bucket).
- Everything else shares **10,000 units a day** per Google Cloud project:
  - `thumbnails.set`: 50;
  - `comments.insert` (a reply): 50;
  - `commentThreads.list`, `comments.list` and `videos.list`: 1 each.
- Quotas reset at midnight Pacific Time. Polling every 15 minutes costs roughly 200–300 units a
  day, which leaves plenty for replies.
- Usage is under **APIs & Services → YouTube Data API v3 → Quotas** in the Cloud console. More
  quota needs the YouTube API Services audit and quota extension form.

**The private-lock audit caveat.** In July 2020 YouTube said videos uploaded through an
unverified API project created after 28 July 2020 would be locked **private** until the project
passed an API compliance audit, and the creator would get an email about it. Since then:

- In October 2026, the `videos.insert` and `videos` reference pages (updated 2026-10-15) say
  instead: "Videos uploaded from unverified API projects are not restricted to private viewing
  mode."
- The revision history has no entry recording that change, and third-party guides from mid-2026
  still describe the lock.

So test it once. Upload a short video with `privacyStatus: "unlisted"`. If YouTube still makes it
private, the adapter logs "uploaded as unlisted but YouTube made it private ... compliance audit",
and you need to apply for the audit (YouTube API Services → Audit and Quota Extension Form). Until
then, publish videos by hand in YouTube Studio. Because the default is `private` and Dave publishes
or schedules deliberately, the lock doesn't affect the default flow.

1. **Create the Google Cloud project.**
   - Go to <https://console.cloud.google.com/> and create a project, e.g. `command-centre-youtube`.
     Use one project for all your channels, or one per brand if you want separate quotas.
   - Open **APIs & Services → Library**, search for **YouTube Data API v3**, and **Enable** it.
2. **Set up the OAuth consent screen** (**Google Auth Platform → Branding / Audience / Data
   access**):
   - **User type: External** (a personal Google account can't use Internal). Fill in the app name
     (e.g. "Command Centre") and the support email.
   - **Data access → Add or remove scopes**:
     - `https://www.googleapis.com/auth/youtube.upload` for uploads and thumbnails;
     - `https://www.googleapis.com/auth/youtube.force-ssl` for reading comments and replying.
   - **Audience:** add the Google account that owns the channel as a **test user**, then click
     **Publish app** to move it to **In production**. While the app is in **Testing**, Google
     expires refresh tokens after **7 days**, and the adapter starts failing with `invalid_grant`.
     An unverified app in production works for your own account: you click through a "Google
     hasn't verified this app" warning once, during step 4. Verification by Google is only needed
     to serve other people.
3. **Create the OAuth client.** **Google Auth Platform → Clients → Create client**, type **Desktop
   app**, named e.g. `youtube-auth`. Copy the **Client ID** and **Client secret**. These become
   `clientId` and `clientSecret`.
4. **Get the refresh token.** On a computer with a browser (not the server), in the repo:

   ```bash
   YT_CLIENT_ID=<client id> YT_CLIENT_SECRET=<client secret> pnpm --filter @cc/social youtube:auth
   ```

   - It prints a Google sign-in URL and waits on `http://127.0.0.1:<random port>`.
   - Open the URL and sign in as the account that owns the channel. For a Brand Account channel,
     pick the channel when Google asks. Tick **both** permissions.
   - It prints the **refresh token**, the **channel id** (`UC...`, from `channels.list?mine=true`)
     and a ready-made `SOCIAL_ACCOUNTS` entry.
   - The flow uses PKCE, `access_type=offline` and `prompt=consent`, so Google always returns a
     refresh token. `YT_LOGIN_HINT=<email>` pre-selects the account.
   - Each run makes a new refresh token. Google keeps at most 100 per account and client, and drops
     the oldest beyond that.
5. **Add the account** to `SOCIAL_ACCOUNTS`. Set `handle` to the channel's `@handle`; it is shown
   to agents and used to skip the channel's own comments, along with `channelId`.

   ```json
   {
     "id": "3dp-youtube",
     "platform": "youtube",
     "vertical": "3dpandme",
     "handle": "@3dpandme",
     "credentials": {
       "clientId": "<id>.apps.googleusercontent.com",
       "clientSecret": "<client secret>",
       "refreshToken": "<refresh token from youtube:auth>",
       "channelId": "UC<22 characters>"
     },
     "options": { "defaultCategoryId": "28", "pollPages": 2 }
   }
   ```

   For the OpenV and OpenD channels, add one entry each with their own `refreshToken` and
   `channelId`, in their verticals. They can share the client id and secret.
6. **Revoking:** remove access at <https://myaccount.google.com/permissions>, or delete the OAuth
   client. Then run step 4 again.

### Media hosting (Instagram and Threads)

Instagram and Threads don't accept uploads from us. Meta fetches each image or video **from a
public URL** (`image_url` / `video_url`), so every `MediaRef.url` must be reachable from the
internet over HTTPS. The Command Centre server hosts uploaded media at unguessable public URLs
for this. Don't point it at `localhost` or a private network.

### Example `SOCIAL_ACCOUNTS` entries

```json
[
  {
    "id": "3dp-instagram",
    "platform": "instagram",
    "vertical": "3dpandme",
    "handle": "3dpandme",
    "credentials": { "accessToken": "<IG_LONG_LIVED_TOKEN>", "igUserId": "<IG_USER_ID>" },
    "options": { "recentMedia": 10, "pollDms": true }
  },
  {
    "id": "3dp-threads",
    "platform": "threads",
    "vertical": "3dpandme",
    "handle": "3dpandme",
    "credentials": { "accessToken": "<THREADS_LONG_LIVED_TOKEN>", "threadsUserId": "<THREADS_USER_ID>" },
    "options": { "recentThreads": 10, "pollMentions": true }
  }
]
```

Set `handle` to the account's username. The adapters use it, along with the account id, to skip
the account's own comments and replies.

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
