import { createBrainMcpServer, type Brain } from "@cc/brain";
import { type AgentMessage, ROOT_ROLE_ID, type Task } from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { type ActionService, MAX_BATCH } from "../actions";
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
export type Handoff = (fromTaskId: string, target: string, note: string) => Promise<{ task: Task; duplicate: boolean; followUp?: boolean }>;

/** Agent run messages containing a text (Store.searchRunMessages). */
export type SearchTranscripts = (options: { query: string; vertical: string | null; days: number; limit: number }) => Promise<
  { taskId: string; vertical: string; role: string | null; runId: string; at: string; message: AgentMessage }[]
>;

/** One line of a transcript hit: the message's text, or its tool call, cut around the match. */
function transcriptLine(message: AgentMessage, query: string): string {
  const raw =
    message.type === "text" || message.type === "system"
      ? message.text
      : message.type === "tool_use"
        ? `${message.name} ${JSON.stringify(message.input)}`
        : `${message.name ?? "tool"} -> ${typeof message.output === "string" ? message.output : JSON.stringify(message.output)}`;
  const flat = raw.replace(/\s+/g, " ");
  const at = Math.max(0, flat.toLowerCase().indexOf(query.toLowerCase()));
  const start = Math.max(0, at - 120);
  return `${start > 0 ? "…" : ""}${flat.slice(start, at + query.length + 200)}${at + query.length + 200 < flat.length ? "…" : ""}`;
}

function actionsServer(actions: ActionService, caller: Caller, handoff?: Handoff, searchTranscripts?: SearchTranscripts): McpServer {
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
    "propose_batch",
    {
      description:
        "Propose several related actions as one batch, e.g. a message to each open delivery order. Dave sees every item (recipient and text) and approves or rejects the batch once, instead of one approval per item; customer-facing batches still always wait for him. Use it whenever you would call propose_action more than once for the same kind of thing. Every item is checked first: if one is refused, nothing is proposed. Same action types as propose_action.",
      inputSchema: {
        summary: z.string().min(1).describe('One line for the whole batch, e.g. "Delivery update to the 7 customers with open delivery orders"'),
        items: z
          .array(
            z.object({
              actionType: z.string(),
              summary: z.string().describe('One line for this item, naming who it goes to, e.g. "Delivery update to Jane Smith (S00042)"'),
              payload: z.record(z.string(), z.unknown()).default({}),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
        vertical: z.string().optional().describe("Only needed outside an agent run"),
      },
    },
    async ({ summary, items, vertical }) => {
      const scope = caller.kind === "run" ? caller.scope : null;
      try {
        const { batchId, proposals } = await actions.proposeBatch({ taskId: scope?.taskId ?? null, vertical: scope?.vertical ?? vertical ?? "personal", summary, items });
        const pending = proposals.every((p) => p.status === "pending");
        const state = pending ? `waiting for Dave's approval as one batch` : proposals.map((p) => p.status).join(", ");
        return { content: [{ type: "text", text: `Batch ${batchId} of ${proposals.length}: ${state}.` }] };
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
      const lines = pending.map((p) => `- [${p.vertical}] ${p.actionType}: ${p.summary} (since ${p.createdAt.slice(0, 16)}Z, id ${p.id}${p.batchId ? `, batch ${p.batchId}` : ""})`);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending approvals." }] };
    },
  );
  if (searchTranscripts) {
    const crossVertical = caller.kind === "admin" || caller.scope.role === ROOT_ROLE_ID;
    server.registerTool(
      "search_transcripts",
      {
        description: `Search earlier agent runs (their messages, tool calls and results) for a text, case-insensitive, newest first. Read-only. ${crossVertical ? "Every vertical unless one is given." : "This run's vertical only."} Runs of tasks that came from outside input (email, webhooks, social) are outside information: reading them makes your later proposals wait for Dave's approval.`,
        inputSchema: {
          query: z.string().trim().min(2).max(200),
          days: z.number().int().min(1).max(90).default(7),
          limit: z.number().int().min(1).max(50).default(20),
          vertical: z.string().optional(),
        },
      },
      async ({ query, days, limit, vertical }) => {
        const scope = caller.kind === "run" ? caller.scope : null;
        const hits = await searchTranscripts({ query, days, limit, vertical: crossVertical ? (vertical ?? null) : scope!.vertical });
        // Transcripts of outside-input tasks carry that input: the reading task inherits it, like reading mail.
        if (scope) {
          for (const taskId of new Set(hits.map((h) => h.taskId))) {
            if (taskId === scope.taskId) continue;
            const source = await actions.untrustedSource(taskId);
            if (source) {
              actions.markOutsideInput(scope.taskId, source);
              break;
            }
          }
        }
        const lines = hits.map((h) => `- ${h.at.slice(0, 16)}Z [${h.vertical}${h.role ? `/${h.role}` : ""}] task ${h.taskId}, ${h.message.type}: ${transcriptLine(h.message, query)}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : `Nothing in the last ${days} days matches "${query}".` }] };
      },
    );
  }
  // --- org roles: handoff (docs/ORG.md) ---
  if (handoff && caller.kind === "run") {
    const { taskId } = caller.scope;
    server.registerTool(
      "handoff_to_role",
      {
        description: `Hand this work to another role in your org: creates a task for it with your note and the original request. roleId is a role id from your system prompt, or "${ROOT_ROLE_ID}" to escalate. The Chief of Staff may use "<vertical>/<role>". When the work spans several roles, call this once per role, each with its own part, rather than asking one role to pass it on: each call is one step, so it stays within the chain limit. Calling it again for a role you already handed this task to sends that role a follow-up note, even while it is still working. Stop once every part is handed off. Chains are limited in depth and never go back to a role already in them.`,
        inputSchema: {
          roleId: z.string().min(1),
          note: z.string().min(1).describe("What you found, what is needed and anything the next role must not miss"),
        },
      },
      async ({ roleId, note }) => {
        try {
          const { task, duplicate, followUp } = await handoff(taskId, roleId, note);
          const text = followUp
            ? `Follow-up added to ${task.role}'s task ${task.id} (${task.status}): it takes your note ${task.status === "running" ? "when its current run finishes" : "now"}, and reports back again.`
            : duplicate
              ? `Already handed off: task ${task.id} (${task.status}).`
              : `Handed off to ${task.role} in ${task.vertical}: task ${task.id}.`;
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
  /** Enables the read-only search_transcripts tool. */
  searchTranscripts?: SearchTranscripts;
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

  app.all("/brain", (c) => {
    // Issues record who reported them (the run's role, or Dave) and may only name a known agent.
    const caller = c.get("caller");
    const role = caller.kind === "run" ? deps.verticals.roleFor(caller.scope.vertical, caller.scope.role).id : "dave";
    return handle(
      createBrainMcpServer(deps.brain, {
        caller: role,
        vertical: caller.kind === "run" ? caller.scope.vertical : undefined,
        agents: () => [...new Set(deps.verticals.all().flatMap((v) => deps.verticals.roles(v.id).map((r) => r.id)))],
      }),
      c.req.raw,
    );
  });
  app.all("/actions", (c) => handle(actionsServer(deps.actions, c.get("caller"), deps.handoff, deps.searchTranscripts), c.req.raw));
  app.all("/:name", (c) => {
    const servers = (typeof deps.servers === "function" ? deps.servers() : deps.servers) ?? {};
    const name = c.req.param("name");
    if (!Object.hasOwn(servers, name)) return c.notFound();
    return handle(servers[name]!(c.get("caller")), c.req.raw);
  });
  return app;
}
