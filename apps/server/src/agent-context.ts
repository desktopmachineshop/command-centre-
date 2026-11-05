import type { McpServerConfig } from "@cc/agent-runtime";
import { type Event, ROOT_ROLE_ID, type Task, type VerticalManifest } from "@cc/core";
import { emailPrompt } from "@cc/email";
import { odooPrompt } from "@cc/odoo";
import { socialPrompt } from "@cc/social";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";
import { voiceResponseInstructions } from "@cc/voice";
import type { ActionExecutor } from "./actions";

/** The prompt an agent gets for a task, derived from the event that caused it. */
export function taskPrompt(event: Event): string {
  const p = event.payload;
  // Voice-mode chats (Drive mode) store just Dave's words; the spoken-answer rules are added
  // when the run starts (`runPrompt`), so they never show in the app or travel with a handoff.
  // Files attached in the chat box come after his words (see ./chat-files.ts).
  if (event.source === "chat" && typeof p.text === "string") {
    // From Drive mode: what Dave had just heard, so "that" and "her" in his words make sense.
    const heard = typeof p.heard === "string" && p.heard ? `\n\n(Said in Drive mode. To work out what he means, just before this Dave heard ${p.heard})` : "";
    return `${p.text}${heard}${typeof p.filesPrompt === "string" && p.filesPrompt ? `\n\n${p.filesPrompt}` : ""}`;
  }
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

/** What the agent is given for a task's first run: its prompt, plus the spoken-answer rules for a voice-mode chat. */
export function runPrompt(task: Pick<Task, "prompt">, event: Event | null): string {
  return event?.source === "chat" && event.payload.voice === true ? voicePrompt(task.prompt) : task.prompt;
}

/** Voice mode: Dave's words plus the spoken-answer rules and response protocol (see @cc/voice). */
export function voicePrompt(text: string): string {
  return `${text}\n\n${voiceResponseInstructions}`;
}

/**
 * What every agent knows about the Command Centre itself: what it is, how work flows through it,
 * and where things live in the app. The detail (each page, setting and setup step) is in the help
 * docs, which runs search with the "help" MCP tools (./help-docs.ts).
 */
export const COMMAND_CENTRE_PRIMER = `## About the Command Centre (the app you run in)
Command Centre is Dave's private app for running his businesses and life admin in one place: Desktop Machine Shop (DMS: CNC accessories and kits on Odoo Online), 3dpandme (blog, Instagram and YouTube on the same Odoo), OpenV and OpenD (his SaaS products), personal admin, and the Command Centre software itself. Dave is its only user. He uses it as an installed web app on his phone and PC (and hands-free by voice in the car); Windows PCs running its desktop app are workers for heavy jobs such as video renders. Agents (you, and the other roles in the org chart) do the work; Dave decides what goes out.

How work flows:
1. Everything that comes in becomes a task: an email, an Odoo order or helpdesk message, a social comment or DM, a schedule firing, or Dave's own message in Chat or Converse (voice).
2. Triage picks the business and the kind of work; spam and noise are filed without a run.
3. The task goes to the role that owns that kind of work (the Org page), or to the business's lead. Dave's chats go to the Chief of Staff first, which answers or hands work on with handoff_to_role; reports come back to it.
4. A run (this one) reads the brain, uses its skills and tools, and proposes actions. Dave can follow every step in the task's Conversation (Inbox, then the task).
5. Each business's policy decides, per action type, whether a proposal waits for Dave in Approvals (the default, with a push), runs and is listed in the daily digest, or runs straight away. Work that started from outside input (an email, a webhook, Odoo, social), or that has read mail or such a transcript, always waits for approval.
6. Every run is costed against a daily budget per business; once it is spent, new tasks are deferred until after midnight unless Dave chooses Run now.

Where things live in the app: Inbox (every task, today's spend), Today (calendar, reminders, lists), Approvals, Chat, Converse (voice), Notifications; Social (compose and schedule posts), Org (roles, missions, policies, schedules: Dave edits them there, changes apply to the next task); Brain (the shared notes); Accounts (sign-ins for Claude, Odoo, mailboxes, Google, social accounts: changes apply without a redeploy), Devices (worker PCs), Storage, Settings (install, update, password, two-factor), Notification settings (what pushes where, quiet hours, digests). The server runs on Railway, configured with environment variables.`;

/** How to answer questions about the app: from the help docs, given with the "help" MCP server. */
export const HELP_INSTRUCTIONS = `Questions about the app itself ("how do I…", "where is…", "why did it…", "is X connected", "how is it set up"): look it up with the "help" tools before answering: search_help, then read_help_topic for the topic that fits. Answer with the page, the button and the steps as the help names them (e.g. "Settings, then Set up two-factor"); the help's page routes, like #/approvals, are the app's own links. Don't invent pages, buttons or settings the help doesn't mention: if it doesn't cover something, say so plainly, and if something in the app looks broken, report it with report_issue. You can't click in the app or change its settings, accounts or org chart: tell Dave where to do it.`;

export function systemPrompt(
  vertical: VerticalManifest,
  executors: Record<string, ActionExecutor>,
  now = new Date(),
  role?: RoleBrief,
  /** The app's pages with their help topic ids (HelpDocs.pageGuide), when the docs are installed (and so the "help" server is). */
  appGuide?: string,
): string {
  const actions = Object.entries(executors)
    .map(([type, e]) => `- ${type}: ${e.description}`)
    .join("\n");
  const who = role ? `the ${role.role.title} in Dave's Command Centre, working on: ${vertical.name}` : `the Command Centre agent working for Dave on: ${vertical.name}`;
  return `You are ${who}.
${vertical.description}

Today is ${now.toISOString().slice(0, 10)}.
${role ? `\n${roleCharter(role)}\n` : ""}
Long-term memory lives in the brain (MCP server "brain"). Before answering, search it for relevant context; this vertical's notes are under "${vertical.brainFolder}/". Record durable facts, decisions and outcomes there (use the journal for one-line events). Bugs, faults and anything broken in the Command Centre, its agents or integrations go in the central issue log with the brain tool report_issue (never a note in your own folder).

You never act on the outside world directly. To send, publish, change or notify anything, call the "actions" MCP tool propose_action. Depending on policy it runs straight away or waits for Dave's approval. For several related actions (a message to each of a list of customers or orders), use propose_batch instead: Dave sees every item and approves or rejects them once. Available action types:
${actions}

Finish with a short summary of what you found and what you proposed.

${COMMAND_CENTRE_PRIMER}${appGuide ? `\n\n${HELP_INSTRUCTIONS}\n\n${appGuide}` : ""}`;
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
    "When a role you handed work to finishes, its report comes back to you as a new turn on this task: use it to finish (give the outcome, and anything waiting for Dave's approval).",
  );
  if (!manager && b.handoffsLeft > 0) {
    lines.push(
      "",
      "You are Dave's front door: his chats and voice requests come to you unless he names a business or role.",
      "- Do it yourself when it is yours or quick: his calendar, reminders, lists, a brain lookup, a question across the businesses, the morning brief.",
      "- Otherwise hand it to the role that owns it without asking him first (handoff_to_role with \"<vertical>/<role>\" and a clear brief of what he wants), then tell him in one line who has it, e.g. \"I've asked the Shop Lead to check order 1042; I'll come back to you.\"",
      "- When a request spans several roles or businesses, split it: one handoff_to_role per role, each with only its part, all from this task. Don't ask one role to pass work on to the next; a chain is limited to a few handoffs, and parallel handoffs each use just one. Each role reports back to you separately.",
      "- To add to work a role already has (a correction, an extra item, an answer to its question), call handoff_to_role for that role again: it reaches the same task as a follow-up, even while it is still running.",
      "- Several actions of the same kind (a message to each open order) go in one propose_batch, so Dave approves them once.",
      "- When a report comes back, answer Dave with the result in plain words.",
    );
  }
  return lines.join("\n");
}

/** Handoff tasks get the readable prompt the server wrote for them. */
function handoffPrompt(event: Event): string | null {
  return event.source === "system" && event.kind === "handoff" && typeof event.payload.prompt === "string" ? event.payload.prompt : null;
}
// --- end org roles ---

/**
 * `actions` always, `help` while the docs are installed, plus each server the manifest lists
 * that is actually mounted at `/mcp/<name>` (e.g. `odoo` only when Odoo is configured).
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
  // help (the app's own docs) is for every run, like actions, while the docs are installed.
  if (mounted.includes("help")) servers.help = { type: "http", url: `${baseUrl}/mcp/help`, headers };
  for (const name of names) {
    if (mounted.includes(name)) servers[name] = { type: "http", url: `${baseUrl}/mcp/${name}`, headers };
  }
  return servers;
}

export function allowedToolsFor(mcpServers: Record<string, McpServerConfig>): string[] {
  return ["Skill", ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}
