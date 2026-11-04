import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunner, ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "@cc/agent-runtime";
import { GitBrain, GitMirror, PgBrain } from "@cc/brain";
import { ROOT_ROLE_ID } from "@cc/core";
import { diskSpace, storageHousekeeping, uploadRefusal } from "./storage-housekeeping";
import { configureEmailOAuth, createEmailExecutors, createMailMcpServer, type EmailAccount, EmailPoller, type ImapConnector } from "@cc/email";
import { createOdooExecutors, createOdooMcpServer, OdooClient, OdooEventPoller } from "@cc/odoo";
import { CalendarService, createCalendarExecutors, createPaExecutors, createPaMcpServer, deliverDueReminders, PgPaStore } from "@cc/pa";
import {
  type AdapterMap,
  adapters as socialPlatformAdapters,
  createSocialExecutors,
  platformLabel,
  publishDueScheduledPosts,
  SocialInbound,
  type SocialAccount,
  validateSocialCredentials,
} from "@cc/social";
import type { Triager } from "@cc/triage";
import { VerticalRegistry } from "@cc/verticals";
import { createGoogleTokenProvider, type GoogleTokenProvider } from "@cc/storage";
import { createVoiceProviders, type SpeechToText, type TextToSpeech } from "@cc/voice";
import { createNodeWebSocket } from "@hono/node-ws";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { sessionFromUpgrade } from "./accounts/http";
import type { ScryptParams } from "./accounts/password";
import { AuthService } from "./accounts/service";
import { type ActionExecutor, ActionService, builtinExecutors } from "./actions";
import { BudgetService } from "./budget";
import type { Config } from "./config";
import { addDays } from "./days";
import { createPool, migrate } from "./db/pool";
import { Store } from "./db/store";
import { type CodeOptions, createCodeExecutors } from "./code";
import { DigestService } from "./digest";
import type { OdooLateNow, OdooStockNow } from "./odoo-digest";
import { createSendcloudMcpServer, ShippingService } from "@cc/sendcloud";
import { apiRoutes } from "./http/api";
import { mediaRoutes } from "./http/social";
import { storagePublicRoutes } from "./http/storage";
import { createStorage, videoMediaFromStorage } from "./storage";
import { ChatFiles } from "./chat-files";
import { type WorkerAuth, wsHandler } from "./http/ws";
import { desktopPublicRoutes } from "./http/desktop";
import { DesktopService } from "./desktop";
import { createGithubOidcVerifier, type GithubOidcVerifier } from "./github-oidc";
import { tokenMatches } from "./auth";
import { Hub } from "./hub";
import { paVoiceCalendar, reminderPushActions } from "./http/pa";
import { type Caller, mcpRoutes } from "./mcp/endpoints";
import { createGithubMcpServer } from "./github-mcp";
import { Pipeline } from "./pipeline";
import { NotificationService, startNotificationJobs, teeNotifier } from "./notifications/service";
import { NotificationStore } from "./notifications/store";
import { type Notifier, type PushTransport, WebPushTransport } from "./push";
import { PgBossTaskQueue, type TaskQueue } from "./queue";
import { RunTokens } from "./run-tokens";
import { OrgConfigService } from "./org-config";
import { startSchedules, startSystemJobs } from "./scheduler";
import { createTriager } from "./triage";
import { VoiceConversations } from "./voice/conversations";
import { VoiceFront } from "./voice/front";
import { LocalSpeech } from "@cc/voice/local";
import { voiceListenHandler } from "./http/voice-listen";
import { type VoiceCalendar, VoiceService } from "./voice/service";
import { type VideoMediaStore, VideoProductions, videoTtsFromConfig } from "./video";
import { WorkerService } from "./workers";
import { type Group, IntegrationService, IntegrationStore, Live, SecretBox } from "./integrations";
import { ClaudeSetup } from "./integrations/claude-setup";
import { integrationOAuth } from "./integrations/oauth"; // --- integrations oauth ---
import { refreshExpiringTokens } from "./integrations/refresh"; // --- integrations oauth ---
import { credentialTests } from "./integrations/tests"; // --- integrations oauth ---

export interface Overrides {
  runner?: AgentRunner;
  /** Coding roles' GitHub access (tests point it at a local remote and a fake API). */
  code?: CodeOptions;
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
  /** Self-hosted speech; null turns it off (tests). */
  localSpeech?: LocalSpeech | null;
  /** Drive mode's voice front; null turns it off. */
  voiceFront?: VoiceFront | null;
  /** Web Push sender behind the notification service (tests use a fake). */
  pushTransport?: PushTransport;
  /** Clock for notification quiet hours and rate limits (tests). */
  notificationClock?: () => Date;
  /** Media store for video jobs' uploads (until the server's own media hosting is wired in). */
  videoMedia?: VideoMediaStore;
  /** fetch for Google Calendar and its token endpoint (tests use a fake). */
  calendarFetch?: typeof fetch;
  /** Sendcloud API stand-in (tests). */
  sendcloudFetch?: typeof fetch;
  sendcloudBaseUrl?: string;
  /** SMTP login check behind the Accounts page's Test (tests use a fake). */
  smtpVerify?: (account: EmailAccount) => Promise<void>;
  /** The CLI "Connect Claude" runs `setup-token` with (tests use a fake). */
  claudeSetupBin?: string;
  /** fetch for Google APIs (tests use a fake Drive). */
  googleFetch?: typeof fetch;
  // --- integrations oauth ---
  /** fetch for Accounts-page sign-ins, connection tests and token renewal (tests use a fake provider). */
  integrationsFetch?: typeof fetch;
  // --- end integrations oauth ---
  /** Verifies the Desktop workflow's GitHub OIDC token (tests use a fake). */
  githubOidc?: GithubOidcVerifier;
}

/** What the claude child process may see of the server's environment: enough to run, reach the network and find its own settings. */
const AGENT_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "TERM", "SHELL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
]);
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * The environment for an agent run. Allowlisted, never the server's whole env: agents run
 * untrusted-input tasks and must not see ODOO_API_KEY, EMAIL_ACCOUNTS, DATABASE_URL, ADMIN_TOKEN...
 * Claude Code's own CLAUDE_* settings pass through (not tokens); the credential comes from
 * config: the subscription token for the subscription run, the API key for the fallback run.
 * Each gets only its own, or Claude Code would bill the key instead of the subscription.
 */
export function agentEnv(config: Config, kind: "subscription" | "api", source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (AGENT_ENV.has(name) || (name.startsWith("CLAUDE_") && !SECRET_NAME.test(name))) env[name] = value;
  }
  if (kind === "subscription" && config.agent.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;
  if (kind === "api" && config.agent.fallbackApiKey) env.ANTHROPIC_API_KEY = config.agent.fallbackApiKey;
  return env;
}

export function createRunner(config: Config): AgentRunner {
  if (config.agent.runner === "echo") return new ScriptedRunner("echo");

  const subscription = new ClaudeCodeRunner({ bin: config.agent.claudeBin, env: agentEnv(config, "subscription"), timeoutMs: config.agent.timeoutMs });
  if (!config.agent.fallbackApiKey) return subscription;

  const api = new ClaudeCodeRunner({
    name: "claude-code-api",
    bin: config.agent.claudeBin,
    env: agentEnv(config, "api"),
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
  // --- brain: notes live in Postgres; BRAIN_REMOTE_URL adds a read-only git mirror (and a one-time import from it) ---
  const brainGit = config.brainRemoteUrl || existsSync(join(config.brainDir, ".git"))
    ? new GitBrain({ dir: config.brainDir, remoteUrl: config.brainRemoteUrl, folders: verticals.all().map((v) => v.brainFolder) })
    : null;
  let brainMirror: GitMirror | null = null;
  const brain = new PgBrain(pool, { onChange: () => brainMirror?.schedule() });
  if (brainGit) brainMirror = new GitMirror(brain, brainGit);
  // --- end brain ---
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

  // --- integrations: the Accounts page's credentials, applied over the env config in start() ---
  // Each integration below is built from `config` here, then rebuilt live (a Live holder) when the
  // Accounts page changes its group; consumers read the current one at call time. Reloader below.
  let secretBox: SecretBox | undefined;
  const integrationStore = new IntegrationStore(pool, () => {
    if (!secretBox) throw new Error("the credentials key isn't loaded yet");
    return secretBox;
  });
  const integrations = new IntegrationService(integrationStore, config, {
    verticals: () => verticals.all().map((v) => v.id),
    tests: credentialTests({ fetch: overrides.integrationsFetch, imap: overrides.imap, smtpVerify: overrides.smtpVerify }), // --- integrations oauth ---
    // A social account the platform adapter would reject: refused on save, and left out (not the whole group) on reload.
    check: (c, e) => {
      const account = c.social.accounts.find((a) => a.id === e.id && a.platform === e.kind);
      return account ? socialProblem(account) : undefined;
    },
  });
  // "Connect Claude": `claude setup-token` with a bare environment (no server secrets, no tokens).
  const claudeSetup = new ClaudeSetup({
    bin: overrides.claudeSetupBin ?? config.agent.claudeBin,
    env: agentEnv({ ...config, agent: { ...config.agent, oauthToken: undefined, fallbackApiKey: undefined } }, "subscription"),
  });
  // Microsoft renews a mailbox's refresh token on every use: keep the newest (integrations/service.ts).
  configureEmailOAuth({ onRotate: (id, token) => void integrations.rotateSecret("outlook", id, "refreshToken", token).catch((err) => console.error("[email] saving a renewed Microsoft sign-in failed", err)) });
  // --- end integrations ---

  // --- Email: executors for configured accounts; the poller starts in start() ---
  /** `strict` at boot (Railway's EMAIL_ACCOUNTS stops the server, as before); on reload a mailbox for a missing business is left out alone. */
  const buildEmail = (c: Config, strict = false) => {
    const accounts = strict ? c.email.accounts : c.email.accounts.filter((a) => {
      const known = verticals.all().some((v) => v.id === a.vertical);
      if (!known) console.warn(`[email] skipping ${a.id}: business "${a.vertical}" doesn't exist`);
      return known;
    });
    for (const a of accounts) verticals.require(a.vertical);
    return {
      accounts,
      executors: accounts.length ? createEmailExecutors(accounts, { connect: overrides.imap }) : {},
      poller: accounts.length
        ? new EmailPoller({ accounts, store, ingest: (e) => pipeline.ingest(e), pollIntervalMs: c.email.pollIntervalMs, connect: overrides.imap })
        : undefined,
    };
  };
  const email = new Live(buildEmail(config, true), { start: (v) => v.poller?.start(), stop: (v) => v.poller?.stop() });
  // --- end email ---

  // --- Social: accounts checked against the adapters, executors, media, scheduled posts; inbound starts in start() ---
  const socialAdapters = overrides.socialAdapters ?? socialPlatformAdapters;
  function socialProblem(account: SocialAccount): string | undefined {
    try {
      validateSocialCredentials([account], socialAdapters);
      verticals.require(account.vertical);
      return undefined;
    } catch (err) {
      return (err as Error).message.replace(/^SOCIAL_ACCOUNTS is invalid: /, "");
    }
  }
  /** `strict` (boot, Railway's SOCIAL_ACCOUNTS only): a bad account stops the server, as before. */
  const buildSocial = (c: Config, strict = false) => {
    // On reload, one unusable account (shown on the Accounts page) mustn't take the others down with it.
    const usable = strict ? c.social.accounts : c.social.accounts.filter((a) => {
      const problem = socialProblem(a);
      if (problem) console.warn(`[social] skipping ${a.id}: ${problem}`);
      return !problem;
    });
    const accounts = validateSocialCredentials(usable, socialAdapters);
    if (strict) for (const a of accounts) verticals.require(a.vertical);
    return {
      accounts,
      executors: accounts.length ? createSocialExecutors(accounts, { adapters: socialAdapters, scheduled: store, timeZone: config.timezone }) : {},
      inbound: accounts.length
        ? new SocialInbound({ accounts, adapters: socialAdapters, store, ingest: (e) => pipeline.ingest(e), defaultPollSeconds: c.social.defaultPollSeconds })
        : undefined,
    };
  };
  const social = new Live(buildSocial(config, true), { start: (v) => v.inbound?.start(), stop: (v) => v.inbound?.stop() });
  /** Publishes due scheduled posts; the every-minute system job calls this (a no-op with no accounts). */
  const publishScheduledPosts = async () => {
    const accounts = social.current.accounts;
    if (!accounts.length) return { published: 0, failed: 0 };
    return publishDueScheduledPosts({
      store,
      accounts,
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
  };
  // --- end social ---

  // --- storage: media and large files on the volume or Google Drive (packages/storage) ---
  // Live reload: every file's row records its backend, so reads never depend on the setting, but
  // a running backend has state (resumable Drive uploads, the disk cache) that a switch would cut
  // off. So before start() the saved setting replaces the backend outright; after that a new
  // Google refresh token applies at once (Drive asks this provider for every access token), and
  // a switch of backend, Drive folder or cache size reports that it waits for a restart.
  const googleTokens = (c: Config) => (c.storage.google ? createGoogleTokenProvider({ ...c.storage.google, fetch: overrides.googleFetch }) : undefined);
  let driveTokens = googleTokens(config);
  const liveDriveTokens: GoogleTokenProvider = {
    getAccessToken: async (o) => {
      if (!driveTokens) throw new Error("Google Drive isn't connected");
      return driveTokens.getAccessToken(o);
    },
  };
  let storageConfig = config.storage;
  let storageServing = false;
  const reloadStorage = (c: Config): string | undefined => {
    const prev = storageConfig;
    const sameBackend =
      prev.backend === c.storage.backend && !prev.google === !c.storage.google && prev.driveFolder === c.storage.driveFolder && prev.cacheBytes === c.storage.cacheBytes;
    if (storageServing && !sameBackend) return "Switching file storage takes effect after the next restart";
    if (!storageServing) storage.replaceBackends(createStorage(c, pool, { fetch: overrides.googleFetch, tokens: liveDriveTokens }));
    driveTokens = googleTokens(c);
    storageConfig = c.storage;
    return undefined;
  };
  const storage = createStorage(config, pool, { fetch: overrides.googleFetch, tokens: liveDriveTokens });
  // --- desktop: computers linked by signing in from the desktop app, each with its own worker token ---
  const desktop = new DesktopService(pool, { dataDir: config.dataDir });
  const workerAuth: WorkerAuth = async (token) => {
    if (tokenMatches(token, config.workerToken)) return { deviceId: null }; // a worker run by hand
    const device = await desktop.verify(token);
    return device ? { deviceId: device.id } : null;
  };
  const desktopDeps = {
    desktop,
    adminToken: config.adminToken,
    verifyOidc: overrides.githubOidc ?? createGithubOidcVerifier(),
    repository: config.desktopRepo,
    installerMaxBytes: 1024 * 1024 * 1024,
    trustedProxyHops: config.trustedProxyHops,
    publicBaseUrl: () => config.publicBaseUrl,
  };
  // --- end desktop ---
  // --- storage housekeeping: keep the volume from filling while files live on it (./storage-housekeeping.ts) ---
  const housekeeping = { dataDir: config.dataDir, minFreeBytes: config.storage.minFreeBytes, renderRetentionDays: config.storage.renderRetentionDays };
  const storageDeps = {
    storage,
    publicBaseUrl: config.publicBaseUrl,
    uploadMaxBytes: config.storage.uploadMaxBytes,
    workerAuth,
    refuseUpload: (bytes: number) => uploadRefusal(storage, housekeeping, bytes),
    volume: async () => {
      const disk = await diskSpace(config.dataDir);
      return disk && { ...disk, minFreeBytes: housekeeping.minFreeBytes, renderRetentionDays: housekeeping.renderRetentionDays };
    },
  };
  // Files pasted, dropped or attached in the chat box (./chat-files.ts).
  const chatFiles = new ChatFiles({ storage, dataDir: config.dataDir, uploadMaxBytes: config.storage.uploadMaxBytes, refuseUpload: storageDeps.refuseUpload });
  // --- end storage ---

  // Odoo, when configured: read tools at /mcp/odoo, writes only as (draft-policy) actions.
  // Its event poller (orders, messages, stock, deliveries, reviews) starts in start().
  const buildOdoo = (c: Config) => {
    if (!c.odoo) return { client: undefined, executors: {}, events: undefined, db: undefined };
    const client = new OdooClient(c.odoo);
    const eventsConfig = c.odooEvents;
    if (eventsConfig) for (const v of [eventsConfig.defaultVertical, ...Object.values(eventsConfig.websites)]) verticals.require(v);
    const events = eventsConfig?.sources.length
      ? new OdooEventPoller({ client, store, config: eventsConfig, instance: c.odoo.db, baseUrl: c.odoo.url, ingest: (e) => pipeline.ingest(e) })
      : undefined;
    return { client, executors: createOdooExecutors(client), events, db: c.odoo.db };
  };
  const odoo = new Live(buildOdoo(config), { start: (v) => v.events?.start(), stop: (v) => v.events?.stop() });

  // Sendcloud, when an account is set: the digest's Shipping section and read tools at /mcp/sendcloud.
  const buildShipping = (c: Config) => {
    for (const a of c.shipping.accounts) verticals.require(a.vertical);
    return c.shipping.accounts.length ? new ShippingService(c.shipping.accounts, { fetch: overrides.sendcloudFetch, baseUrl: overrides.sendcloudBaseUrl }) : null;
  };
  const shipping = new Live(buildShipping(config));

  // --- PA: reminders and lists (always), Google Calendar when CALENDAR_ACCOUNTS is set; /mcp/pa below ---
  const paStore = new PgPaStore(pool);
  const authAlerted = new Set<string>();
  const buildCalendar = (c: Config) => {
    for (const a of c.pa.calendarAccounts) verticals.require(a.vertical);
    const service = c.pa.calendarAccounts.length
      ? new CalendarService(c.pa.calendarAccounts, {
          timeZone: config.timezone,
          fetch: overrides.calendarFetch,
          // A revoked or expired refresh token: one push per account per server day, pointing at the Accounts page.
          onAuthError: (err) => {
            const key = `${err.accountId}:${new Date().toISOString().slice(0, 10)}`;
            if (authAlerted.has(key)) return;
            authAlerted.add(key);
            void notifier
              .notify({
                title: "Calendar disconnected",
                body: `${err.message.slice(0, 240)} Reconnect it on the Accounts page.`,
                url: "/accounts",
                category: "alert",
                vertical: "personal",
                tag: `calendar-auth-${err.accountId}`,
              })
              .catch(() => {});
          },
        })
      : null;
    return { service, executors: service ? createCalendarExecutors(service) : {} };
  };
  const calendar = new Live(buildCalendar(config));
  const paSigningSecret = createHash("sha256").update(`pa-push:${config.adminToken}`).digest("hex");
  const deliverReminders = () =>
    deliverDueReminders(paStore, ({ reminder, dueAt, title, body }) =>
      notifier.notify({
        title,
        body,
        url: "/today",
        category: "reminder",
        priority: "high",
        vertical: reminder.vertical,
        tag: `reminder-${reminder.id}`,
        renotify: true,
        ...reminderPushActions(paSigningSecret, reminder.id, dueAt),
      }),
    );
  // --- end pa ---

  const workers = new WorkerService(store, hub);

  // --- Voice keys: server speech providers (optional) and the video narration keys ---
  const buildVoice = (c: Config) => ({
    ...(overrides.voiceProviders ?? createVoiceProviders(c.voice.providers)),
    videoTts: videoTtsFromConfig(c.voice.providers),
  });
  const voice = new Live(buildVoice(config));
  // --- end voice keys ---

  // --- video (packages/video): video.produce → worker capture/render jobs → social.campaign draft ---
  const video: VideoProductions = new VideoProductions({
    submit: (job) => workers.submit(job),
    propose: (proposal, options) => actions.propose(proposal, options),
    notify: (n) => notifier.notify(n),
    hasAction: (type) => type in actions.executors,
    media: overrides.videoMedia ?? (config.publicBaseUrl ? videoMediaFromStorage(storage, config.publicBaseUrl) : undefined), // storage
    get tts() {
      return voice.current.videoTts; // read per job: VideoProductions keeps this object
    },
  });
  workers.onJobSettled((job) => video.onJobSettled(job));
  // --- end video ---

  // Resolved when a proposal is made or approved, so one approved after a reload uses the new credentials.
  const paExecutors = createPaExecutors(paStore, { timeZone: config.timezone });
  const videoExecutors = video.executors();
  // Coding roles (a role with a repo, e.g. the Software Lead): their checkout and github.pr.create (./code.ts).
  const code: CodeOptions = overrides.code ?? { token: config.githubToken };
  const codeExecutors = createCodeExecutors({
    ...code,
    locate: (vertical) => {
      const role = verticals.get(vertical) ? verticals.roles(vertical).find((r) => r.repo) : undefined;
      return role?.repo ? { roleDir: join(config.dataDir, "workspaces", vertical, role.id), repo: role.repo } : null;
    },
  });
  let executorCache: { from: unknown[]; executors: Record<string, ActionExecutor> } | undefined;
  const executors = () => {
    const from = [calendar.current, email.current, odoo.current, social.current];
    if (!executorCache || from.some((v, i) => v !== executorCache!.from[i])) {
      executorCache = {
        from,
        executors: {
          ...builtinExecutors,
          ...paExecutors,
          ...calendar.current.executors,
          ...email.current.executors,
          ...odoo.current.executors,
          ...social.current.executors,
          ...videoExecutors,
          ...codeExecutors,
        },
      };
    }
    return executorCache.executors;
  };
  const actions: ActionService = new ActionService(store, hub, verticals, { brain, notifier }, executors);
  actions.onDecided = (p) => notifications.resolveProposal(p.id); // notifications: clear its approval request
  // org: role and policy changes from the Org page, over the code manifests; applied to `verticals` live
  const org = new OrgConfigService(pool, verticals, { skillsDir: config.skillsDir, actionTypes: () => Object.keys(actions.executors) });
  // pa: Dave writes directly; a run writes directly only if its task came from chat/cron/system, else it proposes.
  const paMcpServer = (caller: Caller) =>
    createPaMcpServer({
      store: paStore,
      calendar: calendar.current.service,
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
  // mail: read-only search and attachments. A run reads its own business's mailboxes (the Chief of
  // Staff every one), and once it has read mail its proposals are drafts, as for an emailed task.
  const mailMcpServer = (caller: Caller) => {
    const all = email.current.accounts;
    const scope = caller.kind === "run" ? caller.scope : null;
    return createMailMcpServer({
      accounts: !scope || scope.role === ROOT_ROLE_ID ? all : all.filter((a) => a.vertical === scope.vertical),
      connect: overrides.imap,
      onRead: scope ? () => actions.markReadMail(scope.taskId) : undefined,
    });
  };
  /** The servers at /mcp/<name> besides brain and actions; odoo only while Odoo is configured, mail while a mailbox is. */
  const extraMcpServers = (): Record<string, (caller: Caller) => McpServer> => {
    const client = odoo.current.client;
    return {
      ...(client ? { odoo: () => createOdooMcpServer(client) } : {}),
      ...(email.current.accounts.length ? { mail: mailMcpServer } : {}),
      ...(shipping.current
        ? {
            // A run sees its own business's parcels (the Chief of Staff every one's).
            sendcloud: (caller: Caller) =>
              createSendcloudMcpServer(shipping.current!, caller.kind === "run" && caller.scope.role !== ROOT_ROLE_ID ? caller.scope.vertical : null),
          }
        : {}),
      pa: paMcpServer,
      // Read-only GitHub for coding roles (pull requests, CI, issues), with the server's token.
      ...(code.token
        ? {
            github: (caller: Caller) => {
              const vertical = caller.kind === "run" ? caller.scope.vertical : verticals.all().find((v) => verticals.roles(v.id).some((r) => r.repo))?.id;
              const repo = vertical ? verticals.roles(vertical).find((r) => r.repo)?.repo : undefined;
              return createGithubMcpServer({ token: code.token!, repo: repo ?? "unknown/unknown", fetch: code.fetch });
            },
          }
        : {}),
    };
  };
  const runTokens = new RunTokens();
  // A "running" task untouched this long is a crashed run. pg-boss redelivers a job only after that.
  const staleRunSeconds = Math.ceil(config.agent.timeoutMs / 1000) + 300;
  const queue = overrides.queue ?? new PgBossTaskQueue(config.databaseUrl, config.agent.concurrency, staleRunSeconds + 300);
  const budget = new BudgetService(store, verticals, notifier, { dailyBudgetUsd: config.agent.dailyBudgetUsd, timezone: config.timezone });
  // The buying and late lists: what the Odoo stock and deliveries pollers last saw (their checkpoints).
  const odooSnapshot = async () => {
    const { db, events } = odoo.current;
    if (!db || !events) return null;
    const [stock, deliveries] = await Promise.all([store.getOdooCheckpoint(`${db}:stock`), store.getOdooCheckpoint(`${db}:deliveries`)]);
    const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
    return { lowStock: list<OdooStockNow>(stock?.state.current), lateDeliveries: list<OdooLateNow>(deliveries?.state.current) };
  };
  const shippingDigest = async (vertical: string, start: Date, end: Date, now: Date) => shipping.current?.digest(vertical, start, end, now) ?? null;
  const digests = new DigestService(store, brain, verticals, notifier, budget, config.timezone, odooSnapshot, shippingDigest);
  // --- Voice: server speech providers (optional), briefing, task conversations ---
  const voiceConversations = new VoiceConversations(store, hub, queue);
  // Self-hosted speech (open models on this server; no keys) and Drive mode's warm voice front.
  const localSpeech = overrides.localSpeech !== undefined ? overrides.localSpeech : config.voice.local ? new LocalSpeech(config.voice.local) : null;
  /** The agent settings now in force (env, then the Accounts page's Claude connection), for the voice front. */
  let agentConfig = config;
  const voiceFront =
    overrides.voiceFront !== undefined
      ? overrides.voiceFront
      : config.voice.front
        ? new VoiceFront({
            bin: config.agent.claudeBin,
            // The live agent settings: a Claude sign-in saved on the Accounts page applies here too.
            env: () => agentEnv(agentConfig, "subscription"),
            model: config.voice.front.model,
            cwd: join(config.dataDir, "voice-front"),
            timeZone: config.timezone,
          })
        : null;
  // Getters: VoiceService reads these per request, so a reloaded key or calendar applies at once.
  const voiceService = new VoiceService(store, verticals, budget, {
    get stt() {
      return voice.current.stt;
    },
    get tts() {
      return voice.current.tts;
    },
    get calendar() {
      const service = calendar.current.service;
      return overrides.voiceCalendar ?? (service ? paVoiceCalendar(service) : undefined);
    },
    local: localSpeech,
    maxUploadBytes: config.voice.maxUploadBytes,
    maxSeconds: config.voice.maxSeconds,
    language: config.voice.language,
    timezone: config.timezone,
  });
  // --- end voice ---
  // Runner and triager: delegates to the current instance, so a new token or key applies to the next run.
  const runner = new Live<AgentRunner>(overrides.runner ?? createRunner(config));
  const triager = new Live<Triager>(overrides.triager ?? createTriager(config));
  const pipeline = new Pipeline({
    store,
    hub,
    triager: {
      get name() {
        return triager.current.name;
      },
      triage: (event, context) => triager.current.triage(event, context),
    },
    verticals,
    runner: {
      get name() {
        return runner.current.name;
      },
      run: (request, onMessage) => runner.current.run(request, onMessage),
    },
    queue,
    brain,
    actions,
    runTokens,
    dataDir: config.dataDir,
    skillsDir: config.skillsDir,
    internalBaseUrl: config.internalBaseUrl,
    maxTurns: config.agent.maxTurns,
    notifier, // pushes for filed events that ask for one (incoming RFQs, supplier replies)
    code,
    budget,
    guards: {
      maxConcurrentPerVertical: config.agent.maxConcurrentPerVertical,
      busyRetrySeconds: config.agent.busyRetrySeconds,
      staleRunSeconds,
      dedupeWindowMinutes: config.agent.dedupeWindowMinutes,
    },
    mcpServers: () => ["brain", ...Object.keys(extraMcpServers())],
    voice: voiceConversations,
    chatFilesReadRule: chatFiles.readRule(),
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

  // --- integrations oauth: "Connect" sign-ins (start + calendars under /api, provider callbacks at /oauth) ---
  const oauth = integrationOAuth({ service: integrations, store: integrationStore, auth, authHttp, publicBaseUrl: () => config.publicBaseUrl, verticals: () => verticals.all().map((v) => v.id), fetch: overrides.integrationsFetch });
  app.route("/api", oauth.api);
  app.route("/oauth", oauth.callbacks);
  // --- end integrations oauth ---

  app.get(
    "/ws/voice",
    voiceListenHandler(upgradeWebSocket, {
      adminToken: config.adminToken,
      sessions: wsSessions,
      openStream: (onText) => (localSpeech?.asrReady ? localSpeech.openStream(onText) : null),
    }),
  );
  app.get("/ws", wsHandler(upgradeWebSocket, { hub, workers, adminToken: config.adminToken, workerAuth, devices: desktop, sessions: wsSessions }));
  const socialDeps = {
    store,
    actions,
    get accounts() {
      return social.current.accounts;
    },
    adapters: socialAdapters,
    timeZone: config.timezone,
    media: { blobs: storage, maxBytes: config.media.maxBytes, publicBaseUrl: config.publicBaseUrl },
  };
  const pa = {
    store: paStore,
    get calendar() {
      return calendar.current.service;
    },
    timeZone: config.timezone,
    signingSecret: paSigningSecret,
  };
  // Worker uploads and local chunk uploads carry their own credentials, so they sit before /api's auth.
  app.route("/api", storagePublicRoutes(storageDeps)); // storage
  app.route("/api", desktopPublicRoutes(desktopDeps)); // desktop: link handshake and installer upload
  app.route("/api", apiRoutes({ store, pipeline, actions, workers, brain, verticals, notifier, budget, digests, adminToken: config.adminToken, webhookSecret: config.webhookSecret, social: socialDeps, storage: storageDeps, auth: { service: auth, options: authHttp }, voice: { service: voiceService, conversations: voiceConversations, front: () => (overrides.voiceFront !== undefined || agentConfig.agent.runner === "claude-code" ? voiceFront : null) }, notifications, pa, integrations, claudeSetup, org, desktop: desktopDeps, chatFiles, help: config.help }));
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
  // Streamed from the BlobStore (volume, cache or Drive); the URL scheme is unchanged.
  app.route("/media", mediaRoutes(storage));

  if (config.webDistDir) {
    const root = config.webDistDir;
    // The entry points must never be cached, or an installed app keeps running an old build.
    app.use("/*", async (c, next) => {
      await next();
      const p = c.req.path;
      if (p === "/sw.js" || p === "/version.json" || c.res.headers.get("content-type")?.startsWith("text/html")) {
        c.res.headers.set("cache-control", "no-store");
      }
    });
    app.use("/*", serveStatic({ root }));
    // Single-page app: unknown paths get index.html so client-side routes work on reload.
    app.get("*", async (c) => c.html(await readFile(join(root, "index.html"), "utf8"), 200, { "cache-control": "no-store" }));
  }

  // --- integrations: rebuild what a saved or removed account changed (see integrations/live.ts) ---
  const swaps: Record<Group, (c: Config) => Promise<string | undefined> | string | undefined> = {
    runner: (c) => {
      // The voice front signs in like the agents: a new sign-in restarts its warm session.
      agentConfig = c;
      voiceFront?.stop();
      return overrides.runner ? undefined : runner.swap(() => createRunner(c));
    },
    triage: (c) => (overrides.triager ? undefined : triager.swap(() => createTriager(c))),
    voice: (c) => voice.swap(() => buildVoice(c)),
    odoo: (c) => odoo.swap(() => buildOdoo(c)),
    shipping: (c) => shipping.swap(() => buildShipping(c)),
    email: (c) => email.swap(() => buildEmail(c)),
    social: (c) => social.swap(() => buildSocial(c)),
    calendar: (c) => calendar.swap(() => buildCalendar(c)),
    storage: (c) => reloadStorage(c),
  };
  integrations.setReloader(async (next, groups) => {
    const failed: Partial<Record<Group, string>> = {};
    for (const group of groups) {
      try {
        const error = await swaps[group](next);
        if (error) failed[group] = error;
      } catch (err) {
        failed[group] = err instanceof Error ? err.message : String(err);
      }
      if (failed[group]) console.warn(`[integrations] ${group} kept its previous setup: ${failed[group]}`);
    }
    return failed;
  });
  integrations.onChange(() => hub.broadcast({ type: "integrations.updated" }));
  // --- end integrations reload ---

  let crons: ReturnType<typeof startSchedules> = [];
  /** Vertical, role and Chief of Staff schedules: restarted whenever the org changes. */
  let scheduleCrons: ReturnType<typeof startSchedules> = [];
  let started = false;
  const restartSchedules = () => {
    for (const c of scheduleCrons) c.stop();
    scheduleCrons = [];
    if (!started || !config.schedulesEnabled) return;
    // Vertical and role schedules, plus the Chief of Staff's (the morning brief) in its home vertical.
    const root = { vertical: verticals.rootVertical, role: verticals.root.id, schedules: verticals.root.schedules };
    scheduleCrons = startSchedules(verticals.all(), (e) => pipeline.ingest(e), root);
  };
  org.onChange(() => {
    restartSchedules();
    hub.broadcast({ type: "org.updated" });
  });
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
    /** The current Odoo event poller (none unless Odoo and its events are set up). */
    get odooEvents() {
      return odoo.current.events;
    },
    paStore,
    /** The current Google Calendar service, or null. */
    get calendar() {
      return calendar.current.service;
    },
    /** Sends due reminders; the every-minute system job calls this. */
    deliverReminders,
    storage,
    integrations,
    org,
    async start() {
      await migrate(pool);
      // Self-hosted speech models download once in the background; until then voice uses browser speech.
      if (localSpeech && process.env.NODE_ENV !== "test") void localSpeech.install();
      secretBox = await SecretBox.load({ key: config.credentialsKey, keyFile: join(config.dataDir, "credentials.key") }); // integrations
      await integrations.load(); // integrations: saved accounts over the env config, before anything polls
      await auth.warm();
      await org.load(); // org: changes saved on the Org page, before any task runs
      await store.markAllNodesOffline();
      // brain: import the git brain into an empty database once (only from a good checkout), seed, then mirror back to git.
      if (brainGit && brainMirror) {
        try {
          await brainGit.init();
          await brainMirror.importIfEmpty();
        } catch (err) {
          console.error("[brain] git checkout failed, skipping import and mirror:", (err as Error).message);
          brainMirror = null;
        }
      }
      await brain.init();
      brainMirror?.schedule();
      await storage.init(); // storage: index media from before the index, load the cache
      storageServing = true; // storage: from here a backend switch waits for a restart
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
        lowStockCron: config.lowStockCron,
        lowStock: () => digests.deliverLowStock(),
        rollover,
        socialPublish: publishScheduledPosts, // a no-op until a social account is set up
        paReminders: deliverReminders,
        integrationsRefresh: () => refreshExpiringTokens({ service: integrations, notifier, fetch: overrides.integrationsFetch }), // --- integrations oauth ---
        storageHousekeeping: () =>
          storageHousekeeping({
            storage,
            options: housekeeping,
            pendingPayloads: async () => (await store.listProposals({ status: "pending", limit: 1000 })).map((p) => p.payload),
            notify: (n) => notifier.notify({ ...n, category: "alert", tag: "storage-full" }),
          }),
      });
      notificationCrons = startNotificationJobs(notifications, config.timezone); // notifications: quiet-hours release, quick briefing
      started = true;
      restartSchedules();
      // Pollers: whatever is current now (the env config with saved accounts applied); later reloads start their own.
      await email.start();
      await social.start();
      await odoo.start();
    },
    async stop() {
      await claudeSetup.cancel();
      brainMirror?.stop();
      for (const c of crons) c.stop();
      for (const c of scheduleCrons) c.stop();
      for (const c of notificationCrons) c.stop();
      await email.stop();
      voiceFront?.stop();
      await social.stop();
      await odoo.stop();
      await queue.stop();
      await pool.end();
    },
  };
}
