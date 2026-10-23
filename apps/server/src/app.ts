import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunner, ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "@cc/agent-runtime";
import { Brain } from "@cc/brain";
import { ChainTriager, RulesTriager, type Triager } from "@cc/triage";
import { VerticalRegistry } from "@cc/verticals";
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ActionService } from "./actions";
import { BudgetService } from "./budget";
import type { Config } from "./config";
import { addDays } from "./days";
import { createPool, migrate } from "./db/pool";
import { Store } from "./db/store";
import { DigestService } from "./digest";
import { apiRoutes } from "./http/api";
import { wsHandler } from "./http/ws";
import { Hub } from "./hub";
import { mcpRoutes } from "./mcp/endpoints";
import { Pipeline } from "./pipeline";
import { type Notifier, WebPushNotifier } from "./push";
import { PgBossTaskQueue, type TaskQueue } from "./queue";
import { RunTokens } from "./run-tokens";
import { startSchedules, startSystemJobs } from "./scheduler";
import { WorkerService } from "./workers";

export interface Overrides {
  runner?: AgentRunner;
  queue?: TaskQueue;
  triager?: Triager;
  notifier?: Notifier;
  verticals?: VerticalRegistry;
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
  const actions = new ActionService(store, hub, verticals, { brain, notifier });
  const workers = new WorkerService(store, hub);
  const runTokens = new RunTokens();
  const queue = overrides.queue ?? new PgBossTaskQueue(config.databaseUrl, config.agent.concurrency);
  const budget = new BudgetService(store, verticals, notifier, { dailyBudgetUsd: config.agent.dailyBudgetUsd, timezone: config.timezone });
  const digests = new DigestService(store, brain, verticals, notifier, budget, config.timezone);
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
    budget,
    guards: {
      maxConcurrentPerVertical: config.agent.maxConcurrentPerVertical,
      busyRetrySeconds: config.agent.busyRetrySeconds,
      staleRunSeconds: Math.ceil(config.agent.timeoutMs / 1000) + 300,
      dedupeWindowMinutes: config.agent.dedupeWindowMinutes,
    },
  });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/healthz", async (c) => {
    await pool.query("select 1");
    return c.json({ ok: true });
  });
  app.get("/ws", wsHandler(upgradeWebSocket, { hub, workers, adminToken: config.adminToken, workerToken: config.workerToken }));
  app.route("/api", apiRoutes({ store, pipeline, actions, workers, brain, verticals, notifier, budget, digests, adminToken: config.adminToken, webhookSecret: config.webhookSecret }));
  app.route("/mcp", mcpRoutes({ brain, actions, runTokens, adminToken: config.adminToken }));

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
    async start() {
      await migrate(pool);
      await store.markAllNodesOffline();
      await brain.init();
      if (queue instanceof PgBossTaskQueue) await queue.start();
      await queue.work((taskId) => pipeline.runTask(taskId));
      // Deferred tasks from a day the server slept through; any still over budget re-defer.
      await pipeline.releaseDeferred();
      if (config.schedulesEnabled) {
        crons = startSchedules(verticals.all(), (e) => pipeline.ingest(e));
        crons.push(
          ...startSystemJobs({
            timezone: config.timezone,
            digestCron: config.digestCron,
            digest: () => digests.deliver(),
            rollover,
          }),
        );
      }
    },
    async stop() {
      for (const c of crons) c.stop();
      await queue.stop();
      await pool.end();
    },
  };
}
