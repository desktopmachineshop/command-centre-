import { createBrainMcpServer, type Brain } from "@cc/brain";
import { ROOT_ROLE_ID, type Task } from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { ActionService } from "../actions";
import { bearer, tokenMatches } from "../auth";
import type { RunScope, RunTokens } from "../run-tokens";

/** Who is calling an MCP endpoint: an agent run (scoped) or Dave's admin token. */
export type Caller = { kind: "run"; scope: RunScope } | { kind: "admin" };

function authenticate(header: string | undefined, adminToken: string, runTokens: RunTokens): Caller | null {
  const token = bearer(header);
  if (!token) return null;
  if (tokenMatches(token, adminToken)) return { kind: "admin" };
  const scope = runTokens.lookup(token);
  return scope ? { kind: "run", scope } : null;
}

/** Stateless streamable-HTTP: a fresh MCP server per request. */
async function handle(server: McpServer, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** Creates a task for another org role from a run's task (Pipeline.handoff). */
export type Handoff = (fromTaskId: string, target: string, note: string) => Promise<{ task: Task; duplicate: boolean }>;

function actionsServer(actions: ActionService, caller: Caller, handoff?: Handoff): McpServer {
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
        batchId: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Give every proposal of one bulk job (e.g. a message to each open order) the same label: Dave then approves or rejects them all at once, after seeing the full list."),
      },
    },
    async ({ actionType, summary, payload, vertical, batchId }) => {
      const scope = caller.kind === "run" ? caller.scope : null;
      try {
        const proposal = await actions.propose({
          taskId: scope?.taskId ?? null,
          vertical: scope?.vertical ?? vertical ?? "personal",
          actionType,
          summary,
          payload,
          batchId,
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
      description:
        caller.kind === "run" && caller.scope.role !== ROOT_ROLE_ID
          ? "List proposals waiting for Dave's approval in this run's vertical (read-only)."
          : "List proposals waiting for Dave's approval (read-only). All verticals unless one is given.",
      inputSchema: { vertical: z.string().optional() },
    },
    async ({ vertical }) => {
      // A run only sees its own vertical's approvals; the admin token and the Chief of Staff see all.
      const crossVertical = caller.kind === "admin" || caller.scope.role === ROOT_ROLE_ID;
      const pending = await actions.pending(crossVertical ? vertical : caller.scope.vertical);
      const lines = pending.map((p) => `- [${p.vertical}] ${p.actionType}: ${p.summary} (since ${p.createdAt.slice(0, 16)}Z, id ${p.id})`);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending approvals." }] };
    },
  );
  // --- org roles: handoff (docs/ORG.md) ---
  if (handoff && caller.kind === "run") {
    const { taskId } = caller.scope;
    server.registerTool(
      "handoff_to_role",
      {
        description: `Hand this work to another role in your org: creates a task for it with your note and the original request, then you should stop. roleId is a role id from your system prompt, or "${ROOT_ROLE_ID}" to escalate. The Chief of Staff may use "<vertical>/<role>". Chains are limited in depth and never go back to a role already in them.`,
        inputSchema: {
          roleId: z.string().min(1),
          note: z.string().min(1).describe("What you found, what is needed and anything the next role must not miss"),
        },
      },
      async ({ roleId, note }) => {
        try {
          const { task, duplicate } = await handoff(taskId, roleId, note);
          const text = duplicate ? `Already handed off: task ${task.id} (${task.status}).` : `Handed off to ${task.role} in ${task.vertical}: task ${task.id}.`;
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      },
    );
  }
  // --- end org roles ---
  return server;
}

export function mcpRoutes(deps: {
  brain: Brain;
  actions: ActionService;
  runTokens: RunTokens;
  /** Run tokens may only reach the servers their vertical's manifest lists in `mcpServers` (plus actions). */
  verticals: VerticalRegistry;
  adminToken: string;
  /** Extra servers mounted at /<name> with the same auth, e.g. odoo. A fresh server per request; looked up per request, so one added or removed on a reload applies at once. */
  servers?: Record<string, (caller: Caller) => McpServer> | (() => Record<string, (caller: Caller) => McpServer>);
  /** Enables the handoff_to_role tool for runs. */
  handoff?: Handoff;
}) {
  const app = new Hono<{ Variables: { caller: Caller } }>();

  app.use("*", async (c, next) => {
    const caller = authenticate(c.req.header("authorization"), deps.adminToken, deps.runTokens);
    if (!caller) return c.json({ error: "unauthorized" }, 401);
    if (caller.kind === "run") {
      const name = c.req.path.split("/").pop() ?? "";
      // The run's role narrows the vertical's servers (no role: the vertical's).
      const allowed = name === "actions" || deps.verticals.mcpServersFor(caller.scope.vertical, caller.scope.role).includes(name);
      if (!allowed) {
        const who = caller.scope.role ? `role ${caller.scope.role} in ${caller.scope.vertical}` : `vertical ${caller.scope.vertical}`;
        return c.json({ error: `${who} may not use ${name}` }, 403);
      }
    }
    c.set("caller", caller);
    await next();
  });

  app.all("/brain", (c) => handle(createBrainMcpServer(deps.brain), c.req.raw));
  app.all("/actions", (c) => handle(actionsServer(deps.actions, c.get("caller"), deps.handoff), c.req.raw));
  app.all("/:name", (c) => {
    const servers = (typeof deps.servers === "function" ? deps.servers() : deps.servers) ?? {};
    const name = c.req.param("name");
    if (!Object.hasOwn(servers, name)) return c.notFound();
    return handle(servers[name]!(c.get("caller")), c.req.raw);
  });
  return app;
}
