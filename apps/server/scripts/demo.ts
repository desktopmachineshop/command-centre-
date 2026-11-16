/**
 * A local Command Centre with a pretend agent and a pretend Odoo, for looking at the app as Dave
 * sees it without a model or any real account:
 *
 *   createdb cc_demo
 *   pnpm --filter @cc/web build
 *   DEMO_DATABASE_URL=postgres://cc:cc@localhost:5432/cc_demo pnpm --filter @cc/server exec tsx scripts/demo.ts
 *
 * Then open http://127.0.0.1:8787 and sign in with the admin token it prints. The agent answers a
 * few kinds of message the way a real one would (tools, a card, a proposal); anything else it echoes.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@cc/core";
import { type AgentRunner, type AgentRunRequest, ClaudeCodeRunner, type OnAgentMessage } from "@cc/agent-runtime";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { demoModels, FakeOdoo } from "@cc/odoo/testing";
import { createServer } from "../src/app";
import { loadConfig } from "../src/config";

const ADMIN = "demo-admin-token-0123456789abcdef";
const PORT = Number(process.env.DEMO_PORT ?? 8787);
const DB = process.env.DEMO_DATABASE_URL;
if (!DB) throw new Error("Set DEMO_DATABASE_URL to an empty Postgres database");

/** Answers like an agent: calls the MCP tools it was handed and reports each step. */
class DemoAgent implements AgentRunner {
  readonly name = "demo";
  app?: { fetch: (req: Request) => Response | Promise<Response> };

  private async call(request: AgentRunRequest, onMessage: OnAgentMessage, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const cfg = request.mcpServers?.[server];
    onMessage({ type: "tool_use", name: `mcp__${server}__${tool}`, input: args });
    if (!cfg || !("url" in cfg)) {
      onMessage({ type: "tool_result", name: `mcp__${server}__${tool}`, output: `no MCP server ${server}`, isError: true });
      return "";
    }
    const client = new Client({ name: "demo-agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers }, fetch: (url, init) => this.app!.fetch(new Request(url, init)) as Promise<Response> }));
    try {
      const result = await client.callTool({ name: tool, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      onMessage({ type: "tool_result", name: `mcp__${server}__${tool}`, output: text, isError: !!result.isError });
      return text;
    } finally {
      await client.close();
    }
  }

  async run(request: AgentRunRequest, onMessage: OnAgentMessage = () => {}) {
    const say = (text: string): AgentMessage => {
      const m: AgentMessage = { type: "text", text };
      onMessage(m);
      return m;
    };
    const prompt = request.prompt;
    const done = (result: string) => ({ status: "succeeded" as const, result, error: null, costUsd: 0.04, sessionId: "demo" });
    // "slowly" in the message: take a while, as a real agent does.
    await new Promise((r) => setTimeout(r, /slowly/i.test(prompt) ? 5000 : 300));

    if (/fail/i.test(prompt)) return { status: "failed" as const, result: null, error: "Claude usage limit reached; resets at 03:00", costUsd: 0.01, sessionId: null };

    if (/spindle|stock|collet/i.test(prompt)) {
      await this.call(request, onMessage, "brain", "search", { query: "spindle stock" }).catch(() => "");
      const text = "We have 12 of the 300W spindle on hand, 10 forecast after open orders. The ER11 collet set is low: 3 on hand against a reorder level of 5.\n\n```card\nodoo.product:SP-300W\nodoo.product:ER11-7\n```\n\nWant me to raise a purchase order for the collets?";
      say(text);
      return done(text);
    }
    if (/order|jane/i.test(prompt)) {
      const text = "Jane Doe's latest order is S00042. It is confirmed and waiting to be shipped.\n\n```card\nodoo.order:S00042\nodoo.customer:jane@example.com\n```";
      say(text);
      return done(text);
    }
    if (/remind|notify|tell me/i.test(prompt)) {
      say("I'll set that up.");
      await this.call(request, onMessage, "actions", "propose_action", { actionType: "notify", summary: "Remind Dave to call the accountant", payload: { title: "Call the accountant", body: "About the VAT return, before 17:00.", category: "reminder" } });
      const text = "Done: you'll get a reminder to call the accountant about the VAT return.";
      say(text);
      return done(text);
    }
    if (/reply|email|customer|journal|log/i.test(prompt)) {
      say("Drafting that now.");
      await this.call(request, onMessage, "actions", "propose_action", { actionType: "brain.write", summary: "Save the reply draft to Jane about her late parcel", payload: { path: "dms/drafts/jane-parcel.md", body: "Hi Jane,\n\nSorry your parcel is late. It left us on Monday and Royal Mail show it arriving tomorrow.\n\nDave" } });
      const text = "I've drafted the reply to Jane about her late parcel. It is waiting for your approval.";
      say(text);
      return done(text);
    }
    const text = `echo: ${prompt.slice(0, 400)}`;
    say(text);
    return done(text);
  }
}

const odoo = new FakeOdoo({ models: demoModels() });
await odoo.start();

const dataDir = mkdtempSync(join(tmpdir(), "cc-demo-"));
const skillsDir = join(dataDir, "skills");
mkdirSync(join(skillsDir, "brain-notes"), { recursive: true });
writeFileSync(join(skillsDir, "brain-notes", "SKILL.md"), "---\nname: brain-notes\ndescription: demo\n---\n");

const config = loadConfig({
  DATABASE_URL: DB,
  ADMIN_TOKEN: ADMIN,
  WEBHOOK_SECRET: "demo-webhook-secret-0123456789ab",
  DATA_DIR: dataDir,
  SKILLS_DIR: skillsDir,
  AGENT_RUNNER: "echo",
  VOICE_LOCAL: "off",
  SCHEDULES_ENABLED: "false",
  PORT: String(PORT),
  INTERNAL_BASE_URL: `http://127.0.0.1:${PORT}`,
  PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  WEB_DIST_DIR: resolve(import.meta.dirname, "../../web/dist"),
  ODOO_URL: odoo.url,
  ODOO_DB: odoo.db,
  ODOO_USERNAME: odoo.login,
  ODOO_API_KEY: odoo.apiKey,
  ODOO_EVENTS: "off",
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("DEMO_ENV_")).map(([k, v]) => [k.slice(9), v ?? ""])),
});
const agent = new DemoAgent();
// DEMO_REAL=<model>: a real Claude Code agent (this machine's `claude` sign-in) instead of the pretend one.
const real = process.env.DEMO_REAL ? new ClaudeCodeRunner({ bin: "claude", env: process.env, timeoutMs: 600_000 }) : null;
const runner: AgentRunner = real ? { name: "claude-code", run: (request, onMessage) => real.run({ ...request, model: process.env.DEMO_REAL }, onMessage) } : agent;
const server = createServer(config, { runner });
agent.app = server.app;
await server.start();
const http = serve({ fetch: server.app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`demo command centre on http://127.0.0.1:${PORT}  (admin token: ${ADMIN})`);
});
server.injectWebSocket(http);
process.on("SIGINT", () => void server.stop().then(() => odoo.stop()).then(() => process.exit(0)));
process.on("SIGTERM", () => void server.stop().then(() => odoo.stop()).then(() => process.exit(0)));
