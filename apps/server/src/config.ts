import { resolve } from "node:path";
import { type EmailAccount, parseEmailAccounts } from "@cc/email";
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

  SCHEDULES_ENABLED: bool.default(true),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  // --- Email (see docs/SETUP.md, "Email") ---
  /** JSON array of IMAP/SMTP accounts; see `EmailAccount` in @cc/email. */
  EMAIL_ACCOUNTS: z.string().optional(),
  /** How often to re-check each mailbox; IDLE usually delivers new mail sooner. */
  EMAIL_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
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
    },
    schedulesEnabled: e.SCHEDULES_ENABLED,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
        : undefined,
    email: { accounts: emailAccounts, pollIntervalMs: e.EMAIL_POLL_INTERVAL_SECONDS * 1000 },
  };
}
