import type { McpServerConfig } from "@cc/agent-runtime";
import type { Event, VerticalManifest } from "@cc/core";
import { emailPrompt } from "@cc/email";
import type { ActionExecutor } from "./actions";

/** The prompt an agent gets for a task, derived from the event that caused it. */
export function taskPrompt(event: Event): string {
  const p = event.payload;
  if (event.source === "chat" && typeof p.text === "string") return p.text;
  if (event.source === "cron" && typeof p.prompt === "string") return p.prompt;
  // Email: a readable message plus how to reply (see @cc/email emailPrompt).
  if (event.source === "email" && event.kind === "message") return emailPrompt(p);
  return [
    `New ${event.source} event "${event.kind}": ${event.title}`,
    "",
    "Event payload:",
    "```json",
    JSON.stringify(p, null, 2).slice(0, 20_000),
    "```",
    "",
    "Decide what needs doing and do it.",
  ].join("\n");
}

export function systemPrompt(vertical: VerticalManifest, executors: Record<string, ActionExecutor>, now = new Date()): string {
  const actions = Object.entries(executors)
    .map(([type, e]) => `- ${type}: ${e.description}`)
    .join("\n");
  return `You are the Command Centre agent working for Dave on: ${vertical.name}.
${vertical.description}

Today is ${now.toISOString().slice(0, 10)}.

Long-term memory lives in the brain (MCP server "brain"). Before answering, search it for relevant context; this vertical's notes are under "${vertical.brainFolder}/". Record durable facts, decisions and outcomes there (use the journal for one-line events).

You never act on the outside world directly. To send, publish, change or notify anything, call the "actions" MCP tool propose_action. Depending on policy it runs straight away or waits for Dave's approval. Available action types:
${actions}

Finish with a short summary of what you found and what you proposed.`;
}

/**
 * `actions` always, plus each server the manifest lists that is actually
 * mounted at `/mcp/<name>` (e.g. `odoo` only when Odoo is configured).
 */
export function mcpServersFor(
  vertical: VerticalManifest,
  baseUrl: string,
  token: string,
  mounted: readonly string[] = ["brain"],
): Record<string, McpServerConfig> {
  const headers = { Authorization: `Bearer ${token}` };
  const servers: Record<string, McpServerConfig> = {
    actions: { type: "http", url: `${baseUrl}/mcp/actions`, headers },
  };
  for (const name of vertical.mcpServers) {
    if (mounted.includes(name)) servers[name] = { type: "http", url: `${baseUrl}/mcp/${name}`, headers };
  }
  return servers;
}

export function allowedToolsFor(mcpServers: Record<string, McpServerConfig>): string[] {
  return ["Skill", ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}
