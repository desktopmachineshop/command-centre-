import { ROOT_ROLE_ID, type Role, type VerticalManifest } from "@cc/core";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";

/**
 * Dave's assistant: the org's root role, which takes every task (chats, schedules, email, Odoo,
 * social and webhooks) unless it names a specialist. It:
 *
 * - has every skill and, for work Dave started, every business's MCP servers, so it answers from
 *   Odoo, mail, parcels, the calendar and the brain itself (`assistantServers`, `assistantSkills`),
 *   and names the business on each action it proposes;
 * - on work from outside input (an email, a webhook, Odoo, social) keeps to that business's servers,
 *   and its proposals are that business's and wait for Dave, as before;
 * - knows the businesses as context, each with a how-we-work note in the brain;
 * - hands work only to the specialists (each business's `roles`: the Software Lead, Video Producer
 *   and Blog Writer), which keep their own tools and report back to it.
 */

/** Every MCP server some business lists. */
export function assistantServers(registry: VerticalRegistry): string[] {
  return [...new Set(registry.all().flatMap((v) => v.mcpServers))];
}

/** Every skill a business or specialist lists: the assistant's workspace links them all. */
export function assistantSkills(registry: VerticalRegistry): string[] {
  return [...new Set([...registry.root.skills, ...registry.all().flatMap((v) => [...v.skills, ...registry.roles(v.id).flatMap((r) => r.skills)])])];
}

/** The assistant's role for its workspace: the root role with every skill. */
export function assistantRole(registry: VerticalRegistry): Pick<Role, "id" | "skills"> {
  return { id: ROOT_ROLE_ID, skills: assistantSkills(registry) };
}

/** Every specialist, as "<vertical>/<role>". */
export function specialists(registry: VerticalRegistry): { id: string; role: OrgRole; vertical: string }[] {
  return registry.all().flatMap((v) =>
    registry
      .roles(v.id)
      .filter((r) => r.id !== ROOT_ROLE_ID)
      .map((role) => ({ id: `${v.id}/${role.id}`, role, vertical: v.name })),
  );
}

/** The brain note with how a business's work is done (seeded from its `guidance`). */
export const howWeWorkPath = (v: Pick<VerticalManifest, "brainFolder">) => `${v.brainFolder}/how-we-work.md`;

const firstSentence = (s: string) => (/^.*?[.!?](\s|$)/.exec(s)?.[0] ?? s).trim();

/**
 * The assistant's charter in its system prompt: who it is, the businesses, the specialists.
 * `vertical` is the business the task was triaged to; `trusted` is false for work from outside input.
 */
export function assistantCharter(registry: VerticalRegistry, vertical: VerticalManifest, handoffsLeft: number, trusted: boolean): string {
  const root = registry.root;
  const lines = [
    `## You are Dave's assistant (${root.title})`,
    root.mission,
    "",
    "The businesses (context for your work; each has its notes in the brain under its folder, and a how-we-work note there with what good looks like and what always needs Dave: read it before working on that business):",
    ...registry.all().map((v) => `- ${v.id}: ${v.name}. ${firstSentence(v.description)} Brain folder "${v.brainFolder}/", how-we-work note "${howWeWorkPath(v)}".`),
    "",
    `This task is filed under ${vertical.name} (${vertical.id}).`,
  ];
  if (trusted) {
    lines.push(
      "You have every business's tools (Odoo, mail, parcels, calendar and reminders, the brain, Reddit and web research, the app's ops and docs) and every skill. Look things up rather than guessing, and answer Dave directly.",
      'Every action you propose belongs to one business: pass its id as `vertical` to propose_action and propose_batch (e.g. "dms" for a reply to a shop customer). That business\'s approval policy and budget apply. Leave it out for this task\'s own business.',
    );
  } else {
    lines.push(
      `This task came from outside input, so you have only ${vertical.name}'s tools, and every action you propose is ${vertical.name}'s and waits for Dave's approval.`,
    );
  }
  if (root.autonomyNotes) lines.push("", `Autonomy: ${root.autonomyNotes}`);
  const team = specialists(registry);
  if (team.length) {
    lines.push("", "Specialists you can hand work to (they have tools you don't, and report back to you on this task):");
    for (const s of team) lines.push(`- ${s.id}: ${s.role.title} (${s.vertical}). ${firstSentence(s.role.mission)}`);
    lines.push(
      handoffsLeft > 0
        ? "Hand off only work that needs a specialist: code changes in the Command Centre's repository, producing a video, writing a blog post. Call handoff_to_role with its id and a clear brief (it also gets this task's handover note), tell Dave in one line who has it, and stop. When its report comes back as a new turn, give Dave the outcome. Everything else you do yourself."
        : "The handoff limit for this chain is reached: finish the work yourself, or propose a notify so Dave sees it.",
    );
  }
  lines.push("", "Several actions of the same kind (a message to each open order) go in one propose_batch, so Dave approves them once.");
  return lines.join("\n");
}
