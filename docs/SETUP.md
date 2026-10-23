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
