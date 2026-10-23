import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunner, ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "@cc/agent-runtime";
import { Brain } from "@cc/brain";
import { createEmailExecutors, EmailPoller, type ImapConnector } from "@cc/email";
import { ChainTriager, RulesTriager, type Triager } from "@cc/triage";
import { VerticalRegistry } from "@cc/verticals";
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ActionService, builtinExecutors } from "./actions";
import type { Config } from "./config";
import { createPool, migrate } from "./db/pool";
import { Store } from "./db/store";
import { apiRoutes } from "./http/api";
import { wsHandler } from "./http/ws";
import { Hub } from "./hub";
import { mcpRoutes } from "./mcp/endpoints";
import { Pipeline } from "./pipeline";
import { type Notifier, WebPushNotifier } from "./push";
import { PgBossTaskQueue, type TaskQueue } from "./queue";
import { RunTokens } from "./run-tokens";
import { startSchedules } from "./scheduler";
import { WorkerService } from "./workers";

export interface Overrides {
  runner?: AgentRunner;
  queue?: TaskQueue;
  triager?: Triager;
  notifier?: Notifier;
  verticals?: VerticalRegistry;
  /** IMAP connector for email ingress and Sent copies (tests use a MemoryMailbox). */
  imap?: ImapConnector;
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
  const executors = emailAccounts.length
    ? { ...builtinExecutors, ...createEmailExecutors(emailAccounts, { connect: overrides.imap }) }
    : builtinExecutors;
  let emailPoller: EmailPoller | undefined;
  // --- end email ---

  const actions = new ActionService(store, hub, verticals, { brain, notifier }, executors);
  const workers = new WorkerService(store, hub);
  const runTokens = new RunTokens();
  const queue = overrides.queue ?? new PgBossTaskQueue(config.databaseUrl, config.agent.concurrency);
  const pipeline = new Pipeline({
    store,
    hub,
    triager: overrides.triager ?? new ChainTriager([new RulesTriager()]),
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
  });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/healthz", async (c) => {
    await pool.query("select 1");
    return c.json({ ok: true });
  });
  app.get("/ws", wsHandler(upgradeWebSocket, { hub, workers, adminToken: config.adminToken, workerToken: config.workerToken }));
  app.route("/api", apiRoutes({ store, pipeline, actions, workers, brain, verticals, notifier, adminToken: config.adminToken, webhookSecret: config.webhookSecret }));
  app.route("/mcp", mcpRoutes({ brain, actions, runTokens, adminToken: config.adminToken }));

  if (config.webDistDir) {
    const root = config.webDistDir;
    app.use("/*", serveStatic({ root }));
    // Single-page app: unknown paths get index.html so client-side routes work on reload.
    app.get("*", async (c) => c.html(await readFile(join(root, "index.html"), "utf8")));
  }

  let crons: ReturnType<typeof startSchedules> = [];

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
    async start() {
      await migrate(pool);
      await store.markAllNodesOffline();
      await brain.init();
      if (queue instanceof PgBossTaskQueue) await queue.start();
      await queue.work((taskId) => pipeline.runTask(taskId));
      if (config.schedulesEnabled) crons = startSchedules(verticals.all(), (e) => pipeline.ingest(e));
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
    },
    async stop() {
      for (const c of crons) c.stop();
      await emailPoller?.stop();
      await queue.stop();
      await pool.end();
    },
  };
}
