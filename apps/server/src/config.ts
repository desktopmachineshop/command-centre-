import { resolve } from "node:path";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  /** Bearer token for the dashboard API and client WebSockets. */
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  /** Token desktop worker nodes present; defaults to ADMIN_TOKEN. */
  WORKER_TOKEN: z.string().min(16).optional(),
  /** Shared secret for POST /api/ingress/webhook/:vertical (header x-cc-webhook-secret). */
  WEBHOOK_SECRET: z.string().min(16).optional(),

  DATA_DIR: z.string().default("./data"),
  BRAIN_DIR: z.string().optional(),
  /** Private git remote for the brain, e.g. https://<token>@github.com/you/brain.git */
  BRAIN_REMOTE_URL: z.string().optional(),
  SKILLS_DIR: z.string().optional(),
  /** Built PWA to serve at /. */
  WEB_DIST_DIR: z.string().optional(),
  /** Base URL agents use to reach this server's MCP endpoints. */
  INTERNAL_BASE_URL: z.string().optional(),

  /** "claude-code" (default) or "echo" to run without any model. */
  AGENT_RUNNER: z.enum(["claude-code", "echo"]).default("claude-code"),
  CLAUDE_BIN: z.string().default("claude"),
  /** Optional API key used only when the subscription hits its usage limit. */
  ANTHROPIC_FALLBACK_API_KEY: z.string().optional(),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(30),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AGENT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Global cap on agent spend per day (see DAY_TIMEZONE); unset means no cap. */
  AGENT_DAILY_BUDGET_USD: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  /** Runs per vertical at once, so one noisy vertical can't take every worker slot. */
  AGENT_MAX_CONCURRENT_PER_VERTICAL: z.coerce.number().int().positive().default(1),
  /** How long a task waits before trying again when its vertical is at its run limit. */
  AGENT_BUSY_RETRY_SECONDS: z.coerce.number().positive().default(20),
  /** An identical prompt for the same vertical within this window is linked, not re-run. 0 turns it off. */
  AGENT_DEDUPE_WINDOW_MINUTES: z.coerce.number().min(0).default(10),

  SCHEDULES_ENABLED: bool.default(true),
  /** Timezone that defines "today" for budgets and digests. */
  DAY_TIMEZONE: z.string().default("Europe/London"),
  /** When the daily digest is written, in DAY_TIMEZONE. "off" disables it. */
  DIGEST_CRON: z.string().default("30 18 * * *"),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.DATA_DIR);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    adminToken: e.ADMIN_TOKEN,
    workerToken: e.WORKER_TOKEN ?? e.ADMIN_TOKEN,
    webhookSecret: e.WEBHOOK_SECRET,
    dataDir,
    brainDir: resolve(e.BRAIN_DIR ?? `${dataDir}/brain`),
    brainRemoteUrl: e.BRAIN_REMOTE_URL || undefined,
    skillsDir: resolve(e.SKILLS_DIR ?? "../../skills"),
    webDistDir: e.WEB_DIST_DIR ? resolve(e.WEB_DIST_DIR) : undefined,
    internalBaseUrl: e.INTERNAL_BASE_URL ?? `http://127.0.0.1:${e.PORT}`,
    agent: {
      runner: e.AGENT_RUNNER,
      claudeBin: e.CLAUDE_BIN,
      fallbackApiKey: e.ANTHROPIC_FALLBACK_API_KEY || undefined,
      maxTurns: e.AGENT_MAX_TURNS,
      timeoutMs: e.AGENT_TIMEOUT_MS,
      concurrency: e.AGENT_CONCURRENCY,
      dailyBudgetUsd: e.AGENT_DAILY_BUDGET_USD,
      maxConcurrentPerVertical: e.AGENT_MAX_CONCURRENT_PER_VERTICAL,
      busyRetrySeconds: e.AGENT_BUSY_RETRY_SECONDS,
      dedupeWindowMinutes: e.AGENT_DEDUPE_WINDOW_MINUTES,
    },
    schedulesEnabled: e.SCHEDULES_ENABLED,
    timezone: e.DAY_TIMEZONE,
    digestCron: e.DIGEST_CRON === "off" || !e.DIGEST_CRON ? undefined : e.DIGEST_CRON,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
        : undefined,
  };
}
