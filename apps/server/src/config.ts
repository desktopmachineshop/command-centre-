import { resolve } from "node:path";
import { isTimeZone } from "@cc/core";
import { type EmailAccount, parseEmailAccounts } from "@cc/email";
import { parseSocialAccounts, type SocialAccount } from "@cc/social";
import { Cron } from "croner";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** Variables that must be set; every other blank one (e.g. `WORKER_TOKEN=` in .env.example) counts as unset. */
const REQUIRED = new Set(["DATABASE_URL", "ADMIN_TOKEN"]);

function withoutBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => REQUIRED.has(k) || v?.trim() !== ""));
}

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  /** Bearer token for automation, MCP and first-run setup; people sign in with email + password (src/accounts). */
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  /** Token desktop worker nodes present; defaults to ADMIN_TOKEN. */
  WORKER_TOKEN: z.string().min(16).optional(),
  /** Shared secret for POST /api/ingress/webhook/:vertical (header x-cc-webhook-secret). */
  WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Reverse proxies in front of the server (Railway: 1). Picks the client IP from X-Forwarded-For for sign-in rate limits; 0 ignores the header. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

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
  AGENT_DAILY_BUDGET_USD: z.coerce.number().positive().optional(),
  /** Runs per vertical at once, so one noisy vertical can't take every worker slot. */
  AGENT_MAX_CONCURRENT_PER_VERTICAL: z.coerce.number().int().positive().default(1),
  /** How long a task waits before trying again when its vertical is at its run limit. */
  AGENT_BUSY_RETRY_SECONDS: z.coerce.number().positive().default(20),
  /** An identical prompt for the same vertical within this window is linked, not re-run. 0 turns it off. */
  AGENT_DEDUPE_WINDOW_MINUTES: z.coerce.number().min(0).default(10),

  SCHEDULES_ENABLED: bool.default(true),
  /** Timezone that defines "today" for budgets and digests. */
  DAY_TIMEZONE: z.string().refine(isTimeZone, "not a known IANA timezone").default("Europe/London"),
  /** When the daily digest is written, in DAY_TIMEZONE. "off" disables it. */
  DIGEST_CRON: z
    .string()
    .default("30 18 * * *")
    .refine((v) => v === "off" || isCron(v), "must be a 5-field cron expression or \"off\""),

  // --- Triage (model triagers are added to the chain only when their key is set) ---
  /** TypeSafe Jev API key. */
  JEV_API_KEY: z.string().optional(),
  /** Default https://api.typesafe.ai; or a LiteLLM proxy's /typesafe path. */
  JEV_BASE_URL: z.string().optional(),
  /** Default jev-latest. */
  JEV_MODEL: z.string().optional(),
  /** Anthropic API key for the Haiku fallback classifier (separate from the agent fallback key). */
  ANTHROPIC_TRIAGE_API_KEY: z.string().optional(),
  /** The chain takes the first triager at or above this confidence. */
  TRIAGE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  // --- Email (see docs/SETUP.md, "Email") ---
  /** JSON array of IMAP/SMTP accounts; see `EmailAccount` in @cc/email. */
  EMAIL_ACCOUNTS: z.string().optional(),
  /** How often to re-check each mailbox; IDLE usually delivers new mail sooner. */
  EMAIL_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  // --- Social (see docs/SETUP.md, "Social") ---
  /** JSON array of social accounts; see `SocialAccount` in @cc/social. */
  SOCIAL_ACCOUNTS: z.string().optional(),
  /** Poll interval for platforms whose adapter doesn't suggest one. */
  SOCIAL_POLL_DEFAULT_SECONDS: z.coerce.number().int().positive().default(300),
  /** Public origin of this server, for media URLs platforms fetch, e.g. https://command.desktopmachineshop.com */
  PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Largest upload POST /api/media accepts. */
  MEDIA_MAX_MB: z.coerce.number().positive().default(200),
  /** Odoo external API. Set all four to enable the odoo MCP server and Odoo actions. */
  ODOO_URL: z.string().optional(),
  ODOO_DB: z.string().optional(),
  ODOO_USERNAME: z.string().optional(),
  ODOO_API_KEY: z.string().optional(),
  /** "jsonrpc" (default, Odoo 14+) or "json2" (Odoo 19+). */
  ODOO_API: z.enum(["jsonrpc", "json2"]).default("jsonrpc"),
});

function odooConfig(e: z.infer<typeof Env>) {
  const values = { url: e.ODOO_URL, db: e.ODOO_DB, username: e.ODOO_USERNAME, apiKey: e.ODOO_API_KEY };
  const set = Object.values(values).filter(Boolean).length;
  if (set === 0) return undefined;
  if (set < 4) throw new Error("Invalid configuration:\n  ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY must all be set to enable Odoo");
  return { ...(values as Record<keyof typeof values, string>), api: e.ODOO_API };
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  let emailAccounts: EmailAccount[];
  try {
    emailAccounts = parseEmailAccounts(e.EMAIL_ACCOUNTS);
  } catch (err) {
    throw new Error(`Invalid configuration:\n  ${(err as Error).message}`);
  }
  let socialAccounts: SocialAccount[];
  try {
    // Shape and unique ids only: credentials are checked against the adapters the server runs (app.ts).
    socialAccounts = parseSocialAccounts(e.SOCIAL_ACCOUNTS, { checkCredentials: false });
  } catch (err) {
    throw new Error(`Invalid configuration:\n  ${(err as Error).message}`);
  }
  const dataDir = resolve(e.DATA_DIR);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    adminToken: e.ADMIN_TOKEN,
    workerToken: e.WORKER_TOKEN ?? e.ADMIN_TOKEN,
    webhookSecret: e.WEBHOOK_SECRET,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
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
    triage: {
      jevApiKey: e.JEV_API_KEY || undefined,
      jevBaseUrl: e.JEV_BASE_URL || undefined,
      jevModel: e.JEV_MODEL || undefined,
      anthropicApiKey: e.ANTHROPIC_TRIAGE_API_KEY || undefined,
      minConfidence: e.TRIAGE_MIN_CONFIDENCE,
    },
    timezone: e.DAY_TIMEZONE,
    digestCron: e.DIGEST_CRON === "off" || !e.DIGEST_CRON ? undefined : e.DIGEST_CRON,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
        : undefined,
    email: { accounts: emailAccounts, pollIntervalMs: e.EMAIL_POLL_INTERVAL_SECONDS * 1000 },
    odoo: odooConfig(e),
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    social: { accounts: socialAccounts, defaultPollSeconds: e.SOCIAL_POLL_DEFAULT_SECONDS },
    media: { maxBytes: Math.round(e.MEDIA_MAX_MB * 1024 * 1024) },
  };
}

/** True when croner accepts the pattern (catches e.g. quotes left in from an env file). */
function isCron(pattern: string): boolean {
  try {
    new Cron(pattern, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}
