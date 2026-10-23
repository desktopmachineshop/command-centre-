import { createBrainMcpServer, type Brain } from "@cc/brain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { ActionService } from "../actions";
import type { RunScope, RunTokens } from "../run-tokens";

/** Who is calling an MCP endpoint: an agent run (scoped) or Dave's admin token. */
type Caller = { kind: "run"; scope: RunScope } | { kind: "admin" };

function authenticate(header: string | undefined, adminToken: string, runTokens: RunTokens): Caller | null {
  const token = header?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  if (token === adminToken) return { kind: "admin" };
  const scope = runTokens.lookup(token);
  return scope ? { kind: "run", scope } : null;
}

/** Stateless streamable-HTTP: a fresh MCP server per request. */
async function handle(server: McpServer, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function actionsServer(actions: ActionService, caller: Caller): McpServer {
  const server = new McpServer({ name: "actions", version: "0.1.0" });
  const types = Object.entries(actions.executors).map(([t, e]) => `${t}: ${e.description}`);
  server.registerTool(
    "propose_action",
    {
      description: `Propose an outward-facing action. It runs immediately or waits for Dave's approval, depending on policy.\nAction types:\n${types.join("\n")}`,
      inputSchema: {
        actionType: z.string(),
        summary: z.string().describe("One line Dave can approve or reject from a phone notification"),
        payload: z.record(z.string(), z.unknown()).default({}),
        vertical: z.string().optional().describe("Only needed outside an agent run"),
      },
    },
    async ({ actionType, summary, payload, vertical }) => {
      const scope = caller.kind === "run" ? caller.scope : null;
      try {
        const proposal = await actions.propose({
          taskId: scope?.taskId ?? null,
          vertical: scope?.vertical ?? vertical ?? "personal",
          actionType,
          summary,
          payload,
        });
        const state = proposal.status === "pending" ? "waiting for Dave's approval" : proposal.status;
        return { content: [{ type: "text", text: `Proposal ${proposal.id}: ${state}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  );
  server.registerTool(
    "list_pending",
    {
      description: "List proposals waiting for Dave's approval (read-only). All verticals unless one is given.",
      inputSchema: { vertical: z.string().optional() },
    },
    async ({ vertical }) => {
      const pending = await actions.pending(vertical);
      const lines = pending.map((p) => `- [${p.vertical}] ${p.actionType}: ${p.summary} (since ${p.createdAt.slice(0, 16)}Z, id ${p.id})`);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending approvals." }] };
    },
  );
  return server;
}

export function mcpRoutes(deps: { brain: Brain; actions: ActionService; runTokens: RunTokens; adminToken: string }) {
  const app = new Hono<{ Variables: { caller: Caller } }>();

  app.use("*", async (c, next) => {
    const caller = authenticate(c.req.header("authorization"), deps.adminToken, deps.runTokens);
    if (!caller) return c.json({ error: "unauthorized" }, 401);
    c.set("caller", caller);
    await next();
  });

  app.all("/brain", (c) => handle(createBrainMcpServer(deps.brain), c.req.raw));
  app.all("/actions", (c) => handle(actionsServer(deps.actions, c.get("caller")), c.req.raw));
  return app;
}
