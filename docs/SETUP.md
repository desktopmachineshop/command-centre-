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
3. **Add a volume** to the server, mounted at `/data`. It holds the brain's git mirror, agent
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

## Accounts page (sign-ins for every platform)

**Accounts** (sidebar → System → Accounts; on the phone **More → Accounts**) is where every
platform sign-in lives: Claude, the Anthropic API, Jev, OpenAI, ElevenLabs, Odoo, email inboxes,
Google (Calendar and Drive), Instagram, Threads, X, Reddit, YouTube and Discord. Saving applies
straight away; only the changed integration restarts, and nothing redeploys.

- **Secrets are encrypted** in the database (AES-256-GCM). The key is generated into
  `DATA_DIR/credentials.key` on the Railway volume the first time, or set `CREDENTIALS_KEY`
  (64 hex characters, `openssl rand -hex 32`) to keep it in Railway instead. The page only
  ever shows `••••1234`; leave a secret field blank when editing to keep what's stored.
- **Values already in Railway** show as *From Railway*. Press **Move into app** (or just
  **Edit**), check it still works, then delete the variable from Railway.
- **Test** checks a sign-in against the real service and records the result on the card.
- **Connect** buttons sign in with the platform instead of pasting tokens. Each needs a one-time
  developer app (the **Developer apps** section on the page). Register these redirect addresses,
  using your `PUBLIC_BASE_URL` (e.g. `https://command.desktopmachineshop.com`):

  | Platform | Developer app | Redirect address |
  |---|---|---|
  | Google (Calendar + Drive) | Google Cloud Console → Credentials → OAuth client, type **Web application** | `/oauth/google/callback` |
  | Gmail inbox | the same Google client (enable the **Gmail API**) | `/oauth/gmail/callback` |
  | YouTube | the same Google client (enable YouTube Data API v3) | `/oauth/youtube/callback` |
  | Instagram | Meta app → Instagram → API setup with Instagram login → Business login settings | `/oauth/instagram/callback` |
  | Threads | Meta app → Threads use case → Settings | `/oauth/threads/callback` |
  | X | developer.x.com → app → User authentication settings: OAuth 1.0a, Read and write | `/oauth/x/callback` |
  | Reddit | reddit.com/prefs/apps → create a **web app** | `/oauth/reddit/callback` |
  | Outlook / Hotmail | Azure portal → Microsoft Entra ID → App registrations → New registration: *Accounts in any organizational directory and personal Microsoft accounts*, platform **Web**. Then Certificates & secrets → New client secret (copy the **Value**), and API permissions → Add → APIs my organization uses → **Office 365 Exchange Online** → Delegated → `IMAP.AccessAsUser.All` and `SMTP.Send`, and **Microsoft Graph** → Delegated → `Mail.Send` (sending) | `/oauth/microsoft/callback` |

  Google: set the consent screen to **In production**, or the sign-in expires after 7 days.
  The old desktop-type client from `google:auth` can't be used for Connect; create a Web
  application client (the old refresh token keeps working until you reconnect).
- **Instagram and Threads** tokens last 60 days. The server renews them every night once they
  have under 15 days left, and sends an alert if renewal fails or a week is left.
- **Claude:** press **Connect** on the Claude card (works from the phone). The server runs
  `claude setup-token`; open the sign-in link, sign in to claude.ai, and paste the code it shows
  back into the dialog. The token is saved encrypted and agents switch from `echo` to
  `claude-code`. Alternatively run `claude setup-token` on a computer and use **Paste a token**.
- **Stays in Railway:** `DATABASE_URL`, `ADMIN_TOKEN`, `WORKER_TOKEN`, `WEBHOOK_SECRET`,
  `PUBLIC_BASE_URL`, the push (`VAPID_*`) keys, `BRAIN_REMOTE_URL` and `CREDENTIALS_KEY`: the server
  needs them before it can read the database. The page lists them read-only.
- Every change is recorded (who, what, when) in the `integration_audit` table.
- Switching **file storage** between the volume and Drive takes effect after the next restart
  (Railway → server → Restart); a new Google sign-in for Drive applies at once.

Agents never see these credentials: the Claude process gets only its own token and basic system
variables, not the server's environment.

The env-var instructions in the sections below still work and are the fallback.

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

Open **https://command.desktopmachineshop.com** on your phone and sign in with your email and
password (and the code from your authenticator app, if two-factor is on). You stay signed in for
30 days from the last time you used it. No token is stored on the phone; the session is an
HttpOnly cookie.

### Install on Android

1. In Chrome, tap **Install** on the "Install Command Centre" card at the top of the Inbox, or
   **More → Install app**, or **Settings → App → Install app**. If none of these show, use
   Chrome's **⋮ → Install app** (or **Add to Home screen → Install**).
2. Chrome builds a real Android app (a WebAPK). It appears in the app drawer and in
   **Settings → Apps** as "Command Centre", opens full screen with no browser bar, and handles
   links to the domain. If you only get a home-screen shortcut with a small Chrome badge, it
   wasn't installed as an app. Remove it, update Chrome, and try again.
   **No padlock, no install:** Chrome only installs from a page with a valid HTTPS certificate.
   If the address bar says "Not secure", or Settings → App says it can't install, fix the
   certificate first. In Railway → server → Settings → Networking, the custom domain must show
   a valid certificate. With Cloudflare, the simplest setup is the `command` record **Proxied**
   (orange cloud) with SSL/TLS mode **Full**.
3. Long-press the icon for shortcuts: **Approvals**, **Chat**, **Today** and **Drive mode**.
4. Open the app once and sign in again if asked. Then turn on push: **Notifications →
   Notification settings → Enable on this device**, and allow notifications when Android asks.

The app updates itself: new versions load the next time it opens. To remove it, uninstall it
like any other app.

### iPhone

Safari → Share → **Add to Home Screen**. The home-screen app keeps its own cookies, separate
from Safari, so sign in once more inside it. Push notifications on iPhone only work from the
home-screen app (see "Notifications").

### On a PC

Chrome or Edge shows an install icon in the address bar, or use **Settings → App → Install app**.

The icons are generated from `apps/web/public/icon.svg`. After changing the logo, run
`node apps/web/scripts/icons.mjs`.

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
| `browser`      | `chromiumBin` (or `CC_CHROMIUM_BIN`) points at Chromium/Chrome that exists            |

To force one on or off, add to `worker.json`, then use **Worker on** to restart the worker:

```json
{ "capabilities": { "gpu": true, "davinci": false } }
```

Other `worker.json` keys: `ffmpegBin` and `claudeBin` (full paths, if they're not on `PATH`),
`workDir`, and `claudeDirs`, the folders `claude.local` jobs may use as their working directory
(besides the work dir). For video: `chromiumBin` (the browser `video.capture` drives) and
`captureProfiles` (`{ "opend-demo": "C:\\...\\opend-demo.json" }`, Playwright storage states for
signed-in captures).

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
- `video.capture` `{spec, scenes?, uploads?}` (needs `browser`): records a VideoSpec's capture
  scenes with Playwright. The result is `{clips: {<scene>: {path, trimStartSec, durationSec, url?}}}`.
- `video.render` `{spec, assets?, voice?, captureInline?, encoder?, upload?}` (needs `ffmpeg`;
  NVENC on `gpu` nodes): voices, captions and composes the video. The result is
  `{outputPath, bytes, durationSec, width, height, encoder, captionsPath, url?}`.
  See [VIDEO.md](VIDEO.md).

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

The brain is the agents' long-term memory: markdown notes with YAML frontmatter, stored in the
server's Postgres (tables `brain_notes` and `brain_note_versions`). There is nothing to set up.

- **Edit in the app:** More → **Brain**. Search, open a note, **Edit** (the whole file,
  frontmatter included), **New note**, **Delete**. Saves are live for agents straight away.
- **History:** every save and delete is kept with who made it (you, an agent, `system`). Open
  **History** on a note to view an old version or **Restore** it. A deleted note can be brought
  back by recreating it at the same path and restoring from its history.
- **Conflicts:** if an agent saves a note while you are editing it, your save is refused rather
  than overwriting theirs; load the latest and make your change again.
- **Search** is Postgres full-text (English stemming, so "spindles" finds "spindle"), ranking
  title and path over frontmatter over body.

### Git mirror (optional): backup and Obsidian

Set `BRAIN_REMOTE_URL` to a private repo and the server keeps a copy of the brain there:

1. Create an empty private repo, e.g. `desktopmachineshop/brain`.
2. Create a fine-grained GitHub token with *Contents: read & write* on that repo only.
3. Set `BRAIN_REMOTE_URL=https://x-access-token:<token>@github.com/desktopmachineshop/brain.git`.

- **One way only.** About a minute after the last change, the server commits the whole brain to
  the repo and pushes. Open a clone as an **Obsidian** vault to read it, but **edit in the app**:
  edits made in the repo are replaced by the next mirror (they stay in the repo's git history).
- **Import:** on the first boot with an empty database brain, the server imports every note from
  the repo (author `import`). This is how an existing git brain moves into Postgres; it runs once.
- If the repo can't be reached at boot, the server logs it and runs without the mirror.

### Use the brain from other agents

The brain is also an MCP server, so Claude Code or Claude Desktop on your PC can share the same
memory:

```bash
claude mcp add --transport http brain https://<your-domain>/mcp/brain \
  --header "Authorization: Bearer <ADMIN_TOKEN>"
```

Or run it locally over stdio: `DATABASE_URL=<postgres url> pnpm --filter @cc/brain mcp` for the live
brain, or `BRAIN_DIR=~/brain pnpm --filter @cc/brain mcp` against a clone of the git mirror.

## Email

> **Gmail / Google Workspace:** Accounts page → Business → **Gmail inbox → Add → Connect**. Sign
> in and allow "Read, compose, send and permanently delete all your email": nothing to paste, no
> app password. It reads over IMAP and sends through the Gmail API with that one sign-in (so
> Railway's SMTP block doesn't matter). Needs the one-time Google OAuth client (Developer apps)
> with the **Gmail API** enabled and `/oauth/gmail/callback` among its redirect URIs. Google shows
> "this app isn't verified" for a private app: Advanced → Continue.
> **Other mailboxes:** Accounts page → Business → Other email inbox (Gmail app-password preset
> still there).
> **Sending on Railway:** Railway blocks outgoing SMTP below the Pro plan, so replies can't go
> out over SMTP there. Gmail inboxes send through the **Gmail API** instead: also connect the same
> address under Accounts → Google (Add account → Connect; the sign-in asks to "send email on your
> behalf"). In Google Cloud Console enable the **Gmail API** for the project. The inbox's "Send
> replies with" setting is `auto` by default, so it switches over by itself. Reading still uses
> the app password. Outlook / Hotmail inboxes always send through **Microsoft Graph**.
> **Outlook.com / Hotmail / Live / Microsoft 365:** Microsoft no longer accepts passwords or app
> passwords for IMAP and SMTP, so use Accounts page → Business → Outlook / Hotmail inbox →
> Connect (after the one-time Microsoft app; see "Accounts page"). It reads over IMAP
> (outlook.office365.com) and sends over SMTP (smtp-mail.outlook.com, or smtp.office365.com for
> work accounts) with OAuth; Microsoft files sent mail in Sent itself.
> The variables below are the alternative.


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
- **Filing (Gmail inboxes connected with Google):** agents label each email they handle and move
  it out of the inbox when nothing is left for you, with `email.label` (`labels`, up to 5 names,
  created if missing; `archive` takes the conversation out of the inbox, like Gmail's Archive).
  On the email that started the task it runs straight away (`auto`). A reply can carry `labels`
  and `archive` too, and the conversation is filed once the reply is sent. The label scheme is
  in the `email-triage-and-reply` skill, or your own in the brain note
  `<vertical>/email-labels.md`. Inboxes signed in with a password, and Outlook, can't be filed.
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

> **Easiest:** Accounts page → Social → Add account → Connect. The variables below are the alternative.


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
- Files are stored in `DATA_DIR/media/` (on the Railway volume), or in Google Drive with
  `STORAGE_BACKEND=gdrive` (see "Storage (Google Drive)"), and served at
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

## Storage (Google Drive)

> **Easiest:** Accounts page → Google → Connect, then Settings → File storage → gdrive. The variables below are the alternative.


The Railway volume is small, so large files (raw footage, video renders, media uploads,
generated assets, big attachments) can live in **your Google Drive** instead
(`packages/storage`). One `BlobStore` interface has two backends:

- **`local`** (the default): files stay on the volume, exactly as before. `media` is
  `DATA_DIR/media/`, other folders are `DATA_DIR/storage/<folder>/`.
- **`gdrive`**: new files go to a **Command Centre** folder in your My Drive, with the subfolders
  `media`, `renders`, `footage`, `attachments` and `assets`. The folders are created on first use
  and their ids are remembered in Postgres.

Postgres keeps a small index (`storage_files`, migration `0011_storage`) that maps each public id
to its Drive file id (or its local file), with its name, size, type, folder and creation time.

### What stays the same

- **Public media URLs stay on our domain.** `GET /media/<32 hex>.<ext>` behaves as before:
  - it returns the right content type, `nosniff` and byte ranges;
  - there is no listing;
  - unknown ids get a 404.

  The server streams the bytes from the cache, or else from Drive. Drive links are never handed
  out: Instagram and Threads can't fetch Drive share links, and the file stays private in your Drive.
- **Files already on the volume keep working.** At boot, files in `DATA_DIR/media` are added to
  the index and served from the volume. To move them to Drive, see "Migrating" below.

### Set it up

1. **Enable the Google Drive API** in the same Google Cloud project as Calendar (the PA setup):
   *APIs & Services → Library → Google Drive API → Enable*.
2. **Scope.** The app asks for `https://www.googleapis.com/auth/drive.file`. With it, the app can
   only see files it created itself, never the rest of your Drive. Google classes it as
   **non-sensitive**. For an app for personal use (fewer than 100 users), verification is not
   required. Set the OAuth consent screen's publishing status to **In production**: in
   **Testing**, refresh tokens expire after 7 days.
3. **Credentials.** A single `google:auth` run (from the PA setup) grants both the Calendar scopes
   and `drive.file`, and prints `GOOGLE_REFRESH_TOKEN`. If you authorised Calendar before Drive
   was added, run it again so the token covers Drive too.
4. **Set the variables** on Railway:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `STORAGE_BACKEND` | `local` | `gdrive` to store new files in Drive. It needs the three `GOOGLE_*` variables, or the server refuses to boot. |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | | The same OAuth client and token as Calendar. |
   | `STORAGE_CACHE_MB` | `2048` | The LRU cache of Drive files on the volume (`DATA_DIR/cache`). `0` turns it off. |
   | `STORAGE_DRIVE_FOLDER` | `Command Centre` | Name of the top-level Drive folder. |
   | `STORAGE_UPLOAD_MAX_MB` | `20480` | Largest direct upload. |
   | `MEDIA_MAX_MB` | `200` | Largest `POST /api/media` upload (unchanged). |

### The cache and its size

- The first fetch of a Drive file streams it from Drive, honouring any byte range. The same fetch
  also downloads the whole file into `DATA_DIR/cache` in the background.
- Meta and YouTube often fetch the same media several times, and those repeat fetches are then
  served from the volume.
- When the cache is full, the least recently read file is evicted first.
- A single file larger than a quarter of the cap is never cached, so one big render can't flush
  everything else.
- **Sizing:** leave room on the volume for the brain, the agent workspaces and the cache.
  - On a 5 GB volume, 1024 to 2048 MB is sensible.
  - The cache only needs to hold what is being published this week; everything is still in Drive.

### Direct uploads (large files)

Big files don't pass through `POST /api/media`. Upload them directly instead:

1. **Start a session.** Call `POST /api/storage/upload-session` (session cookie or admin token)
   with `{name, contentType, size, folder?}`. It returns
   `{id, uploadUrl, chunkSize, backend, url}`.
   - With `gdrive`, `uploadUrl` is a Drive resumable session URI. The bytes go straight to
     Google, and the URI only allows uploading that one file.
   - With `local`, `uploadUrl` is our own chunk endpoint (`PUT /api/storage/uploads/<id>?key=…`).
     It speaks the same protocol, so clients don't need to know which backend is in use.
2. **Upload the bytes.** PUT them in chunks of `chunkSize` (a multiple of 256 KiB; only the last
   chunk may be smaller), with `Content-Range: bytes a-b/total`.
   - A `308` reply's `Range` header says where to continue.
   - After an error, an empty PUT with `Content-Range: bytes */total` asks how much arrived.
3. **Register the file.** Call `POST /api/storage/complete` with `{id}`. The server checks with
   Drive (or the volume) that every byte arrived, then returns the file and its public `/media`
   URL. For types that `/media` doesn't serve (e.g. a PDF attachment), `url` is `null`.

**Desktop workers** use `POST /api/worker/storage/upload-session` and
`POST /api/worker/storage/complete` with `Authorization: Bearer <WORKER_TOKEN>`.
- A worker can only upload, into `renders`, `media`, `footage` or `assets`. It can't list, read
  or delete files.
- In a job handler, call `ctx.storage.uploadFile(path, {folder})`
  (`apps/worker/src/storage.ts`). It does all three steps, resumes after failures, and returns
  `{id, url, size}`.
- `ffmpeg.run` with `"upload": true` (and optionally `"uploadFolder"`) uploads its output and
  returns `url` in the job result.

### Seeing what's stored

`GET /api/storage` (`?folder=`, `?limit=`) lists files with their URLs and shows:
- usage per folder;
- cache statistics;
- with Drive, `drive.folderUrl`, a link to open the Command Centre folder in Drive, and your
  Drive quota.

`DELETE /api/storage/<id>` deletes a file from Drive, the cache and the index.

### Migrating local media into Drive

After switching to `gdrive`, call `POST /api/storage/migrate` with `{"deleteLocal": true}`:
- Every local file is copied into Drive under the **same id**, so URLs already posted keep working.
- With `deleteLocal`, each local copy then moves into the cache (or is deleted if it doesn't fit),
  freeing the volume.
- Without `deleteLocal`, it only copies.
- The call is safe to run again: files that are already in Drive are skipped.

### Drive quota and limits

- **Storage quota.** A free Google account has 15 GB, shared between Drive, Gmail and Photos.
  Raw footage fills that quickly, so a Google One plan is worth having if you keep footage. Files
  count against **your** quota, because the app creates them in your Drive.
- **Upload limits.** Drive accepts up to 750 GB of uploads per user per day, and files up to 5 TB.
- **Rate limits.** Requests are limited per minute. The store retries 429, 5xx and rate-limit 403
  responses with exponential backoff, as Google recommends.
- **Resumable sessions.** A session URI expires after a week. An expired session must be started
  again.

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
brain note at `<brainFolder>/digests/YYYY-MM-DD.md`. Each business with something to report gets
its own push with its headline numbers; tapping it opens that business's digest note in the Brain. Just after midnight the notes are rewritten, without a push, so that they cover the
whole day. The Inbox's **Today** card shows the same numbers live. Any day's digest is at
`GET /api/digest?date=YYYY-MM-DD&vertical=dms` (both parameters optional).

## Morning brief

The Chief of Staff (the org root, `packages/verticals/src/org.ts`, running in the personal vertical) has a
weekday 07:00 (Europe/London) `morning-brief` schedule. The agent:

1. reads today's calendar, the reminders due today (and overdue ones) and the top to-dos, through
   the `pa` tools (see "Personal assistant" below);
2. reads yesterday's digests and journal (Friday to Sunday on a Monday);
3. lists pending approvals;
4. works out today's priorities;
5. sends you a short `briefing` push through a `notify` action (see "Notifications").

There is also a Sunday-to-Thursday 21:00 `evening-wrap` on the personal vertical's Calendar &
Reminders role (`packages/verticals/src/personal.ts`): tomorrow's calendar, open reminders and
to-dos, and what's waiting for approval, in one push.

`notify` is `auto-with-digest` for the personal vertical, so the brief arrives without an approval
step and is listed in that evening's digest.

**Outside input always needs approval.** A task started by an untrusted event (`source` `email`
or `webhook`, or anything other than `chat`, `cron` and `system`) can't auto-execute actions,
whatever the vertical's `policies` say: its proposals are downgraded to `draft` and wait under
Approvals, with `payload.policyDowngrade` saying which policy was overridden and why. So a crafted
email routed to `personal` can't push its own text to your devices through `notify`. The only
exceptions are the internal-only `brain.journal` and `brain.write`, which keep their policy, and
`email.label` on the very email that started the task (same account and Message-ID): filing it
only touches your own mailbox. Labelling any other message from such a task waits for approval.
Proposals made with the admin token (no task) keep their policy too. (`ActionService.propose` in
`apps/server/src/actions.ts`.)

The brief is **off by default**. To turn it on, set `enabled: true` on the `morning-brief` line in
`packages/verticals/src/org.ts` and redeploy; the same goes for the `evening-wrap` line in
`packages/verticals/src/personal.ts`. Each is an agent run, so it counts towards the budgets.

## Personal assistant

`packages/pa` gives every vertical's agents a `pa` MCP server (`/mcp/pa`) for reminders and to-do
lists, and the personal vertical a Google Calendar. The app's **Today** tab shows the day's agenda,
the reminders due and your lists.

### What it can do

- **Reminders.** "Remind me to call the garage at 4pm", "every weekday at 08:00 remind me to…".
  They are stored in Postgres and pushed to your devices when due, by a job that checks every
  minute. One-off reminders stay open (marked *sent*) until you tick them off. Recurring ones
  (`daily`, `weekdays`, `weekly:mon,thu`, `monthly:15`, or the RRULE forms `FREQ=DAILY`,
  `FREQ=WEEKLY;BYDAY=…`, `FREQ=MONTHLY;BYMONTHDAY=n`) move to their next occurrence and keep
  their local time through the clock changes. If the server was down, you get one alert, not a
  backlog. The push has **Done** and **Snooze 1h** buttons (signed links, so they work from the
  lock screen without signing in); the Today page has the same. Reminders go through the
  notification system as category `reminder` at `high` priority (see "Notifications" for quiet
  hours and per-category settings); a revoked calendar token is an `alert`.
- **Lists.** "Add milk and eggs to shopping", "put swimming bag on the Noah list". Lists (today,
  shopping, home, Noah…) are created as they are used, and are per vertical. On the Today page you
  tick items off, add, remove and rename.
- **Calendar.** "What's on Thursday?", "when am I free next week?", "book the dentist next week".
  Agents read events (recurring ones expanded) and free/busy across all your configured calendars.
  To create, move or delete an event they propose `calendar.create`, `calendar.update` or
  `calendar.delete`, which wait under Approvals (`draft` policy), whatever else is going on. Event
  reminders can be set per event (`reminders: [{method: "popup", minutes: 60}]`, `"default"` or
  `"none"`).
- **Who may write.** Reminders and list items are internal, so a task you started (Chat) or a
  schedule writes them straight away. A task started by outside input (email, webhook, social)
  can't: its reminders and list changes become `pa.*` proposals that wait for your approval.
- The **Today** tab's box sends what you type to the assistant in Chat, so it understands
  "remind me…" and "add … to …" the same way.

Without `CALENDAR_ACCOUNTS`, reminders and lists still work; the calendar tools say no calendar is
connected.

### Google Calendar

> **Easiest:** Accounts page → Google → Add account → Connect, then Calendars. The variables below are the alternative.


Do this once, on your PC. The same OAuth client and refresh token are shared with Google Drive
storage, so one run of `google:auth` covers both.

1. **Cloud project.** At <https://console.cloud.google.com/> create a project (e.g. "Command
   Centre"). Under **APIs & Services → Library**, enable the **Google Calendar API** (and the
   **Google Drive API**, for Drive storage).
2. **Consent screen** (**Google Auth Platform → Branding / Audience**, called "OAuth consent
   screen" in older consoles). App name "Command Centre", your email as support and developer
   contact.
   - If your calendar is on Google Workspace (e.g. `@desktopmachineshop.com`), choose **Internal**:
     no verification, no test users, and tokens don't expire after 7 days.
   - For a personal `@gmail.com` account, choose **External** and add yourself under
     **Test users**. **Important:** while the app's publishing status is **Testing**, Google
     expires refresh tokens after 7 days
     ([Google: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
     Once it works, press **Publish app** (status "In production"). You don't need to submit it
     for verification for your own use: when you sign in, Google shows "Google hasn't verified
     this app"; choose **Advanced → Go to Command Centre (unsafe)**. Unverified apps are limited
     to 100 users, which is fine for one
     ([Google: unverified apps](https://support.google.com/cloud/answer/7454865)).
3. **Scopes** (Data access): `…/auth/calendar.events` (read and write events),
   `…/auth/calendar.events.freebusy` (free/busy), `…/auth/calendar.calendarlist.readonly` (only so
   `google:auth` can print your calendar ids), and `…/auth/drive.file` for Drive storage (only
   files the app creates). See [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).
4. **OAuth client.** **Clients → Create client → Desktop app**. Copy the client id and secret.
5. **Get the refresh token** with the loopback flow (PKCE, a random `127.0.0.1` port; see
   [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)):

   ```bash
   GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret> pnpm --filter @cc/pa google:auth
   # optional: --scopes calendar.events,calendar.events.freebusy,drive.file
   ```

   It opens Google's consent page (or prints the URL), and when you allow it, prints
   `GOOGLE_REFRESH_TOKEN=…`, the calendars the account can see with their ids, and a ready
   `CALENDAR_ACCOUNTS` line. By default it asks for the calendar scopes plus `drive.file`.
6. **Set on Railway:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and
   `CALENDAR_ACCOUNTS`, e.g.

   ```json
   [{"id":"google","provider":"google","vertical":"personal",
     "calendars":["primary",{"id":"family0123@group.calendar.google.com","name":"Family"},
                  {"id":"en.uk#holiday@group.v.calendar.google.com","name":"UK holidays","write":false}]}]
   ```

   - `calendars`: `primary` plus any shared or family calendars, by id (from `google:auth`, or
     Google Calendar → the calendar's settings → **Integrate calendar → Calendar ID**). Every listed
     calendar counts for free/busy. `write: false` for ones you can only read; new events go to the
     first writable one unless the agent names another.
   - `credentials` is optional: `{clientId, clientSecret, refreshToken}`, each defaulting to the
     `GOOGLE_*` variables, or `"env:OTHER_VAR"`. Set it only for a second Google account.
   - `vertical`: which vertical's agents use it. The personal vertical reads every account's events
     (work commitments block personal time too); other verticals read and write only their own.
   - Only `provider: "google"` is supported. Errors name the field, never the value.

**If Google revokes the token** (you removed the app's access, changed your password, the app is
still in Testing after 7 days, or it went unused for 6 months), calendar reads show "Google
rejected the refresh token … run `pnpm --filter @cc/pa google:auth`", and you get one push a day
saying so. Run step 5 again and update `GOOGLE_REFRESH_TOKEN`.

### Enabling the morning brief and evening wrap

Set `enabled: true` on `morning-brief` (`packages/verticals/src/org.ts`) and/or `evening-wrap`
(`packages/verticals/src/personal.ts`) and redeploy (see "Morning brief" above). They use the
`personal-assistant` skill (`skills/personal-assistant/SKILL.md`), which also covers how the agent
handles "remind me…", "add … to shopping", "when am I free Thursday?" and "book the dentist next
week" (it finds a slot, then proposes the event), and UK date and time conventions.

### From other agents

```bash
claude mcp add --transport http pa https://<your-domain>/mcp/pa \
  --header "Authorization: Bearer <ADMIN_TOKEN>"
```

With the admin token, writes are yours (`created_by` "dave") and you see every vertical.

## Notifications

Every notification is saved in the app's **notification centre** (the bell in the header, with
the unread count; the same count shows on the app icon where the Badging API is supported). Each
one has a **category**, and the category decides whether it reaches your devices as a push.
Change it all under **Notifications → Notification settings** (`#/notification-settings`).

### Categories and defaults

| Category | What sends it | Default |
| --- | --- | --- |
| `approval` | an action waiting for approval | push, sound, high |
| `briefing` | morning brief, evening wrap, quick briefing | push, silent |
| `reminder` | personal-assistant reminders | push, sound, high |
| `alert` | budget reached, a scheduled post failed | push, sound, urgent |
| `digest` | the daily digest | push, silent, low |
| `social` | social activity | batched into the next digest |
| `orders` | Odoo/shop orders | batched into the next digest |
| `quotes` | incoming RFQs (Odoo CRM leads) and suppliers' replies on RFQs and POs | push, sound, high |
| `system` | test pushes, system notices | in the app only |
| `agent` | anything else an agent sends with `notify` | push, sound |

For each category you can set: **on/off** (off: still listed in the centre, already marked read);
**delivery** (push now, add to the next digest push, or in the app only); **sound** (off shows the
push silently, with no sound or vibration); and its **priority**. **Per vertical** overrides change
one category for one business, e.g. 3dpandme social off.

- Approval requests share one notification (tag `approvals`) that is replaced by each new request,
  says how many more are waiting, and has **Approve** / **Reject** buttons. The buttons don't act
  from the lock screen: they open the app on that proposal and ask you to confirm. (The service
  worker has no credentials, and a stray tap on a lock screen shouldn't send an email.) Deciding
  a proposal marks its notification read.
- Briefings open a briefing view (`#/briefing/<id>`).
- **Rate limit:** at most 3 pushes per category per 10 minutes (configurable). Extras collapse into
  one "and N more" notification per category, which updates in place. Urgent is never limited.
- **Batched** notifications are added to the next daily-digest push as one line ("Also: 2 social,
  1 orders"). If there is no digest that day they stay in the centre.

Code that calls `notify()` can pass `category`, `priority` (`urgent`/`high`/`normal`/`low`),
`vertical`, `tag`, `actions` and `data`; `{title, body, url}` alone still works, and the category
is then guessed from the title and URL (else `agent`). The `notify` action takes
`payload.category` (default `agent`); agents can't use `approval` or `system`, or `urgent`.

### Quiet hours

Default **22:00–07:00 Europe/London**, across midnight and following daylight saving. During quiet
hours only `urgent` pushes (and approvals, if you tick **Let approvals through**). Everything else
is held and, when quiet hours end, arrives as **one summary push** listing what came in.

### Quick briefing

Off by default. When on, at the set time (default 07:30) you get a `briefing` push with today's
counts: approvals waiting, tasks so far, spend against budget, and unread notifications. It is a
system job, not an agent run, so it costs nothing. The agent-written morning brief (above) is
separate and is also sent as a `briefing`.

### Devices

**Notification settings → Enable on this device** subscribes the device and asks for a name
("Dave's phone"). The device list shows each one's platform and last successful push, and lets you
rename or remove it, choose what it gets (everything, high and up, or urgent only: e.g. urgent only
on the phone, everything on the desktop), and **Send test**. Each category row also has a **Test**
button, which sends a test push to every device that category reaches (ignoring quiet hours and
the rate limit). Devices whose subscription has expired are removed automatically.

- **iPhone/iPad (iOS 16.4+):** push only works from the home-screen app. In Safari, **Share → Add
  to Home Screen**, open Command Centre from the home screen, sign in, then **Enable on this
  device** and allow notifications. Focus modes can still silence it.
- **Android (Chrome):** install the app (menu → **Install app**) or use it in Chrome, then **Enable
  on this device**. If nothing arrives, check Android's notification settings for Chrome / the app.
- **Windows/macOS:** Chrome or Edge, installed or in a tab. Pushes arrive while the browser runs.

The server needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; without them notifications are only
in the app. API: `GET /api/notifications?category=&unread=1`, `GET /api/notifications/unread-count`,
`POST /api/notifications/:id/read`, `POST /api/notifications/read-all`,
`GET|PUT /api/notifications/prefs`, `/api/notifications/devices`, `POST /api/notifications/test`.

## Odoo

> **Easiest:** Accounts page → Business → Odoo → Set up. The variables below are the alternative.


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

When Odoo is configured, the server also **polls** Odoo (once an hour by default) and turns
what happened into events. Odoo Online can't run custom modules, so nothing is pushed to the
server.

| Source | What it watches | Event | Default handling |
| --- | --- | --- | --- |
| `orders` | confirmed sales and website orders (`sale.order` in state sale/done) | `order.created` | filed: a journal line and the daily digest, no agent, no push |
| `messages` | customer chatter messages (`mail.message` of type comment, not by an internal user) on orders, contacts and tickets | `message.received` | agent drafts a reply (`dms-customer-reply`) |
| `tickets` | new Helpdesk tickets (if Helpdesk is installed) | `message.received` | agent drafts a reply |
| `stock` | a storable product's on-hand quantity dropping below its threshold, once per crossing | `stock.low` | filed: on the daily digest's **To buy** list, no agent, no push |
| `deliveries` | an outgoing delivery still not done `lateAfterHours` after its scheduled date, once | `delivery.late` | filed: on the daily digest's late list, no agent, no push |
| `reviews` | submitted ratings and product reviews (`rating.rating`, if installed) | `review.received` | agent drafts a reply (`dms-ops`) |
| `leads` | new CRM leads and opportunities (website forms, the sales email alias), not ones a staff user typed in (if CRM is installed) | `rfq.received` | filed **and pushed straight away** ("RFQs and purchasing"), no agent |
| `purchases` | suppliers' replies on RFQs and purchase orders (`mail.message` on `purchase.order`, comments and emails, not by staff; if Purchase is installed) | `purchase.reply` | filed **and pushed straight away** ("RFQs and purchasing"), no agent |

**What reaches you when:** RFQs and supplier replies (including PO confirmations sent by
email or posted on the PO) push one at a time, when the next poll finds them (within the hour
by default). Confirmed sales, what to buy and late deliveries wait for the daily digest. Abandoned website carts are draft sales orders, which
no source watches, so Odoo's own cart follow-up handles them. RFQs that arrive as email in a
polled inbox go through the email flow (an agent drafts a reply for approval).

- **First run:** each source starts from "now" and doesn't replay old records. Progress is kept
  per source in the `odoo_event_checkpoints` table, so restarts carry on where they stopped.
- **Missing apps:** if an app or field a source needs isn't there (no Helpdesk, for example), that
  source logs `odoo-events: <source>: disabled: ...` once and stops. The others keep running.
  Restart the server after installing the app.
- **Untrusted:** Odoo content can come from customers. Tasks from Odoo events never auto-execute
  outward actions: every proposal waits for your approval, whatever the vertical's policy.
- **Digest:** the daily digest of each vertical gets an **Odoo** section: confirmed sales and
  revenue, the day's RFQs and supplier replies, customer messages and reviews, then **To buy**
  (every product below its reorder level *now*, with on-hand and incoming quantities, not just the
  day's new ones) and every delivery that is late now.

Set `ODOO_EVENTS` to choose what runs. Leave it unset (or `on`) for every source with the
defaults, or set:

- `off` to disable polling;
- a list such as `orders,stock,deliveries`;
- JSON options:

```json
{
  "sources": ["orders", "messages", "tickets", "stock", "deliveries", "reviews", "leads", "purchases"],
  "pollSeconds": 3600,
  "lowStockThreshold": 3,
  "useReorderRules": true,
  "websites": { "1": "dms", "3dpandme": "3dpandme" },
  "defaultVertical": "dms",
  "bigOrderThreshold": 500,
  "lateAfterHours": 24,
  "messageTypes": ["comment"],
  "purchaseMessageTypes": ["comment", "email"],
  "overlapSeconds": 600
}
```

- `pollSeconds`: how often each source is checked (default 3600, minimum 30). Odoo Online
  rate-limits its API (HTTP 429), so keep it long. The sources start a few seconds apart.
- `lowStockThreshold`: a product is low when `qty_available` is **below** this. With
  `useReorderRules`, a product's reordering rule (Inventory → Configuration → Reordering Rules)
  with a min quantity above 0 sets its threshold instead. Services and consumables are never low.
- `websites`: maps an Odoo website, by id or by name, to a vertical. Find the ids with the
  `list_websites` tool. Anything else (and records with no website, such as stock) goes to
  `defaultVertical`.
- `bigOrderThreshold`: an order at or above this total (in its own currency) is flagged as large
  in its event. It is still only filed for the digest.
- `lateAfterHours`: grace period after a delivery's scheduled date. Many orders are scheduled for
  the moment they're placed, so `0` would flag nearly every order.
- `messageTypes`: add `"email"` to also catch customers' email replies to Odoo's own mails
  (quotations, order confirmations), if those don't already reach a polled inbox.
- `purchaseMessageTypes`: which messages on a purchase order count as a supplier's reply. The
  default takes chatter comments and emails (replies to Odoo's RFQ and PO mails).
- `overlapSeconds`: how far back each poll looks again, for records committed late. Already-seen
  ids are skipped.

## Social: platform setup

> **Easiest:** Accounts page → Social → Add account (the developer-app steps are in "Accounts page" above). The variables below are the alternative.


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

## Voice and Drive mode

Drive mode (`#/drive`, or the **Drive mode** button on Chat) runs Command Centre by voice: one
huge talk button, answers read aloud, approvals read out and decided by voice. It is built for
the phone in the car, so it shows almost nothing to read.

### In the car

1. Pair the phone with the car (or a headset) over Bluetooth. Open Command Centre and tap
   **Drive mode** before you set off. The first tap on the big button also grants the microphone
   and turns on the **headset button**: the car's or headset's play/pause button then works as the
   talk button (Media Session API). If the button does nothing, tap the screen once again.
2. Press (screen or headset) and speak. Commands are handled on the phone, without the agent:
   - "what's new" or "briefing": pending approvals, failed or held-back tasks, today's spend and
     (once the calendar is connected) what's next;
   - "read approvals", then "approve", "reject" or "next";
   - "repeat", "stop", "cancel", "that's all";
   - "conversation mode" or "push to talk" switches modes;
   - start with a business to send a request there: "shop: has order 1042 shipped?",
     "dms, …", "3dpandme: …", "open v: …".
   - **who you're talking to**: by default the **Chief of Staff**, who hands each request to the
     right role and tells you the outcome when they report back (docs/ORG.md, "Reporting back").
     To talk to one role directly: "talk to the shop lead", "put me through to customer support",
     "talk to OpenD support" (a role shared by several businesses needs its business; you'll be
     asked which). Every request after that goes to that role until "back to chief of staff". The
     **Talking to** picker at the top does the same, and the choice is remembered on the phone.
     "Who am I talking to?" says who it is.
   - ask one role once, without switching: "ask customer support whether Jane's refund went
     through", "chief of staff: what's on today?". Naming a business on its own ("shop: …") still
     sends that request to the business, whoever you're talking to.

   Anything else goes to the agent in **voice mode**: it answers in one to three short spoken
   sentences. While it works you hear "Working on it", then "Still working on it" every
   20 seconds.
3. **Approving by voice always asks twice.** "Approve" reads the item back ("To approve: Reply to
   Jane about order 1042. Say 'yes, approve' to confirm, or 'no'"). Only "yes, approve" (or the
   on-screen **Yes, approve** button) does it. A bare "yes" never confirms anything, and a longer
   sentence such as "approve the quote for Jane" is sent to the agent as a request rather than
   treated as an approval.

**Two modes** (the toggle at the top; remembered per device):

- **Push to talk** (default): it only listens after a press, and it is **latched**: it keeps
  listening through pauses until you press again (**Send**, or the headset button), for up to
  5 minutes, so you can dictate a long message and think between sentences. If the agent asks a
  question, it reads the question and waits for your next press. What you say then answers that
  question in the same conversation. (With the server's speech recognition, used on iPhone, a long
  message is recorded and transcribed in pieces of up to `VOICE_MAX_SECONDS`.)
- **Conversation**: after a question from the agent, a read-out approval or a confirmation, it
  plays a "your turn" chime and listens by itself. After 8 seconds of silence it asks "Still
  there?" once, then stops. Your answer continues the same task. "Stop", "cancel" or "that's all"
  ends the conversation at any point. **Options → Listen for a follow-up** also listens for
  5 seconds after a final answer.

How a conversation continues: in voice mode the agent ends its answer with one JSON line,
`{"voice":{"type":"converse"|"final","text":"…"}}`. The server parses that line and stores it on
the run as `response`. It shows in `GET /api/tasks/:id` and is pushed live as `run.response`. A
reply goes to `POST /api/tasks/:id/reply {text, voice}`, which queues the same task again. The
next run resumes the earlier Claude Code session (`--resume`), so the conversation's history stays
on one task. If there is no session to resume, the prompt carries the earlier question instead.

**Keeping the screen on.** Drive mode holds a screen wake lock while it is open (the Options line
shows "Screen: kept on"). The phone releases the lock when you switch apps or lock the screen, and
Drive mode takes it again when you come back. Mount the phone where you can see the big button,
and keep it plugged in.

**Android (Chrome)** works best. Speech recognition uses Google's servers unless on-device
recognition is installed, so it needs signal. The headset button needs Drive mode in the
foreground and at least one tap first.

**iPhone (Safari) caveats:**

- Speech recognition works in a Safari tab. In an app added to the Home Screen it has
  historically been exposed but done nothing. There, Drive mode uses the server's
  speech-to-text when one is configured (see below), so set one up if you use the installed app.
- Speech only starts after a tap, so tap the big button once when you open Drive mode.
- The screen wake lock needs iOS 16.4 or later; in Home Screen apps it reportedly only works from iOS 18.4.
- Headset buttons are less reliable than on Android.

**Safety.** Set everything up before you drive. Use the headset button or a single tap, and don't
read the screen: everything important is spoken. Long answers are cut to about 40 seconds and end
with "There's more on screen when you're parked". Nothing outward-facing happens without a spoken
readback and an explicit "yes, approve". Use it only where hands-free phone use is legal.

### Optional server voices

> **Easiest:** Accounts page → AI → OpenAI / ElevenLabs, and Settings → Voice settings. The variables below are the alternative.


With nothing configured, Drive mode uses the browser's own speech: free, quick, with an en-GB
voice where the device has one. Server providers are an upgrade for quality, and a fallback for
devices whose browser can't listen (iOS Home Screen apps) or has no good voice. `GET
/api/voice/config` reports what is available, and the PWA chooses automatically. To prefer the
server voice anyway, tick **Options → Use the server voice**.

| Variable | Default | |
|---|---|---|
| `OPENAI_API_KEY` | – | enables OpenAI speech-to-text and text-to-speech |
| `ELEVENLABS_API_KEY` | – | enables ElevenLabs text-to-speech (and Scribe speech-to-text) |
| `VOICE_STT_PROVIDER` | `auto` | `openai`, `elevenlabs`, `off`; `auto` = OpenAI, else ElevenLabs |
| `VOICE_TTS_PROVIDER` | `auto` | `openai`, `elevenlabs`, `off`; `auto` = ElevenLabs, else OpenAI |
| `VOICE_OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | or `gpt-4o-transcribe`, `whisper-1` |
| `VOICE_OPENAI_TTS_MODEL` / `VOICE_OPENAI_VOICE` | `gpt-4o-mini-tts` / `fable` | |
| `VOICE_ELEVENLABS_TTS_MODEL` / `VOICE_ELEVENLABS_VOICE` | `eleven_flash_v2_5` / George (British) | voice id from the ElevenLabs voice library |
| `VOICE_ELEVENLABS_STT_MODEL` | `scribe_v2` | |
| `VOICE_MAX_UPLOAD_KB` / `VOICE_MAX_SECONDS` | `2048` / `60` | limits for `POST /api/voice/transcribe` |
| `VOICE_LANGUAGE` | `en-GB` | |

Video narration ([VIDEO.md](VIDEO.md)) uses the same keys, voices and TTS models.

`auto` turns a provider on as soon as its key is set. If `OPENAI_API_KEY` is there for something
else, set `VOICE_STT_PROVIDER=off` / `VOICE_TTS_PROVIDER=off` to keep voice on the browser.

Typical costs (list prices, October 2026):

- Speech-to-text: OpenAI `gpt-4o-mini-transcribe` about $0.003 a minute (`gpt-4o-transcribe`
  $0.006); ElevenLabs Scribe v2 about $0.22 an hour.
- Text-to-speech: ElevenLabs Flash v2.5 about $0.04 per 1,000 characters (a three-sentence answer
  is about 250 characters, so about 1p); OpenAI `gpt-4o-mini-tts` about $0.015 a minute of audio.
- An hour of driving with a dozen requests costs a few pence.

Short phrases ("Working on it", confirmations) are cached in memory by `POST /api/voice/speak`.

Endpoints, all behind the dashboard auth:

- `POST /api/voice/transcribe` (raw audio body or multipart `file`; `?seconds=`, `?language=`)
  returns `{text}`;
- `POST /api/voice/speak {text, voice?}` returns audio;
- `GET /api/voice/config`;
- `GET /api/voice/briefing` returns `{text, approvals, attention, cost, calendar}`. It is
  deterministic, with no LLM;
- `GET /api/voice/approvals/next?skip=id,id` returns the next pending proposal, described for
  reading aloud. Approving and rejecting use the normal `/api/proposals/:id/approve|reject`;
- `POST /api/chat {text, voice: true}` and `POST /api/tasks/:id/reply {text, voice}`.

## Command Centre: the Software Lead

The **Command Centre** business has one role, the **Software Lead**, which works on this app's
own code (`desktopmachineshop/command-centre-`). Ask it in Chat or Drive mode ("software: make the
digest arrive at 8am", "talk to the software lead"), or let the Chief of Staff hand it the work.

**Set up:** create a fine-grained GitHub token with **Contents** and **Pull requests** (read and
write) on that repository only, and set it as `GITHUB_TOKEN` in Railway.

**How it works:**
- Each task gets its own checkout, `workspaces/command-centre/software-lead/work/<task id>` on
  the volume, fetched fresh and started at the default branch. A reply or a report on the same
  task finds it as the agent left it.
- The role's runs may use Claude Code's own tools (`tools` on the role: Bash, Read, Edit, Write,
  Glob, Grep, WebFetch), so the agent edits, installs (`corepack pnpm install`), runs checks and
  commits on a `cc/...` branch.
- It has **no GitHub credentials**: the token stays on the server, which passes it to git per
  command. To publish, the agent proposes **`github.pr.create`** (branch, title, body), which runs
  **straight away** (`auto`): the server pushes the branch and opens the pull request (or, if one
  is open for that branch, pushes the new commits to it), and you get its link in the report. A PR
  changes nothing until it is merged.
- **Merging needs your approval:** ask it to merge ("merge PR 11") and it proposes
  **`github.pr.merge`**, which waits under Approvals; approve and the server merges it on GitHub
  (branch protection and required checks still apply). Or merge on GitHub yourself. It never
  pushes the default branch and never forces.
- **Only for work you started:** a task from chat, a schedule, or a handoff from those gets the
  tools and the checkout. A task from outside input (an email or webhook routed there) gets
  neither, and says so.
- **Trust:** the agent has a shell inside the server's container, as the server's user. Its own
  environment holds no secrets, but this is **not a sandbox**: a shell as that user could read the
  server's files and its process environment (database URL, admin token, `GITHUB_TOKEN`). That is
  why the tools are only given to tasks you start. Review every PR before merging. For stronger
  isolation, run coding on a desktop worker instead (a later step).
- Old checkouts stay on the volume; delete `workspaces/command-centre/software-lead/work/*` to
  free space (a task whose checkout is gone gets a fresh one on its next run).

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
