import { leadOf, type OrgRoleNode, type OrgTree, type OrgVerticalNode, ROOT_ROLE_ID, type RoleStats } from "@cc/core";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";

export type RoleStatsRow = { vertical: string; role: string | null; open: number; done: number; costUsd: number; pending: number };

const zero = (): RoleStats => ({ openTasks: 0, doneTasks: 0, costUsd: 0, pendingApprovals: 0 });

const add = (a: RoleStats, b: RoleStats): RoleStats => ({
  openTasks: a.openTasks + b.openTasks,
  doneTasks: a.doneTasks + b.doneTasks,
  costUsd: a.costUsd + b.costUsd,
  pendingApprovals: a.pendingApprovals + b.pendingApprovals,
});

/**
 * The org chart for GET /api/org: Chief of Staff → verticals → leads → roles,
 * each role with its live numbers. Tasks without a role (from before roles)
 * and tasks naming a role that no longer exists count towards the vertical's lead.
 */
export function buildOrgTree(registry: VerticalRegistry, rows: RoleStatsRow[], windowDays: number, now = new Date()): OrgTree {
  const stats = new Map<string, RoleStats>();
  const keyOf = (vertical: string, role: string | null): string | null => {
    const v = registry.get(vertical);
    if (!v) return null;
    if (role === ROOT_ROLE_ID && vertical === registry.rootVertical) return `${vertical}/${ROOT_ROLE_ID}`;
    const known = registry.roles(vertical).some((r) => r.id === role && r.id !== ROOT_ROLE_ID);
    return `${vertical}/${known ? role : leadOf(v).id}`;
  };
  for (const row of rows) {
    const key = keyOf(row.vertical, row.role);
    if (!key) continue;
    stats.set(key, add(stats.get(key) ?? zero(), { openTasks: row.open, doneTasks: row.done, costUsd: row.costUsd, pendingApprovals: row.pending }));
  }

  const node = (r: OrgRole, vertical: string, implicit: boolean): OrgRoleNode => ({
    id: r.id,
    title: r.title,
    mission: r.mission,
    vertical,
    reportsTo: r.reportsTo,
    implicit,
    aliases: r.aliases,
    intents: r.intents,
    skills: r.skills,
    mcpServers: r.mcpServers ?? registry.get(vertical)?.mcpServers ?? [],
    actions: r.actions,
    schedules: r.schedules.map(({ id, cron, timezone, enabled }) => ({ id, cron, timezone, enabled })),
    kpis: r.kpis,
    autonomyNotes: r.autonomyNotes,
    stats: stats.get(`${vertical}/${r.id}`) ?? zero(),
    children: [],
  });

  const verticals: OrgVerticalNode[] = registry.all().map((v) => {
    const roles = registry.roles(v.id).filter((r) => r.id !== ROOT_ROLE_ID);
    const nodes = new Map(roles.map((r) => [r.id, node(r, v.id, v.roles.length === 0)]));
    let lead: OrgRoleNode | undefined;
    for (const r of roles) {
      const n = nodes.get(r.id)!;
      if (r.reportsTo === ROOT_ROLE_ID) lead = n;
      else nodes.get(r.reportsTo!)?.children.push(n);
    }
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      color: v.color ?? null,
      stats: [...nodes.values()].reduce((sum, n) => add(sum, n.stats), zero()),
      lead: lead!,
    };
  });

  const root = node(registry.root, registry.rootVertical, false);
  return { windowDays, generatedAt: now.toISOString(), root: { ...root, verticals } };
}
