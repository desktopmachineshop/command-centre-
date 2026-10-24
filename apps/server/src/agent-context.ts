import type { McpServerConfig } from "@cc/agent-runtime";
import { type Event, ROOT_ROLE_ID, type VerticalManifest } from "@cc/core";
import { emailPrompt } from "@cc/email";
import { odooPrompt } from "@cc/odoo";
import { socialPrompt } from "@cc/social";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";
import type { ActionExecutor } from "./actions";

/** The prompt an agent gets for a task, derived from the event that caused it. */
export function taskPrompt(event: Event): string {
  const p = event.payload;
  if (event.source === "chat" && typeof p.text === "string") return p.text;
  if (event.source === "cron" && typeof p.prompt === "string") return p.prompt;
  // Email: a readable message plus how to reply (see @cc/email emailPrompt).
  if (event.source === "email" && event.kind === "message") return emailPrompt(p);
  const handoff = handoffPrompt(event);
  if (handoff) return handoff;
  // Social: the message as quoted data plus a ready social.reply payload (see @cc/social socialPrompt).
  if (event.source === "social") return socialPrompt(p);
  // Odoo: a human title, the record as quoted (untrusted) data and ready action payloads (see @cc/odoo odooPrompt).
  if (event.source === "odoo") return odooPrompt(event);
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

export function systemPrompt(
  vertical: VerticalManifest,
  executors: Record<string, ActionExecutor>,
  now = new Date(),
  role?: RoleBrief,
): string {
  const actions = Object.entries(executors)
    .map(([type, e]) => `- ${type}: ${e.description}`)
    .join("\n");
  const who = role ? `the ${role.role.title} in Dave's Command Centre, working on: ${vertical.name}` : `the Command Centre agent working for Dave on: ${vertical.name}`;
  return `You are ${who}.
${vertical.description}

Today is ${now.toISOString().slice(0, 10)}.
${role ? `\n${roleCharter(role)}\n` : ""}
Long-term memory lives in the brain (MCP server "brain"). Before answering, search it for relevant context; this vertical's notes are under "${vertical.brainFolder}/". Record durable facts, decisions and outcomes there (use the journal for one-line events).

You never act on the outside world directly. To send, publish, change or notify anything, call the "actions" MCP tool propose_action. Depending on policy it runs straight away or waits for Dave's approval. Available action types:
${actions}

Finish with a short summary of what you found and what you proposed.`;
}

// --- org roles (docs/ORG.md) ---

/** What a run needs to know about its place in the org chart. */
export interface RoleBrief {
  role: OrgRole;
  /** Who it reports to; null for the Chief of Staff. */
  manager: OrgRole | null;
  /** The other roles it can hand work to: same-vertical roles plus the Chief of Staff, or (for the Chief of Staff) every vertical's roles. */
  team: { id: string; title: string; summary: string; owns: string[] }[];
  /** Handoffs left in this chain before the limit. */
  handoffsLeft: number;
}

const firstSentence = (s: string) => (/^.*?[.!?](\s|$)/.exec(s)?.[0] ?? s).trim();

/** The role charter for a run: from the registry, with the team it can hand off to. */
export function roleBrief(registry: VerticalRegistry, verticalId: string, roleId: string | null | undefined, handoffsLeft: number): RoleBrief {
  const role = registry.roleFor(verticalId, roleId);
  const entry = (r: OrgRole, id = r.id) => ({ id, title: r.title, summary: firstSentence(r.mission), owns: r.intents });
  if (role.id === ROOT_ROLE_ID) {
    const team = registry.all().flatMap((v) => registry.roles(v.id).filter((r) => r.id !== ROOT_ROLE_ID).map((r) => ({ ...entry(r, `${v.id}/${r.id}`), title: `${r.title} (${v.name})` })));
    return { role, manager: null, team, handoffsLeft };
  }
  const roles = registry.roles(verticalId).filter((r) => r.id !== ROOT_ROLE_ID);
  const manager = role.reportsTo === ROOT_ROLE_ID ? registry.root : (roles.find((r) => r.id === role.reportsTo) ?? null);
  const team = [...roles.filter((r) => r.id !== role.id).map((r) => entry(r)), entry(registry.root)];
  return { role, manager, team, handoffsLeft };
}

function roleCharter(b: RoleBrief): string {
  const { role, manager } = b;
  const lines = [`## Your role: ${role.title} (${role.id})`, role.mission];
  lines.push(manager ? `You report to the ${manager.title} (${manager.id}).` : "You are the top of the org: every vertical lead reports to you, and you report to Dave.");
  if (role.intents.length) lines.push(`You own these kinds of work: ${role.intents.join(", ")}.`);
  if (role.actions.length) lines.push(`Actions you normally propose: ${role.actions.join(", ")}.`);
  if (role.autonomyNotes) lines.push(`Autonomy: ${role.autonomyNotes}`);
  lines.push("", "Roles you can hand work to:");
  for (const t of b.team) lines.push(`- ${t.id}: ${t.title}. ${t.summary}${t.owns.length ? ` Owns: ${t.owns.join(", ")}.` : ""}`);
  lines.push(
    "",
    b.handoffsLeft > 0
      ? `If the work belongs to another role, call the actions tool handoff_to_role with its id and a note of what you found and what is needed, then stop.${manager ? ` Escalate to "${ROOT_ROLE_ID}" only when Dave must weigh in across the business.` : ""} Don't hand work back to the role that gave it to you. ${b.handoffsLeft} handoff${b.handoffsLeft === 1 ? "" : "s"} left in this chain.`
      : "The handoff limit for this chain is reached: finish the work yourself, or propose a notify so Dave sees it.",
  );
  return lines.join("\n");
}

/** Handoff tasks get the readable prompt the server wrote for them. */
function handoffPrompt(event: Event): string | null {
  return event.source === "system" && event.kind === "handoff" && typeof event.payload.prompt === "string" ? event.payload.prompt : null;
}
// --- end org roles ---

/**
 * `actions` always, plus each server the manifest lists that is actually
 * mounted at `/mcp/<name>` (e.g. `odoo` only when Odoo is configured).
 */
export function mcpServersFor(
  vertical: VerticalManifest,
  baseUrl: string,
  token: string,
  mounted: readonly string[] = ["brain"],
  /** The run's role's servers (a subset of the vertical's); default: the vertical's. */
  names: readonly string[] = vertical.mcpServers,
): Record<string, McpServerConfig> {
  const headers = { Authorization: `Bearer ${token}` };
  const servers: Record<string, McpServerConfig> = {
    actions: { type: "http", url: `${baseUrl}/mcp/actions`, headers },
  };
  for (const name of names) {
    if (mounted.includes(name)) servers[name] = { type: "http", url: `${baseUrl}/mcp/${name}`, headers };
  }
  return servers;
}

export function allowedToolsFor(mcpServers: Record<string, McpServerConfig>): string[] {
  return ["Skill", ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}
