import type { Role, VerticalOrgEdit } from "@cc/core";

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
 * lacks counts as new. Roles Dave added or removed are left as he saved them. Pure.
 */
export function mergeOrgEdit(saved: VerticalOrgEdit, code: VerticalOrgEdit, codeAtSave: VerticalOrgEdit | null): VerticalOrgEdit {
  const then = new Map((codeAtSave?.roles ?? []).map((r) => [r.id, r]));
  const now = new Map(code.roles.map((r) => [r.id, r]));
  const added = <T>(current: readonly T[], before: readonly T[] | undefined, has: readonly T[]) =>
    current.filter((x) => !(before ?? []).includes(x) && !has.includes(x));
  // Schedule ids are unique across the vertical: never add one any saved role already has.
  const scheduleIds = new Set(saved.roles.flatMap((r) => r.schedules.map((s) => s.id)));
  const roles = saved.roles.map((role): Role => {
    const c = now.get(role.id);
    if (!c) return role;
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
