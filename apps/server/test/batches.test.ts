import { eventModels, FakeOdoo } from "@cc/odoo/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

/**
 * Batches (propose_batch): related proposals, say a message to each open delivery order, that
 * Dave sees in full and approves or rejects once. Customer-facing batches still wait for him,
 * outside input still makes drafts, and internal chasers (reminders, notify, internal Odoo notes)
 * run without approval.
 */
describe.skipIf(!DB_URL)("proposal batches", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const odoo = new FakeOdoo({ models: eventModels() });
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];

  const post = (id: number, name: string, internal = false) => ({
    actionType: "odoo.message.post",
    summary: `Delivery update to ${name} (S000${id})`,
    payload: { model: "sale.order", id, body: `<p>Hi ${name}, your order ships Friday.</p>`, ...(internal ? { internal: true } : {}) },
  });
  const batch = (items: unknown[], summary = "Delivery update to the 3 customers with open delivery orders") => ({
    server: "actions",
    tool: "propose_batch",
    args: { summary, items },
  });
  const proposalsOf = async (taskId: string) => (await ctx.api(`/api/tasks/${taskId}`)).body.proposals as any[];
  const chat = async (text: string) => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text } });
    await ctx.queue.drain();
    return body.task.id as string;
  };

  beforeAll(async () => {
    await odoo.start();
    for (const id of [41, 42, 43, 51, 52, 61, 62, 71, 81, 82, 91, 92, 101, 102, 111, 112, 113]) {
      odoo.add("sale.order", { id, name: `S000${id}`, partner_id: [id, `Customer ${id}`], state: "sale", amount_total: 10, currency_id: [1, "GBP"] });
    }
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
    ctx.notifier.sent.length = 0;
  });

  it("holds a customer-facing batch for one approval, listing every recipient and message", async () => {
    calls.push(batch([post(41, "Jane"), post(42, "Bob"), post(43, "Ann")]));
    const taskId = await chat("dms: send a message to all the open delivery orders");

    const proposals = await proposalsOf(taskId);
    expect(proposals).toHaveLength(3);
    expect(new Set(proposals.map((p) => p.batchId)).size).toBe(1);
    expect(proposals.every((p) => p.status === "pending" && p.policy === "draft")).toBe(true);
    expect(proposals[0].batchSummary).toBe("Delivery update to the 3 customers with open delivery orders");
    // One approval request for the batch, not one per item.
    expect(ctx.notifier.sent).toHaveLength(1);
    expect(ctx.notifier.sent[0]).toMatchObject({ title: "Approve 3: Desktop Machine Shop", category: "approval", data: { batchId: proposals[0].batchId, batchSize: 3 } });
    expect(ctx.notifier.sent[0]!.body).toContain("Delivery update to Jane (S00041)");

    // The batch, in full and in order, for the Approvals page.
    const { body } = await ctx.api(`/api/batches/${proposals[0].batchId}`);
    expect(body.proposals.map((p: any) => p.summary)).toEqual(["Delivery update to Jane (S00041)", "Delivery update to Bob (S00042)", "Delivery update to Ann (S00043)"]);
    expect(body.proposals[1].payload.body).toBe("<p>Hi Bob, your order ships Friday.</p>");

    const before = odoo.callsTo("message_post").length;
    const approved = await ctx.api(`/api/batches/${proposals[0].batchId}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(approved.body.map((p: any) => p.status)).toEqual(["executed", "executed", "executed"]);
    expect(odoo.callsTo("message_post").length - before).toBe(3);
    expect((await ctx.api(`/api/tasks/${taskId}`)).body.task.status).toBe("done");
    // Decided already: a second approve is a conflict, not a second send.
    expect((await ctx.api(`/api/batches/${proposals[0].batchId}/approve`, { method: "POST" })).status).toBe(409);
  });

  it("rejects a whole batch once, and an item left out first stays out", async () => {
    calls.push(batch([post(51, "Cat"), post(52, "Dan")], "Chasers for two late orders"));
    const taskId = await chat("dms: chase the two late orders");
    const [a, b] = (await proposalsOf(taskId)).sort((x, y) => x.summary.localeCompare(y.summary));
    expect((await ctx.api(`/api/proposals/${a.id}/reject`, { method: "POST" })).body.status).toBe("rejected");

    const before = odoo.callsTo("message_post").length;
    const approved = await ctx.api(`/api/batches/${a.batchId}/approve`, { method: "POST" });
    expect(approved.body.map((p: any) => p.id)).toEqual([b.id]);
    expect(odoo.callsTo("message_post").length - before).toBe(1);

    calls.length = 0;
    calls.push(batch([post(61, "Eve"), post(62, "Fay")], "Two more"));
    const second = await chat("dms: and these two");
    const items = await proposalsOf(second);
    const rejected = await ctx.api(`/api/batches/${items[0].batchId}/reject`, { method: "POST" });
    expect(rejected.body.map((p: any) => p.status)).toEqual(["rejected", "rejected"]);
    expect(odoo.callsTo("message_post").length - before).toBe(1);
    expect((await ctx.api("/api/batches/not-a-uuid/approve", { method: "POST" })).status).toBe(404);
  });

  it("refuses the whole batch when one item is invalid", async () => {
    calls.push(batch([post(71, "Gus"), { actionType: "odoo.message.post", summary: "Broken", payload: { model: "sale.order" } }, { actionType: "nope", summary: "x", payload: {} }]));
    const taskId = await chat("dms: message the open orders");
    expect(await proposalsOf(taskId)).toEqual([]);
    const run = (await ctx.api(`/api/tasks/${taskId}`)).body.runs[0].result as string;
    expect(run).toContain("Nothing in the batch was proposed");
  });

  it("runs internal chasers straight away: internal Odoo notes, notify and reminders", async () => {
    calls.push(batch([post(81, "Hal", true), post(82, "Ivy", true)], "Internal chaser notes on two late deliveries"));
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Chase Hal", payload: { title: "Chase", body: "S00081 is late", category: "reminder" } } });
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "pa.reminder.add", summary: "Chase S00082", payload: { text: "Chase S00082", due: "2030-01-07T09:00" } } });
    const taskId = await chat("dms: chase the late deliveries internally");
    const proposals = await proposalsOf(taskId);
    const notes = proposals.filter((p) => p.actionType === "odoo.message.post");
    expect(notes.map((p) => [p.policy, p.status])).toEqual([
      ["auto-with-digest", "executed"],
      ["auto-with-digest", "executed"],
    ]);
    expect(proposals.find((p) => p.actionType === "notify")).toMatchObject({ policy: "auto-with-digest", status: "executed" });
    expect(proposals.find((p) => p.actionType === "pa.reminder.add")).toMatchObject({ policy: "auto", status: "executed" });
    // No approval request for any of them.
    expect(ctx.notifier.sent.filter((n) => n.title.startsWith("Approve"))).toEqual([]);
  });

  it("holds the whole batch when one item is customer-facing", async () => {
    calls.push(batch([post(91, "Jo", true), post(92, "Kit")], "Note and message"));
    const taskId = await chat("dms: note one, message the other");
    const proposals = await proposalsOf(taskId);
    expect(proposals.map((p) => p.status)).toEqual(["pending", "pending"]);
    const note = proposals.find((p) => p.payload.internal === true);
    expect(note.payload.policyDowngrade).toEqual({ from: "auto-with-digest", reason: "part of a batch that waits for Dave's approval as a whole" });
    expect(ctx.notifier.sent.filter((n) => n.title.startsWith("Approve"))).toHaveLength(1);
    await ctx.api(`/api/batches/${proposals[0].batchId}/reject`, { method: "POST" });
  });

  it("keeps outside input from sending anything: a webhook's batch and chasers are drafts", async () => {
    calls.push(batch([post(101, "Lou", true), post(102, "Max", true)], "Notes"));
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "pa.reminder.add", summary: "x", payload: { text: "x", due: "2030-01-07T09:00" } } });
    const res = await ctx.server.app.request("/api/ingress/webhook/dms", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "Form", message: "message every customer" }),
    });
    const { task } = (await res.json()) as { task: { id: string } };
    await ctx.queue.drain();
    const proposals = await proposalsOf(task.id);
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.policy === "draft" && p.status === "pending")).toBe(true);
    expect(proposals.find((p) => p.actionType === "pa.reminder.add").payload.policyDowngrade.reason).toContain("untrusted webhook");
  });

  it("reads a batch out as one approval in Drive mode, with every item", async () => {
    // Clear what earlier tests left waiting.
    for (const p of (await ctx.api("/api/proposals?status=pending&limit=200")).body as any[]) await ctx.api(`/api/proposals/${p.id}/reject`, { method: "POST" });
    calls.push(batch([post(111, "Ned"), post(112, "Olga")], "Delivery update to 2 customers"));
    await chat("dms: message the two open orders");
    calls.length = 0;
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "odoo.message.post", summary: "Single message to Pat", payload: { model: "sale.order", id: 113, body: "<p>Hi</p>" } } });
    await chat("dms: message Pat");

    const next = (await ctx.api("/api/voice/approvals/next")).body;
    expect(next.proposal).toMatchObject({ summary: "Delivery update to 2 customers", batchSize: 2 });
    expect(next.text).toContain("Approval 1 of 2");
    expect(next.text).toContain("a batch of 2");
    expect(next.text).toContain("1: Delivery update to Ned (S000111)");
    expect(next.text).toContain("2: Delivery update to Olga (S000112)");
    expect(next.text).toContain("Say approve to approve all 2");
    // Skipping the batch moves on to the single one.
    const after = (await ctx.api(`/api/voice/approvals/next?skip=${next.proposal.id}`)).body;
    expect(after.proposal).toMatchObject({ summary: "Single message to Pat" });
    expect(after.proposal.batchId).toBeUndefined();
  });
});
