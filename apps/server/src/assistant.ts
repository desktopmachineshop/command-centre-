import { ROOT_ROLE_ID, type Role } from "@cc/core";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";

/**
 * Agent mode "assistant" (Accounts → Agents → Agent mode): Dave's chats go to one assistant, the
 * org's root role, instead of being routed round the org chart. The assistant:
 *
 * - has every business's MCP servers and every skill, so it can answer from Odoo, mail, parcels,
 *   the calendar and the brain itself (`assistantServers`, `assistantSkills`);
 * - knows the businesses as context and names the business on each action it proposes;
 * - hands work only to the specialists (`SPECIALISTS`), which keep their own tools (the Software
 *   Lead's shell and checkout, say) and report back to it.
 *
 * Events from outside (email, Odoo, social, webhooks) still go to the org's roles in this mode.
 */

/** The specialists the assistant hands work to, as "<vertical>/<role>". */
export const SPECIALISTS = ["command-centre/software-lead", "3dpandme/video-producer", "3dpandme/blog-writer"] as const;

export const isSpecialist = (vertical: string, role: string | null | undefined) => !!role && (SPECIALISTS as readonly string[]).includes(`${vertical}/${role}`);

/** Every MCP server some business lists. */
export function assistantServers(registry: VerticalRegistry): string[] {
  return [...new Set(registry.all().flatMap((v) => v.mcpServers))];
}

/** Every skill a business or role lists: the assistant's workspace links them all. */
export function assistantSkills(registry: VerticalRegistry): string[] {
  return [...new Set(registry.all().flatMap((v) => [...v.skills, ...registry.roles(v.id).flatMap((r) => r.skills)]))];
}

/** The assistant's role for its workspace: the root role with every skill. */
export function assistantRole(registry: VerticalRegistry): Pick<Role, "id" | "skills"> {
  return { id: ROOT_ROLE_ID, skills: assistantSkills(registry) };
}

/** The specialists that exist in the org now (a vertical or role may have been removed). */
export function specialists(registry: VerticalRegistry): { id: string; role: OrgRole; vertical: string }[] {
  return SPECIALISTS.flatMap((id) => {
    const [vertical, roleId] = id.split("/") as [string, string];
    const role = registry.get(vertical) ? registry.roles(vertical).find((r) => r.id === roleId) : undefined;
    return role ? [{ id, role, vertical: registry.require(vertical).name }] : [];
  });
}

const firstSentence = (s: string) => (/^.*?[.!?](\s|$)/.exec(s)?.[0] ?? s).trim();

/** The assistant's charter in its system prompt: who it is, the businesses, the specialists. */
export function assistantCharter(registry: VerticalRegistry, handoffsLeft: number): string {
  const lines = [
    "## You are Dave's assistant",
    "Dave's chats and voice requests come to you, for every business and for his own life admin. Do the work yourself: you have every business's tools (Odoo, mail, parcels, calendar and reminders, the brain, the app's ops and docs) and every skill. Look things up rather than guessing, and answer him directly.",
    "",
    "The businesses (context for your work: their notes are in the brain under their folder):",
    ...registry.all().map((v) => `- ${v.id}: ${v.name}. ${firstSentence(v.description)} Brain folder "${v.brainFolder}/".`),
    "",
    'Every action you propose belongs to one business: pass its id as `vertical` to propose_action and propose_batch (e.g. "dms" for a reply to a shop customer). That business\'s approval policy and budget apply to it. Leave it out only for Dave\'s own things.',
  ];
  const team = specialists(registry);
  if (team.length) {
    lines.push("", "Specialists you can hand work to (they have tools you don't, and report back to you on this task):");
    for (const s of team) lines.push(`- ${s.id}: ${s.role.title} (${s.vertical}). ${firstSentence(s.role.mission)}`);
    lines.push(
      handoffsLeft > 0
        ? "Hand off only work that needs a specialist: code changes in the repository, producing a video, writing a blog post. Call handoff_to_role with its id and a clear brief (it also gets this task's handover note), tell Dave in one line who has it, and stop. When its report comes back as a new turn, give Dave the outcome. Everything else you do yourself: no other role takes handoffs in this mode."
        : "The handoff limit for this chain is reached: finish the work yourself, or propose a notify so Dave sees it.",
    );
  }
  lines.push("", "Several actions of the same kind (a message to each open order) go in one propose_batch, so Dave approves them once.");
  return lines.join("\n");
}
