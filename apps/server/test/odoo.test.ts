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
      for (const type of ["odoo.message.post", "odoo.blog.draft", "odoo.product.update_price", "odoo.quote.create", "odoo.quote.send", "odoo.loyalty.create", "odoo.loyalty.archive", "odoo.customer.create"]) expect(policyFor(v, type)).toBe("draft");
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

  it("gives the assistant odoo tools on Dave's chats, whatever the business", async () => {
    calls.push({ server: "odoo", tool: "get_order", args: { name: "S00042" } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: where is order S00042?" } });
    await ctx.queue.drain();
    const request = runner.requests[0]!;
    expect(Object.keys(request.mcpServers!)).toEqual(["actions", "help", "brain", "pa", "odoo", "ops"]);
    expect(request.allowedTools).toContain("mcp__odoo");
    expect(request.systemPrompt).toContain("odoo.message.post");
    const run = (await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0];
    expect(run.result).toContain("RM123456785GB");

    calls.length = 0;
    await ctx.api("/api/chat", { method: "POST", json: { text: "remind me to book the dentist" } });
    await ctx.queue.drain();
    expect(Object.keys(runner.requests[1]!.mcpServers!)).toEqual(["actions", "help", "brain", "pa", "odoo", "ops"]);
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

  it("shows similar Odoo customers on a new-customer approval, and creates it on approve", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: {
        actionType: "odoo.customer.create",
        summary: "New customer: Jane Doe (asked for a quote)",
        payload: { name: "Jane Doe", email: "jane.doe@example.com", phone: "+44 7700 900123", similarCustomers: [] },
      },
    });
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: add Jane Doe as a customer" } });
    await ctx.queue.drain();

    const [pending] = (await ctx.api("/api/proposals?status=pending")).body;
    expect(pending).toMatchObject({ actionType: "odoo.customer.create", policy: "draft" });
    expect(pending.summary).toBe("New customer: Jane Doe (asked for a quote) [1 possible match in Odoo: Jane Doe <jane@example.com> #10: email at example.com, similar name, same phone.]");
    expect(pending.payload.similarCustomers).toEqual([expect.objectContaining({ id: 10, matched: "email at example.com, similar name, same phone" })]);

    // Dave's edit re-runs the check on the edited payload.
    const edited = await ctx.api(`/api/proposals/${pending.id}`, { method: "PATCH", json: { payload: { ...pending.payload, name: "Jo Bloggs", email: "jo@bloggs.example", phone: "01632 960000" } } });
    expect(edited.status).toBe(200);
    expect(edited.body.payload.similarCustomers).toBe("None found in Odoo");
    expect(edited.body.summary).toBe("New customer: Jane Doe (asked for a quote) [No similar customers in Odoo.]");

    const before = odoo.models["res.partner"]!.records.length;
    const approved = await ctx.api(`/api/proposals/${pending.id}/approve`, { method: "POST" });
    expect(approved.body).toMatchObject({ status: "executed", result: { ok: true, result: { name: "Jo Bloggs", email: "jo@bloggs.example" } } });
    expect(odoo.models["res.partner"]!.records).toHaveLength(before + 1);
  });

  it("shows the customer, quote lines and total on a quote approval, and updates them when Dave edits it", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "odoo.quote.create", summary: "Quote Jane two spindles", payload: { partner_id: 10, lines: [{ product_id: 2, qty: 2 }] } },
    });
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: quote Jane two spindles" } });
    await ctx.queue.drain();

    const [pending] = (await ctx.api("/api/proposals?status=pending")).body;
    expect(pending.summary).toBe("Quote Jane two spindles [Jane Doe: 1 line, 178.00 total (est.), margin 66.33 (44.7%), in stock.]");
    expect(pending.payload.quotePreview).toMatchObject({
      customer: { name: "Jane Doe" },
      lines: [{ part_number: "SP-300W", name: "300W spindle", qty: 2, unit_price: 89, subtotal: 148.33 }],
      total: 178,
    });

    const edited = await ctx.api(`/api/proposals/${pending.id}`, { method: "PATCH", json: { payload: { partner_id: 10, lines: [{ product_id: 2, qty: 3 }] } } });
    expect(edited.status).toBe(200);
    expect(edited.body.summary).toBe("Quote Jane two spindles [Jane Doe: 1 line, 267.00 total (est.), margin 99.50 (44.7%), in stock.]");
    expect(edited.body.payload.quotePreview.lines[0]).toMatchObject({ qty: 3, subtotal: 222.5 });
    await ctx.api(`/api/proposals/${pending.id}/reject`, { method: "POST" });
  });

  it("serves /mcp/odoo only with a valid token", async () => {
    const res = await ctx.server.app.request("/mcp/odoo", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});
