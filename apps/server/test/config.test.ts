import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineVertical } from "@cc/core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "admin-token-for-tests-0123456789" };

/** `KEY=value` lines of an env file, as docker compose's env_file reads them. */
function parseEnvFile(path: string) {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

describe("config", () => {
  it("loads a copy of .env.example with only DATABASE_URL and ADMIN_TOKEN filled in", () => {
    const env = parseEnvFile(fileURLToPath(new URL("../../../.env.example", import.meta.url)));
    expect(env).toHaveProperty("WORKER_TOKEN", "");
    const config = loadConfig({ ...env, ...base });
    expect(config).toMatchObject({
      workerToken: base.ADMIN_TOKEN,
      webhookSecret: undefined,
      timezone: "Europe/London",
      digestCron: "30 18 * * *",
      schedulesEnabled: true,
      odoo: undefined,
      email: { accounts: [], pollIntervalMs: 300_000 },
    });
    expect(config.agent).toMatchObject({ dailyBudgetUsd: undefined, dedupeWindowMinutes: 10 });
  });

  it("treats every blank optional variable as unset", () => {
    const defaults = loadConfig(base);
    const optional = [
      "PORT", "WORKER_TOKEN", "WEBHOOK_SECRET", "DATA_DIR", "AGENT_RUNNER", "AGENT_MAX_TURNS", "AGENT_DAILY_BUDGET_USD",
      "AGENT_MAX_CONCURRENT_PER_VERTICAL", "AGENT_BUSY_RETRY_SECONDS", "AGENT_DEDUPE_WINDOW_MINUTES", "SCHEDULES_ENABLED",
      "DAY_TIMEZONE", "DIGEST_CRON", "TRIAGE_MIN_CONFIDENCE", "VAPID_SUBJECT", "EMAIL_ACCOUNTS", "EMAIL_POLL_INTERVAL_SECONDS", "ODOO_API",
    ];
    for (const key of optional) expect(loadConfig({ ...base, [key]: "" }), key).toEqual(defaults);
    expect(loadConfig({ ...base, AGENT_DEDUPE_WINDOW_MINUTES: "" }).agent.dedupeWindowMinutes).toBe(10);
    expect(loadConfig({ ...base, AGENT_DEDUPE_WINDOW_MINUTES: "0" }).agent.dedupeWindowMinutes).toBe(0);
  });

  it("still requires DATABASE_URL and ADMIN_TOKEN", () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: "" })).toThrow(/ADMIN_TOKEN must be at least 16/);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("rejects an unknown timezone at load", () => {
    expect(loadConfig({ ...base, DAY_TIMEZONE: "America/New_York" }).timezone).toBe("America/New_York");
    expect(() => loadConfig({ ...base, DAY_TIMEZONE: "Mars/Olympus" })).toThrow(/DAY_TIMEZONE/);
    expect(() =>
      defineVertical({ id: "x", name: "x", description: "", brainFolder: "x", schedules: [{ id: "s", cron: "0 7 * * *", timezone: "Europe/Londn", prompt: "p" }] }),
    ).toThrow(/timezone/);
  });

  it("turns the digest off with DIGEST_CRON=off", () => {
    expect(loadConfig({ ...base, DIGEST_CRON: "off" }).digestCron).toBeUndefined();
  });
});

describe("DIGEST_CRON", () => {
  it("rejects an invalid cron (e.g. quotes kept by docker --env-file) at load", () => {
    expect(() => loadConfig({ ...base, DIGEST_CRON: '"30 18 * * *"' })).toThrow(/DIGEST_CRON/);
    expect(loadConfig({ ...base, DIGEST_CRON: "30 18 * * *" }).digestCron).toBe("30 18 * * *");
  });
});
