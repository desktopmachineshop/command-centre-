import { policyFor } from "@cc/core";
import { demoModels, FakeOdoo } from "@cc/odoo/testing";
import { verticals } from "@cc/verticals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

describe("odoo config", () => {
  const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "admin-token-for-tests-0123456789" };

  it("is off unless all four variables are set", () => {
    expect(loadConfig(base).odoo).toBeUndefined();
    expect(loadConfig({ ...base, ODOO_URL: "", ODOO_API_KEY: "" }).odoo).toBeUndefined();
    expect(() => loadConfig({ ...base, ODOO_URL: "https://x.odoo.com" })).toThrow(/ODOO_DB/);
    const full = { ...base, ODOO_URL: "https://x.odoo.com", ODOO_DB: "x", ODOO_USERNAME: "bot@x.com", ODOO_API_KEY: "k" };
    expect(loadConfig(full).odoo).toEqual({ url: "https://x.odoo.com", db: "x", username: "bot@x.com", apiKey: "k", api: "jsonrpc" });
    expect(loadConfig({ ...full, ODOO_API: "json2" }).odoo?.api).toBe("json2");
  });

  it("never auto-runs Odoo writes", () => {
    for (const v of verticals) {
      for (const type of ["odoo.message.post", "odoo.blog.draft", "odoo.product.update_price"]) expect(policyFor(v, type)).toBe("draft");
    }
  });
});

describe.skipIf(!DB_URL)("odoo (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const odoo = new FakeOdoo({ models: demoModels() });
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];

  beforeAll(async () => {
    await odoo.start();
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      runner,
      env: { ODOO_URL: odoo.url, ODOO_DB: odoo.db, ODOO_USERNAME: odoo.login, ODOO_API_KEY: odoo.apiKey },
    });
    runner.app = ctx.server.app;
  });
  afterAll(async () => {
    await ctx?.server.stop();
    await odoo.stop();
  });
  beforeEach(() => {
    calls.length = 0;
    runner.requests.length = 0;
  });

  it("gives odoo tools to DMS runs only", async () => {
    calls.push({ server: "odoo", tool: "get_order", args: { name: "S00042" } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: where is order S00042?" } });
    await ctx.queue.drain();
    const request = runner.requests[0]!;
    expect(Object.keys(request.mcpServers!)).toEqual(["actions", "help", "brain", "odoo", "pa"]);
    expect(request.allowedTools).toContain("mcp__odoo");
    expect(request.systemPrompt).toContain("odoo.message.post");
    const run = (await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0];
    expect(run.result).toContain("RM123456785GB");

    calls.length = 0;
    await ctx.api("/api/chat", { method: "POST", json: { text: "remind me to book the dentist" } });
    await ctx.queue.drain();
    expect(Object.keys(runner.requests[1]!.mcpServers!)).toEqual(["actions", "help", "brain", "pa"]);
  });

  it("holds odoo.message.post for approval, then posts on approve", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: {
        actionType: "odoo.message.post",
        summary: "Reply to Jane on S00042: spindle ships Friday",
        payload: { model: "sale.order", id: 42, body: "<p>Hi Jane, your spindle ships on Friday.</p>" },
      },
    });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: answer Jane on S00042" } });
    await ctx.queue.drain();

    const pending = (await ctx.api("/api/proposals?status=pending")).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionType: "odoo.message.post", policy: "draft", vertical: "dms", taskId: body.task.id });
    expect(odoo.callsTo("message_post")).toHaveLength(0);

    const approved = await ctx.api(`/api/proposals/${pending[0].id}/approve`, { method: "POST" });
    expect(approved.body).toMatchObject({ status: "executed", result: { ok: true, result: { model: "sale.order", id: 42, internal: false } } });
    expect(odoo.callsTo("message_post")).toHaveLength(1);
  });

  it("serves /mcp/odoo only with a valid token", async () => {
    const res = await ctx.server.app.request("/mcp/odoo", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});
