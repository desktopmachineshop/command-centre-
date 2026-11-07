import { ROOT_ROLE_ID, type Role, type VerticalOrgEdit } from "@cc/core";

/**
 * The old org chart's roles, retired when the Command Centre moved to one assistant (their guidance
 * lives on in each business's how-we-work note). A saved edit that still has one drops it.
 */
export const RETIRED_ROLES = new Set([
  "shop-lead", "customer-support", "catalogue-pricing", "marketing-social", "ops-admin",
  "content-lead", "community-manager",
  "pa", "calendar-reminders", "home-family", "finance-admin",
  "product-lead", "support-engineer", "docs-writer", "devrel-content", "billing-admin",
]);

/**
 * A vertical's Org-page edit, brought up to date with the code.
 *
 * Saving on the Org page stores every role and policy of the vertical, so without this a save
 * would freeze the vertical as it was that day: an action, MCP server, skill, schedule or policy
 * the code adds to a role later would never reach it. This is a three-way merge against the code
 * as it was when Dave saved (`codeAtSave`): what the code added since then joins the saved
 * roles, and what Dave removed on purpose stays removed.
 *
 * - `tools`, `repo` and `maxTurns` always come from the code: the Org page doesn't edit them.
 * - `skills`, `actions` and a role's own `mcpServers` list gain the code's new entries.
 * - Schedules the code added (by id) join the role; Dave's edits to existing ones stand.
 * - Policies the code added (by action type) join the vertical's.
 *
 * Without `codeAtSave` (a save from before it was recorded) everything in the code that the save
 * lacks counts as new. Specialists Dave added are kept; the old org chart's roles (`RETIRED_ROLES`)
 * are dropped, and every specialist reports to the assistant. Pure.
 */
export function mergeOrgEdit(saved: VerticalOrgEdit, code: VerticalOrgEdit, codeAtSave: VerticalOrgEdit | null): VerticalOrgEdit {
  const then = new Map((codeAtSave?.roles ?? []).map((r) => [r.id, r]));
  const now = new Map(code.roles.map((r) => [r.id, r]));
  const added = <T>(current: readonly T[], before: readonly T[] | undefined, has: readonly T[]) =>
    current.filter((x) => !(before ?? []).includes(x) && !has.includes(x));
  // Schedule ids are unique across the vertical: never add one any saved role already has.
  const scheduleIds = new Set(saved.roles.flatMap((r) => r.schedules.map((s) => s.id)));
  const roles = saved.roles.filter((role) => !RETIRED_ROLES.has(role.id) || now.has(role.id)).map((role): Role => {
    const c = now.get(role.id);
    if (!c) return { ...role, reportsTo: ROOT_ROLE_ID };
    const t = then.get(role.id);
    const schedules = [...role.schedules];
    for (const s of c.schedules) {
      if (scheduleIds.has(s.id) || t?.schedules.some((x) => x.id === s.id)) continue;
      scheduleIds.add(s.id);
      schedules.push(s);
    }
    // A role with no list of its own (`mcpServers` unset) already has all of the vertical's.
    const mcpServers =
      role.mcpServers && c.mcpServers ? [...role.mcpServers, ...added(c.mcpServers, t?.mcpServers, role.mcpServers)] : role.mcpServers;
    const { maxTurns: _m, repo: _r, ...rest } = role;
    return {
      ...rest,
      skills: [...role.skills, ...added(c.skills, t?.skills, role.skills)],
      actions: [...role.actions, ...added(c.actions, t?.actions, role.actions)],
      ...(mcpServers ? { mcpServers } : {}),
      schedules,
      reportsTo: ROOT_ROLE_ID,
      tools: c.tools,
      ...(c.repo ? { repo: c.repo } : {}),
      ...(c.maxTurns ? { maxTurns: c.maxTurns } : {}),
    };
  });
  const policies = { ...saved.policies };
  for (const [type, policy] of Object.entries(code.policies)) {
    if (!(type in policies) && !(codeAtSave && type in codeAtSave.policies)) policies[type] = policy;
  }
  return { ...saved, roles, policies };
}
