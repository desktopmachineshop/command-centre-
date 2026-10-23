import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRunner, type AgentRunRequest, ScriptedRunner } from "@cc/agent-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { VerticalRegistry } from "@cc/verticals";
import pg from "pg";
import { createServer, type Overrides } from "../src/app";
import { loadConfig } from "../src/config";
import type { Notifier } from "../src/push";
import { InlineTaskQueue } from "../src/queue";

export const DB_URL = process.env.TEST_DATABASE_URL;
export const ADMIN = "admin-token-for-tests-0123456789";
export const WEBHOOK = "webhook-secret-for-tests-012345";

/** Drops everything so each test file starts from an empty database. */
export async function resetDatabase(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema public cascade; create schema public; drop schema if exists pgboss cascade");
  await client.end();
}

export class RecordingNotifier implements Notifier {
  readonly publicKey = null;
  readonly sent: { title: string; body: string }[] = [];
  async notify(n: { title: string; body: string }) {
    this.sent.push(n);
  }
}

export async function makeServer(
  options: { runner?: AgentRunner; env?: Record<string, string>; overrides?: Overrides; verticals?: VerticalRegistry } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-server-"));
  const skillsDir = join(dataDir, "skills");
  mkdirSync(join(skillsDir, "brain-notes"), { recursive: true });
  writeFileSync(join(skillsDir, "brain-notes", "SKILL.md"), "---\nname: brain-notes\ndescription: test\n---\n");

  const config = loadConfig({
    DATABASE_URL: DB_URL!,
    ADMIN_TOKEN: ADMIN,
    WEBHOOK_SECRET: WEBHOOK,
    DATA_DIR: dataDir,
    SKILLS_DIR: skillsDir,
    AGENT_RUNNER: "echo",
    SCHEDULES_ENABLED: "false",
    INTERNAL_BASE_URL: "http://cc.test",
    ...options.env,
  });
  const queue = new InlineTaskQueue();
  const notifier = new RecordingNotifier();
  const server = createServer(config, {
    ...options.overrides,
    runner: options.runner,
    queue,
    notifier,
    verticals: options.verticals ?? options.overrides?.verticals,
  });
  await server.start();

  const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${ADMIN}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await server.app.request(path, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return { server, config, queue, notifier, api, dataDir };
}

/**
 * A runner that behaves like an agent: connects to the MCP servers it was
 * handed (through the in-process app, not the network) and calls tools.
 */
export class McpCallingRunner implements AgentRunner {
  readonly name = "mcp-test";
  app?: { fetch: (req: Request) => Response | Promise<Response> };
  readonly requests: AgentRunRequest[] = [];

  constructor(private readonly calls: { server: string; tool: string; args: Record<string, unknown> }[]) {}

  async run(request: AgentRunRequest) {
    this.requests.push(request);
    const outputs: string[] = [];
    for (const call of this.calls) {
      const cfg = request.mcpServers?.[call.server];
      if (!cfg || !("url" in cfg)) throw new Error(`no MCP server ${call.server}`);
      const client = new Client({ name: "test-agent", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers },
          fetch: (url, init) => this.app!.fetch(new Request(url, init)) as Promise<Response>,
        }),
      );
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      outputs.push(JSON.stringify(result.content));
      await client.close();
    }
    return { status: "succeeded" as const, result: outputs.join("\n"), error: null, costUsd: 0.02, sessionId: "s" };
  }
}

export { ScriptedRunner };
