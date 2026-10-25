import { MemoryMailbox } from "@cc/email";
import { demoModels, FakeOdoo } from "@cc/odoo/testing";
import type { InboundItem, PlatformAdapter } from "@cc/social";
import { validateAgainstCapabilities } from "@cc/social";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentEnv } from "../src/app";
import { loadConfig } from "../src/config";
import { Live } from "../src/integrations";
import { ADMIN, DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("agent environment", () => {
  const server = {
    PATH: "/usr/bin",
    HOME: "/home/cc",
    HTTPS_PROXY: "http://proxy:3128",
    CLAUDE_CONFIG_DIR: "/data/claude",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-env",
    ANTHROPIC_API_KEY: "sk-ant-api03-from-env",
    ODOO_API_KEY: "odoo-secret",
    DATABASE_URL: "postgres://u:p@db/cc",
    ADMIN_TOKEN: "admin-secret",
    EMAIL_ACCOUNTS: '[{"imap":{"pass":"x"}}]',
    SOCIAL_ACCOUNTS: "[]",
    GOOGLE_REFRESH_TOKEN: "1//refresh",
  };
  const config = loadConfig({
    DATABASE_URL: "postgres://x",
    ADMIN_TOKEN: ADMIN,
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-config",
    ANTHROPIC_FALLBACK_API_KEY: "sk-ant-api03-fallback",
  });

  it("passes only an allowlist, plus the run's own credential", () => {
    const env = agentEnv(config, "subscription", server);
    for (const leaked of ["ODOO_API_KEY", "DATABASE_URL", "ADMIN_TOKEN", "EMAIL_ACCOUNTS", "SOCIAL_ACCOUNTS", "GOOGLE_REFRESH_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(env[leaked]).toBeUndefined();
    }
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/cc", HTTPS_PROXY: "http://proxy:3128", CLAUDE_CONFIG_DIR: "/data/claude" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-from-config");
  });

  it("gives the API run the key and never the subscription token", () => {
    const env = agentEnv(config, "api", server);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fallback");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ODOO_API_KEY).toBeUndefined();
  });
});

describe("Live", () => {
  const poller = (name: string, log: string[]) => ({ start: () => log.push(`start ${name}`), stop: async () => void log.push(`stop ${name}`) });
  const hooks = { start: (p: ReturnType<typeof poller>) => p.start(), stop: (p: ReturnType<typeof poller>) => p.stop() };

  it("starts nothing before start(), then swaps stop-old/start-new", async () => {
    const log: string[] = [];
    const live = new Live(poller("a", log), hooks);
    expect(await live.swap(() => poller("b", log))).toBeUndefined();
    expect(log).toEqual([]);
    await live.start();
    expect(await live.swap(() => poller("c", log))).toBeUndefined();
    await live.stop();
    expect(log).toEqual(["start b", "stop b", "start c", "stop c"]);
  });

  it("keeps the old instance when building the new one fails", async () => {
    const log: string[] = [];
    const a = poller("a", log);
    const live = new Live(a, hooks);
    await live.start();
    expect(
      await live.swap(() => {
        throw new Error("no such business");
      }),
    ).toBe("no such business");
    expect(live.current).toBe(a);
    expect(log).toEqual(["start a"]);
  });
});

const customerEmail = (messageId: string) =>
  new MailComposer({ from: "Jane <jane@example.com>", to: "support@example.com", subject: "Collets?", messageId, text: "Do you stock ER11?" }).compile().build();

/** A Discord stand-in: tokens must start with "good", inbound records that it is listening. */
function fakeDiscord() {
  const state = { listening: new Set<string>() };
  const adapter: PlatformAdapter = {
    platform: "discord",
    capabilities: { publish: true, reply: true, dm: false, inbound: true, media: ["image"], maxTextLength: 2000 },
    credentials: z.object({ botToken: z.string().startsWith("good", "the bot token was rejected") }),
    validate(_a, content) {
      return validateAgainstCapabilities(this.capabilities, content);
    },
    async publish() {
      return { id: "d-1" };
    },
    async reply() {
      return { id: "d-r1" };
    },
    inbound: {
      async listen(account, _emit: (item: InboundItem) => Promise<void>) {
        state.listening.add(account.id);
        return async () => void state.listening.delete(account.id);
      },
    },
  };
  return { adapter, state };
}

const KEY = "c".repeat(64);

describe.skipIf(!DB_URL)("integrations reload live", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const odooA = new FakeOdoo({ models: demoModels(), apiKey: "odoo-key-a" });
  const odooB = new FakeOdoo({ models: demoModels(), apiKey: "odoo-key-b" });
  const mailbox = new MemoryMailbox();
  const discord = fakeDiscord();
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];
  const saveOdoo = (odoo: FakeOdoo) =>
    ctx.api("/api/integrations/odoo", { method: "PUT", json: { data: { url: odoo.url, db: odoo.db, username: odoo.login }, secrets: { apiKey: odoo.apiKey } } });
  const mcpOdoo = () => ctx.server.app.request("/mcp/odoo", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });

  beforeAll(async () => {
    await odooA.start();
    await odooB.start();
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { EMAIL_POLL_INTERVAL_SECONDS: "60", CREDENTIALS_KEY: KEY }, overrides: { imap: mailbox.connector, socialAdapters: { discord: discord.adapter } } });
    runner.app = ctx.server.app;
  });
  afterAll(async () => {
    await ctx?.server.stop();
    await odooA.stop();
    await odooB.stop();
  });
  beforeEach(() => {
    calls.length = 0;
    runner.requests.length = 0;
  });

  it("connects Odoo without a restart: /mcp/odoo, agents' MCP list, and executors with the new credentials", async () => {
    expect((await mcpOdoo()).status).toBe(404);
    expect(ctx.server.actions.executors["odoo.message.post"]).toBeUndefined();

    const saved = await saveOdoo(odooA);
    expect(saved.body).toMatchObject({ ok: true, reloaded: ["odoo"], failed: {} });
    expect((await mcpOdoo()).status).not.toBe(404);

    // An agent run now gets the odoo server and can use it.
    calls.push({ server: "odoo", tool: "get_order", args: { name: "S00042" } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: where is order S00042?" } });
    await ctx.queue.drain();
    expect(Object.keys(runner.requests[0]!.mcpServers!)).toContain("odoo");
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0].result).toContain("RM123456785GB");

    // A draft proposed now and approved after the credentials change runs against the new Odoo.
    const proposal = await ctx.server.actions.propose({
      taskId: null,
      vertical: "dms",
      actionType: "odoo.message.post",
      summary: "Tell Jane her spindle ships Friday",
      payload: { model: "sale.order", id: 42, body: "<p>Ships Friday.</p>" },
    });
    expect(proposal.status).toBe("pending");
    expect((await saveOdoo(odooB)).body.reloaded).toEqual(["odoo"]);
    const approved = await ctx.api(`/api/proposals/${proposal.id}/approve`, { method: "POST" });
    expect(approved.body).toMatchObject({ status: "executed", result: { ok: true } });
    expect(odooB.callsTo("message_post")).toHaveLength(1);
    expect(odooA.callsTo("message_post")).toHaveLength(0);

    // Disconnected: gone from /mcp and from the next run's servers.
    expect((await ctx.api("/api/integrations/odoo/default", { method: "DELETE" })).body.reloaded).toEqual(["odoo"]);
    expect((await mcpOdoo()).status).toBe(404);
    calls.length = 0;
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: anything new?" } });
    await ctx.queue.drain();
    expect(Object.keys(runner.requests.at(-1)!.mcpServers!)).not.toContain("odoo");
    expect(ctx.server.actions.executors["odoo.message.post"]).toBeUndefined();
  });

  it("starts an email poller for a saved mailbox, and stops it when removed", async () => {
    const saved = await ctx.api("/api/integrations/email/shop", {
      method: "PUT",
      json: {
        data: { vertical: "dms", address: "support@example.com", imapHost: "imap.test", smtpHost: "smtp.test" },
        secrets: { password: "app-password-123" },
      },
    });
    expect(saved.body).toMatchObject({ reloaded: ["email"], failed: {} });
    expect(ctx.server.actions.executors["email.reply"]).toBeDefined();
    await waitFor(() => ctx.server.store.getEmailCheckpoint("shop"));

    mailbox.deliver(await customerEmail("<live-1@example.com>"));
    const emailEvents = async () => (await ctx.server.store.listEvents(100)).filter((e) => e.source === "email");
    await waitFor(async () => (await emailEvents()).length === 1);

    expect((await ctx.api("/api/integrations/email/shop", { method: "DELETE" })).body.reloaded).toEqual(["email"]);
    expect(ctx.server.actions.executors["email.reply"]).toBeUndefined();
    mailbox.deliver(await customerEmail("<live-2@example.com>"));
    await new Promise((r) => setTimeout(r, 300));
    expect(await emailEvents()).toHaveLength(1);
  });

  it("adds a social account live, and keeps the old setup when the new one is bad", async () => {
    const save = (id: string, botToken: string) =>
      ctx.api(`/api/integrations/discord/${id}`, { method: "PUT", json: { data: { vertical: "dms", handle: "dms" }, secrets: { botToken } } });

    expect((await save("dms-discord", "good-token-0123456789")).body).toMatchObject({ reloaded: ["social"], failed: {} });
    expect((await ctx.api("/api/social/accounts")).body.map((a: { id: string }) => a.id)).toEqual(["dms-discord"]);
    expect(ctx.server.actions.executors["social.campaign"]).toBeDefined();
    await waitFor(async () => discord.state.listening.has("dms-discord"));

    // The adapter rejects this token: refused on save, nothing stored, the working account carries on.
    const bad = await save("dms-discord-2", "bad-token-0123456789");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/bot token was rejected/);
    expect((await ctx.api("/api/social/accounts")).body.map((a: { id: string }) => a.id)).toEqual(["dms-discord"]);
    expect(discord.state.listening.has("dms-discord")).toBe(true);
    const list = (await ctx.api("/api/integrations")).body;
    expect(list.groups.social).toBeNull();
    expect(list.entries.some((e: { id: string }) => e.id === "dms-discord-2")).toBe(false);

    // An already-saved account that stops passing (here: changed straight in the database) is left out on its own.
    await ctx.server.store.pool.query("insert into integration_entries (kind, id, data) values ('discord', 'dms-broken', '{\"vertical\":\"nope\"}')");
    expect((await save("dms-discord", "good-token-0123456789")).status).toBe(200);
    const after = (await ctx.api("/api/integrations")).body;
    expect(after.entries.find((e: { id: string }) => e.id === "dms-broken").error).toBeTruthy();
    expect(after.groups.social).toBeNull();
    expect((await ctx.api("/api/social/accounts")).body.map((a: { id: string }) => a.id)).toEqual(["dms-discord"]);
    await ctx.server.store.pool.query("delete from integration_entries where id = 'dms-broken'");
  });

  it("connects a calendar live; a storage switch waits for a restart, then applies at start-up", async () => {
    expect(ctx.server.calendar).toBeNull();
    await ctx.api("/api/integrations/google-app", { method: "PUT", json: { data: { clientId: "id.apps.googleusercontent.com" }, secrets: { clientSecret: "google-secret" } } });
    const google = await ctx.api("/api/integrations/google/me", { method: "PUT", json: { data: { vertical: "personal", email: "dave@example.com" }, secrets: { refreshToken: "1//refresh-token" } } });
    expect(google.body).toMatchObject({ reloaded: expect.arrayContaining(["calendar"]), failed: {} });
    expect(ctx.server.calendar?.publicAccounts().map((a) => a.id)).toEqual(["me"]);
    expect((await ctx.api("/api/pa/today")).body.accounts).toHaveLength(1);

    const storage = await ctx.api("/api/integrations/storage", { method: "PUT", json: { data: { backend: "gdrive", googleAccount: "me" } } });
    expect(storage.status).toBe(200);
    expect(storage.body.failed.storage).toMatch(/after the next restart/);
    expect(ctx.server.storage.kind).toBe("local");
    expect((await ctx.api("/api/integrations")).body.groups.storage).toMatch(/after the next restart/);

    // A restart applies the saved setting before anything is stored or served.
    const next = await makeServer({ env: { CREDENTIALS_KEY: KEY }, overrides: { socialAdapters: { discord: discord.adapter } } });
    try {
      expect(next.server.storage.kind).toBe("gdrive");
      expect((await next.api("/api/integrations")).body.groups.storage).toBeNull();
    } finally {
      await next.server.stop();
    }
  });
});
