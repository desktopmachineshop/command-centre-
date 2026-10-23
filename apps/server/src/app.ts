import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunner, ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "@cc/agent-runtime";
import { Brain } from "@cc/brain";
import { createEmailExecutors, EmailPoller, type ImapConnector } from "@cc/email";
import { createOdooExecutors, createOdooMcpServer, OdooClient } from "@cc/odoo";
import {
  type AdapterMap,
  adapters as socialPlatformAdapters,
  createSocialExecutors,
  platformLabel,
  publishDueScheduledPosts,
  SocialInbound,
  validateSocialCredentials,
} from "@cc/social";
import type { Triager } from "@cc/triage";
import { VerticalRegistry } from "@cc/verticals";
import { createNodeWebSocket } from "@hono/node-ws";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { sessionFromUpgrade } from "./accounts/http";
import type { ScryptParams } from "./accounts/password";
import { AuthService } from "./accounts/service";
import { ActionService, builtinExecutors } from "./actions";
import { BudgetService } from "./budget";
import type { Config } from "./config";
import { addDays } from "./days";
import { createPool, migrate } from "./db/pool";
import { Store } from "./db/store";
import { DigestService } from "./digest";
import { apiRoutes } from "./http/api";
import { mediaRoutes } from "./http/social";
import { wsHandler } from "./http/ws";
import { Hub } from "./hub";
import { mcpRoutes } from "./mcp/endpoints";
import { Pipeline } from "./pipeline";
import { type Notifier, WebPushNotifier } from "./push";
import { PgBossTaskQueue, type TaskQueue } from "./queue";
import { RunTokens } from "./run-tokens";
import { startSchedules, startSystemJobs } from "./scheduler";
import { createTriager } from "./triage";
import { WorkerService } from "./workers";

export interface Overrides {
  runner?: AgentRunner;
  queue?: TaskQueue;
  triager?: Triager;
  notifier?: Notifier;
  verticals?: VerticalRegistry;
  /** IMAP connector for email ingress and Sent copies (tests use a MemoryMailbox). */
  imap?: ImapConnector;
  /** Social platform adapters (tests use fakes). */
  socialAdapters?: AdapterMap;
  /** Cheaper password hashing for tests. */
  scrypt?: ScryptParams;
}

export function createRunner(config: Config): AgentRunner {
  if (config.agent.runner === "echo") return new ScriptedRunner("echo");

  // The subscription run must not see an API key, or Claude Code would bill the key instead.
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const subscription = new ClaudeCodeRunner({ bin: config.agent.claudeBin, env, timeoutMs: config.agent.timeoutMs });
  if (!config.agent.fallbackApiKey) return subscription;

  const { CLAUDE_CODE_OAUTH_TOKEN: _oauth, ...apiEnv } = env;
  const api = new ClaudeCodeRunner({
    name: "claude-code-api",
    bin: config.agent.claudeBin,
    env: { ...apiEnv, ANTHROPIC_API_KEY: config.agent.fallbackApiKey },
    timeoutMs: config.agent.timeoutMs,
  });
  return new FallbackRunner("claude-code", subscription, api);
}

/** Wires every service together. `start()` migrates, boots the queue and schedules. */
export function createServer(config: Config, overrides: Overrides = {}) {
  const pool = createPool(config.databaseUrl);
  const store = new Store(pool);
  const hub = new Hub();
  const verticals = overrides.verticals ?? new VerticalRegistry();
  const brain = new Brain({
    dir: config.brainDir,
    remoteUrl: config.brainRemoteUrl,
    folders: verticals.all().map((v) => v.brainFolder),
  });
  const notifier = overrides.notifier ?? new WebPushNotifier(store, config.vapid);

  // --- Email: executors for configured accounts; the poller starts in start() ---
  const emailAccounts = config.email.accounts;
  for (const a of emailAccounts) verticals.require(a.vertical);
  let emailPoller: EmailPoller | undefined;
  // --- end email ---

  // --- Social: accounts checked against the adapters, executors, media, scheduled posts; inbound starts in start() ---
  const socialAdapters = overrides.socialAdapters ?? socialPlatformAdapters;
  const socialAccounts = validateSocialCredentials(config.social.accounts, socialAdapters);
  for (const a of socialAccounts) verticals.require(a.vertical);
  const socialExecutors = socialAccounts.length
    ? createSocialExecutors(socialAccounts, { adapters: socialAdapters, scheduled: store, timeZone: config.timezone })
    : {};
  const mediaDir = join(config.dataDir, "media");
  /** Publishes due scheduled posts; the every-minute system job calls this. */
  const publishScheduledPosts = () =>
    publishDueScheduledPosts({
      store,
      accounts: socialAccounts,
      adapters: socialAdapters,
      onFailure: (post, error) =>
        notifier.notify({
          title: "Scheduled post failed",
          body: `${post.title} on ${platformLabel(post.platform)} (${post.accountId}): ${error}`,
          url: "/social",
        }),
    });
  let socialInbound: SocialInbound | undefined;
  // --- end social ---

  // Odoo, when configured: read tools at /mcp/odoo, writes only as (draft-policy) actions.
  const odoo = config.odoo ? new OdooClient(config.odoo) : undefined;
  const extraMcpServers: Record<string, () => McpServer> = odoo ? { odoo: () => createOdooMcpServer(odoo) } : {};

  const executors = {
    ...builtinExecutors,
    ...(emailAccounts.length ? createEmailExecutors(emailAccounts, { connect: overrides.imap }) : {}),
    ...(odoo ? createOdooExecutors(odoo) : {}),
    ...socialExecutors,
  };
  const actions = new ActionService(store, hub, verticals, { brain, notifier }, executors);
  const workers = new WorkerService(store, hub);
  const runTokens = new RunTokens();
  // A "running" task untouched this long is a crashed run. pg-boss redelivers a job only after that.
  const staleRunSeconds = Math.ceil(config.agent.timeoutMs / 1000) + 300;
  const queue = overrides.queue ?? new PgBossTaskQueue(config.databaseUrl, config.agent.concurrency, staleRunSeconds + 300);
  const budget = new BudgetService(store, verticals, notifier, { dailyBudgetUsd: config.agent.dailyBudgetUsd, timezone: config.timezone });
  const digests = new DigestService(store, brain, verticals, notifier, budget, config.timezone);
  const pipeline = new Pipeline({
    store,
    hub,
    triager: overrides.triager ?? createTriager(config),
    verticals,
    runner: overrides.runner ?? createRunner(config),
    queue,
    brain,
    actions,
    runTokens,
    dataDir: config.dataDir,
    skillsDir: config.skillsDir,
    internalBaseUrl: config.internalBaseUrl,
    maxTurns: config.agent.maxTurns,
    budget,
    guards: {
      maxConcurrentPerVertical: config.agent.maxConcurrentPerVertical,
      busyRetrySeconds: config.agent.busyRetrySeconds,
      staleRunSeconds,
      dedupeWindowMinutes: config.agent.dedupeWindowMinutes,
    },
    mcpServers: ["brain", ...Object.keys(extraMcpServers)],
  });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/healthz", async (c) => {
    await pool.query("select 1");
    return c.json({ ok: true });
  });
  // --- auth: email + password sessions (src/accounts); the admin token keeps working alongside ---
  const auth = new AuthService(pool, { scrypt: overrides.scrypt });
  const authHttp = { adminToken: config.adminToken, trustedProxyHops: config.trustedProxyHops };
  const wsSessions = { fromUpgrade: (c: Context) => sessionFromUpgrade(c, auth, authHttp), onRevoke: auth.onRevoke.bind(auth) };
  // --- end auth ---

  app.get("/ws", wsHandler(upgradeWebSocket, { hub, workers, adminToken: config.adminToken, workerToken: config.workerToken, sessions: wsSessions }));
  const social = {
    store,
    actions,
    accounts: socialAccounts,
    adapters: socialAdapters,
    timeZone: config.timezone,
    media: { dir: mediaDir, maxBytes: config.media.maxBytes, publicBaseUrl: config.publicBaseUrl },
  };
  app.route("/api", apiRoutes({ store, pipeline, actions, workers, brain, verticals, notifier, budget, digests, adminToken: config.adminToken, webhookSecret: config.webhookSecret, social, auth: { service: auth, options: authHttp } }));
  app.route(
    "/mcp",
    mcpRoutes({
      brain,
      actions,
      runTokens,
      verticals,
      adminToken: config.adminToken,
      servers: extraMcpServers,
      handoff: (taskId, target, note) => pipeline.handoff(taskId, target, note), // org roles
    }),
  );
  // Uploaded media, public at unguessable URLs so Instagram and Threads can fetch it.
  app.route("/media", mediaRoutes(mediaDir));

  if (config.webDistDir) {
    const root = config.webDistDir;
    app.use("/*", serveStatic({ root }));
    // Single-page app: unknown paths get index.html so client-side routes work on reload.
    app.get("*", async (c) => c.html(await readFile(join(root, "index.html"), "utf8")));
  }

  let crons: ReturnType<typeof startSchedules> = [];

  /** Just after midnight: finish yesterday's digest notes (no push) and release deferred tasks. */
  const rollover = async () => {
    await digests.deliver(addDays(digests.today(), -1), { push: false });
    await pipeline.releaseDeferred();
  };

  return {
    app,
    injectWebSocket,
    store,
    hub,
    brain,
    pipeline,
    actions,
    workers,
    queue,
    budget,
    digests,
    rollover,
    publishScheduledPosts,
    auth,
    async start() {
      await migrate(pool);
      await auth.warm();
      await store.markAllNodesOffline();
      await brain.init();
      if (queue instanceof PgBossTaskQueue) await queue.start();
      await queue.work((taskId) => pipeline.runTask(taskId));
      // Tasks committed just before a crash but never enqueued.
      await pipeline.enqueueQueued();
      // Deferred tasks from a day the server slept through; any still over budget re-defer.
      await pipeline.releaseDeferred();
      // Rollover and digest run regardless of SCHEDULES_ENABLED, which only gates vertical schedules.
      crons = startSystemJobs({
        timezone: config.timezone,
        digestCron: config.digestCron,
        digest: () => digests.deliver(),
        rollover,
        socialPublish: socialAccounts.length ? publishScheduledPosts : undefined,
      });
      if (config.schedulesEnabled) {
        // Vertical and role schedules, plus the Chief of Staff's (the morning brief) in its home vertical.
        const root = { vertical: verticals.rootVertical, role: verticals.root.id, schedules: verticals.root.schedules };
        crons.push(...startSchedules(verticals.all(), (e) => pipeline.ingest(e), root));
      }
      if (emailAccounts.length) {
        emailPoller = new EmailPoller({
          accounts: emailAccounts,
          store,
          ingest: (e) => pipeline.ingest(e),
          pollIntervalMs: config.email.pollIntervalMs,
          connect: overrides.imap,
        });
        emailPoller.start();
      }
      if (socialAccounts.length) {
        socialInbound = new SocialInbound({
          accounts: socialAccounts,
          adapters: socialAdapters,
          store,
          ingest: (e) => pipeline.ingest(e),
          defaultPollSeconds: config.social.defaultPollSeconds,
        });
        socialInbound.start();
      }
    },
    async stop() {
      for (const c of crons) c.stop();
      await emailPoller?.stop();
      await socialInbound?.stop();
      await queue.stop();
      await pool.end();
    },
  };
}
