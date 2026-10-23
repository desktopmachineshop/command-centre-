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
