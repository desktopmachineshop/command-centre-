import type { AgentRunRequest } from "@cc/agent-runtime";
import { demoModels, FakeOdoo } from "@cc/odoo/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
});

/**
 * Regression: a run token used to work against every /mcp/* server, so a
 * personal run could reuse its token on /mcp/odoo and read customers and orders.
 */
describe.skipIf(!DB_URL)("MCP run-token scope", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const odoo = new FakeOdoo({ models: demoModels() });
  /** Status of an MCP initialize on each server, using the run's own token. */
  const probes: Record<string, Record<string, number>> = {};
  let listPending = "";

  const runner = {
    name: "probe",
    async run(request: AgentRunRequest) {
      const { headers, url } = request.mcpServers!.actions as { url: string; headers: Record<string, string> };
      const vertical = request.cwd!.split("/").pop()!;
      probes[vertical] = {};
      for (const name of ["actions", "brain", "odoo"]) {
        const res = await ctx.server.app.request(url.replace("/mcp/actions", `/mcp/${name}`), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: initialize,
        });
        probes[vertical][name] = res.status;
      }
      const lister = new McpCallingRunner([{ server: "actions", tool: "list_pending", args: { vertical: "dms" } }]);
      lister.app = ctx.server.app;
      listPending = (await lister.run(request)).result;
      return { status: "succeeded" as const, result: "ok", error: null, costUsd: 0, sessionId: null };
    },
  };

  beforeAll(async () => {
    await odoo.start();
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      runner,
      env: { ODOO_URL: odoo.url, ODOO_DB: odoo.db, ODOO_USERNAME: odoo.login, ODOO_API_KEY: odoo.apiKey },
    });
    // One pending approval in each of two verticals (task-less, as from Dave's admin token).
    for (const vertical of ["dms", "personal"]) {
      await ctx.server.actions.propose({ vertical, actionType: "brain.journal", summary: `${vertical} note`, payload: { text: "x" } });
    }
  });
  afterAll(async () => {
    await ctx?.server.stop();
    await odoo.stop();
  });

  it("refuses /mcp/odoo to a personal run but not to a DMS run", async () => {
    await ctx.api("/api/chat", { method: "POST", json: { text: "remind me to book the dentist" } });
    await ctx.queue.drain();
    expect(probes.personal).toEqual({ actions: 200, brain: 200, odoo: 403 });

    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: where is order S00042?" } });
    await ctx.queue.drain();
    expect(probes.dms).toEqual({ actions: 200, brain: 200, odoo: 200 });
  });

  it("limits list_pending to the run's own vertical", async () => {
    await ctx.api("/api/chat", { method: "POST", json: { text: "what's waiting for me?" } });
    await ctx.queue.drain();
    expect(listPending).toContain("[personal] brain.journal: personal note");
    expect(listPending).not.toContain("[dms]");
  });

  it("still lets the admin token reach every server and every vertical's approvals", async () => {
    const res = await ctx.server.app.request("/mcp/odoo", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initialize,
    });
    expect(res.status).toBe(200);

    const agent = new McpCallingRunner([{ server: "actions", tool: "list_pending", args: {} }]);
    agent.app = ctx.server.app;
    const headers = { Authorization: `Bearer ${ADMIN}` };
    const { result } = await agent.run({ prompt: "", mcpServers: { actions: { type: "http", url: "http://cc.test/mcp/actions", headers } } });
    expect(result).toContain("[dms] brain.journal: dms note");
    expect(result).toContain("[personal] brain.journal: personal note");
  });
});
