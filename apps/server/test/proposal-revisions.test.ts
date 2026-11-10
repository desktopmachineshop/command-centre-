import { eventModels, FakeOdoo } from "@cc/odoo/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

/**
 * When Dave asks for a change and the agent proposes again, the revised proposal replaces the old
 * one instead of both waiting in Approvals: explicitly (`replaces`), or automatically when it is
 * clear which one it revises.
 */
describe.skipIf(!DB_URL)("revised proposals replace the old ones", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const odoo = new FakeOdoo({ models: eventModels() });
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];

  const post = (id: number, body: string, replaces?: string[]) => ({
    server: "actions",
    tool: "propose_action",
    args: { actionType: "odoo.message.post", summary: `Message on S000${id}`, payload: { model: "sale.order", id, body: `<p>${body}</p>` }, ...(replaces ? { replaces } : {}) },
  });
  const proposalsOf = async (taskId: string) => ((await ctx.api(`/api/tasks/${taskId}`)).body.proposals as any[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const chat = async (text: string) => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text } });
    await ctx.queue.drain();
    return body.task.id as string;
  };
  const reply = async (taskId: string, text: string) => {
    expect((await ctx.api(`/api/tasks/${taskId}/reply`, { method: "POST", json: { text } })).status).toBe(202);
    await ctx.queue.drain();
  };

  beforeAll(async () => {
    await odoo.start();
    for (const id of [41, 42, 43]) odoo.add("sale.order", { id, name: `S000${id}`, partner_id: [id, `Customer ${id}`], state: "sale", amount_total: 10, currency_id: [1, "GBP"] });
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { ODOO_URL: odoo.url, ODOO_DB: odoo.db, ODOO_USERNAME: odoo.login, ODOO_API_KEY: odoo.apiKey } });
    runner.app = ctx.server.app;
  });
  afterAll(async () => {
    await ctx?.server.stop();
    await odoo.stop();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  it("cancels the one proposal a reply's run proposes again", async () => {
    calls.push(post(41, "Your order ships Friday."));
    const taskId = await chat("dms: tell S00041 when it ships");
    const [first] = await proposalsOf(taskId);
    expect(first).toMatchObject({ status: "pending" });

    calls.length = 0;
    calls.push(post(41, "Good news: your order ships on Friday!"));
    await reply(taskId, "Make it friendlier");
    // The run was told what is still waiting, and how to replace it.
    const request = runner.requests.at(-1)!;
    expect(request.systemPrompt).toContain(`- ${first.id}: odoo.message.post, "Message on S00041"`);
    expect(request.systemPrompt).toContain("`replaces`");

    const [old, revised] = await proposalsOf(taskId);
    expect(old).toMatchObject({ id: first.id, status: "rejected", result: { replacedBy: revised.id } });
    expect(revised).toMatchObject({ status: "pending", payload: { body: "<p>Good news: your order ships on Friday!</p>" } });
    expect((await ctx.api("/api/proposals?status=pending")).body.map((p: any) => p.id)).not.toContain(first.id);
  });

  it("replaces only what the agent names when more than one is waiting", async () => {
    calls.push(post(42, "Ships Friday."), post(43, "Ships Monday."));
    const taskId = await chat("dms: tell S00042 and S00043 when they ship");
    const [p42, p43] = await proposalsOf(taskId);

    // Without `replaces` it isn't clear which one is revised: both stay.
    calls.length = 0;
    calls.push(post(43, "Ships Tuesday."));
    await reply(taskId, "S00043 ships Tuesday now");
    let all = await proposalsOf(taskId);
    expect(all.filter((p) => p.status === "pending")).toHaveLength(3);

    calls.length = 0;
    const tuesday = all[2];
    calls.push(post(43, "Now shipping on Tuesday.", [p43.id, tuesday.id]));
    await reply(taskId, "Reword the S00043 one, and drop the duplicate");
    all = await proposalsOf(taskId);
    const revised = all[3];
    expect(all.find((p) => p.id === p42.id)).toMatchObject({ status: "pending" });
    expect(all.find((p) => p.id === p43.id)).toMatchObject({ status: "rejected", result: { replacedBy: revised.id } });
    expect(all.find((p) => p.id === tuesday.id)).toMatchObject({ status: "rejected", result: { replacedBy: revised.id } });
  });

  it("never replaces another task's proposal", async () => {
    calls.push(post(41, "Ships Friday."));
    const other = await chat("dms: tell S00041 it ships");
    const [theirs] = await proposalsOf(other);

    calls.length = 0;
    calls.push(post(42, "Ships Friday.", [theirs.id]));
    const taskId = await chat("dms: tell S00042 it ships");
    expect((await proposalsOf(other))[0]).toMatchObject({ id: theirs.id, status: "pending" });
    expect(await proposalsOf(taskId)).toHaveLength(1);
  });
});
