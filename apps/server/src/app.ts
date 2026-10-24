import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunner, ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "@cc/agent-runtime";
import { Brain } from "@cc/brain";
import { createEmailExecutors, EmailPoller, type ImapConnector } from "@cc/email";
import { createOdooExecutors, createOdooMcpServer, OdooClient, OdooEventPoller } from "@cc/odoo";
import { CalendarService, createCalendarExecutors, createPaExecutors, createPaMcpServer, deliverDueReminders, PgPaStore } from "@cc/pa";
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
import { createVoiceProviders, type SpeechToText, type TextToSpeech } from "@cc/voice";
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
import { paVoiceCalendar, reminderPushActions } from "./http/pa";
import { type Caller, mcpRoutes } from "./mcp/endpoints";
import { Pipeline } from "./pipeline";
import { NotificationService, startNotificationJobs, teeNotifier } from "./notifications/service";
import { NotificationStore } from "./notifications/store";
import { type Notifier, type PushTransport, WebPushTransport } from "./push";
import { PgBossTaskQueue, type TaskQueue } from "./queue";
import { RunTokens } from "./run-tokens";
import { startSchedules, startSystemJobs } from "./scheduler";
import { createTriager } from "./triage";
import { VoiceConversations } from "./voice/conversations";
import { type VoiceCalendar, VoiceService } from "./voice/service";
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
  /** Server speech providers (tests use fakes); default from VOICE_* config. */
  voiceProviders?: { stt?: SpeechToText; tts?: TextToSpeech };
  /** Calendar for the spoken briefing (the personal-assistant calendar plugs in here). */
  voiceCalendar?: VoiceCalendar;
  /** Web Push sender behind the notification service (tests use a fake). */
  pushTransport?: PushTransport;
  /** Clock for notification quiet hours and rate limits (tests). */
  notificationClock?: () => Date;
  /** fetch for Google Calendar and its token endpoint (tests use a fake). */
  calendarFetch?: typeof fetch;
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
  // --- Notifications: inbox, preferences, quiet hours, rate limits, devices (src/notifications) ---
  const notifications = new NotificationService(new NotificationStore(pool), overrides.pushTransport ?? new WebPushTransport(config.vapid), {
    timezone: config.timezone,
    now: overrides.notificationClock,
    onUnreadChange: (unread) => hub.broadcast({ type: "notifications.updated", unread }),
    spend: async (since) => ({ costUsd: await store.costSince(since), budgetUsd: config.agent.dailyBudgetUsd ?? null }),
  });
  // A test notifier sees every notify() call as made; the service still stores and routes it.
  const notifier: Notifier = overrides.notifier ? teeNotifier(notifications, overrides.notifier) : notifications;
  // --- end notifications ---

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
          category: "alert",
          priority: "high",
          vertical: post.vertical,
        }),
    });
  let socialInbound: SocialInbound | undefined;
  // --- end social ---

  // Odoo, when configured: read tools at /mcp/odoo, writes only as (draft-policy) actions.
  const odoo = config.odoo ? new OdooClient(config.odoo) : undefined;
  const extraMcpServers: Record<string, (caller: Caller) => McpServer> = odoo ? { odoo: () => createOdooMcpServer(odoo) } : {};

  // --- PA: reminders and lists (always), Google Calendar when CALENDAR_ACCOUNTS is set; /mcp/pa below ---
  const paStore = new PgPaStore(pool);
  for (const a of config.pa.calendarAccounts) verticals.require(a.vertical);
  const authAlerted = new Set<string>();
  const calendar = config.pa.calendarAccounts.length
    ? new CalendarService(config.pa.calendarAccounts, {
        timeZone: config.timezone,
        fetch: overrides.calendarFetch,
        // A revoked or expired refresh token: one push per account per server day, saying how to fix it.
        onAuthError: (err) => {
          const key = `${err.accountId}:${new Date().toISOString().slice(0, 10)}`;
          if (authAlerted.has(key)) return;
          authAlerted.add(key);
          void notifier
            .notify({ title: "Calendar disconnected", body: err.message.slice(0, 300), url: "/today", category: "alert", vertical: "personal", tag: `calendar-auth-${err.accountId}` })
            .catch(() => {});
        },
      })
    : null;
  const paSigningSecret = createHash("sha256").update(`pa-push:${config.adminToken}`).digest("hex");
  const deliverReminders = () =>
    deliverDueReminders(paStore, ({ reminder, title, body }) =>
      notifier.notify({
        title,
        body,
        url: "/today",
        category: "reminder",
        priority: "high",
        vertical: reminder.vertical,
        tag: `reminder-${reminder.id}`,
        renotify: true,
        ...reminderPushActions(paSigningSecret, reminder.id),
      }),
    );
  // --- end pa ---

  // --- Odoo events: polls Odoo for orders, messages, stock, deliveries, reviews; starts in start() ---
  const odooEventsConfig = odoo && config.odoo ? config.odooEvents : undefined;
  if (odooEventsConfig) for (const v of [odooEventsConfig.defaultVertical, ...Object.values(odooEventsConfig.websites)]) verticals.require(v);
  const odooEvents =
    odoo && config.odoo && odooEventsConfig?.sources.length
      ? new OdooEventPoller({
          client: odoo,
          store,
          config: odooEventsConfig,
          instance: config.odoo.db,
          baseUrl: config.odoo.url,
          ingest: (e) => pipeline.ingest(e),
        })
      : undefined;
  // --- end odoo events ---

  const executors = {
    ...builtinExecutors,
    ...createPaExecutors(paStore, { timeZone: config.timezone }),
    ...(calendar ? createCalendarExecutors(calendar) : {}),
    ...(emailAccounts.length ? createEmailExecutors(emailAccounts, { connect: overrides.imap }) : {}),
    ...(odoo ? createOdooExecutors(odoo) : {}),
    ...socialExecutors,
  };
  const actions = new ActionService(store, hub, verticals, { brain, notifier }, executors);
  actions.onDecided = (p) => notifications.resolveProposal(p.id); // notifications: clear its approval request
  // pa: Dave writes directly; a run writes directly only if its task came from chat/cron/system, else it proposes.
  extraMcpServers.pa = (caller) =>
    createPaMcpServer({
      store: paStore,
      calendar,
      timeZone: config.timezone,
      caller:
        caller.kind === "admin"
          ? { createdBy: "dave", untrustedSource: async () => null }
          : {
              vertical: caller.scope.vertical,
              taskId: caller.scope.taskId,
              createdBy: "agent",
              untrustedSource: () => actions.untrustedSource(caller.scope.taskId),
            },
      propose: (p) => actions.propose(p),
    });
  const workers = new WorkerService(store, hub);
  const runTokens = new RunTokens();
  // A "running" task untouched this long is a crashed run. pg-boss redelivers a job only after that.
  const staleRunSeconds = Math.ceil(config.agent.timeoutMs / 1000) + 300;
  const queue = overrides.queue ?? new PgBossTaskQueue(config.databaseUrl, config.agent.concurrency, staleRunSeconds + 300);
  const budget = new BudgetService(store, verticals, notifier, { dailyBudgetUsd: config.agent.dailyBudgetUsd, timezone: config.timezone });
  const digests = new DigestService(store, brain, verticals, notifier, budget, config.timezone);
  // --- Voice: server speech providers (optional), briefing, task conversations ---
  const voiceProviders = overrides.voiceProviders ?? createVoiceProviders(config.voice.providers);
  const voiceConversations = new VoiceConversations(store, hub, queue);
  const voiceService = new VoiceService(store, verticals, budget, {
    ...voiceProviders,
    calendar: overrides.voiceCalendar ?? (calendar ? paVoiceCalendar(calendar) : undefined),
    maxUploadBytes: config.voice.maxUploadBytes,
    maxSeconds: config.voice.maxSeconds,
    language: config.voice.language,
    timezone: config.timezone,
  });
  // --- end voice ---
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
    voice: voiceConversations,
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
  const pa = { store: paStore, calendar, timeZone: config.timezone, signingSecret: paSigningSecret };
  app.route("/api", apiRoutes({ store, pipeline, actions, workers, brain, verticals, notifier, budget, digests, adminToken: config.adminToken, webhookSecret: config.webhookSecret, social, auth: { service: auth, options: authHttp }, voice: { service: voiceService, conversations: voiceConversations }, notifications, pa }));
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
  let notificationCrons: ReturnType<typeof startNotificationJobs> = [];

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
    notifications,
    rollover,
    publishScheduledPosts,
    auth,
    odooEvents,
    paStore,
    calendar,
    /** Sends due reminders; the every-minute system job calls this. */
    deliverReminders,
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
        paReminders: deliverReminders,
      });
      notificationCrons = startNotificationJobs(notifications, config.timezone); // notifications: quiet-hours release, quick briefing
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
      odooEvents?.start();
    },
    async stop() {
      for (const c of crons) c.stop();
      for (const c of notificationCrons) c.stop();
      await emailPoller?.stop();
      await socialInbound?.stop();
      await odooEvents?.stop();
      await queue.stop();
      await pool.end();
    },
  };
}
