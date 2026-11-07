import { type OrgRoleNode, type OrgTree, type OrgVerticalNode, ROOT_ROLE_ID, type RoleStats } from "@cc/core";
import type { OrgRole, VerticalRegistry } from "@cc/verticals";

export type RoleStatsRow = { vertical: string; role: string | null; open: number; done: number; costUsd: number; pending: number };

const zero = (): RoleStats => ({ openTasks: 0, doneTasks: 0, costUsd: 0, pendingApprovals: 0 });

const add = (a: RoleStats, b: RoleStats): RoleStats => ({
  openTasks: a.openTasks + b.openTasks,
  doneTasks: a.doneTasks + b.doneTasks,
  costUsd: a.costUsd + b.costUsd,
  pendingApprovals: a.pendingApprovals + b.pendingApprovals,
});

const schedulesOf = (list: { id: string; cron: string; timezone: string; enabled: boolean }[]) =>
  list.map(({ id, cron, timezone, enabled }) => ({ id, cron, timezone, enabled }));

/**
 * The Businesses page (GET /api/org): the assistant, then each business with its context, policies,
 * schedules, budget and specialists, each with live numbers. A task counts towards its specialist
 * when it names one, otherwise towards the assistant (tasks of roles that no longer exist included).
 */
export function buildOrgTree(registry: VerticalRegistry, rows: RoleStatsRow[], windowDays: number, now = new Date()): OrgTree {
  const stats = new Map<string, RoleStats>();
  for (const row of rows) {
    if (!registry.get(row.vertical)) continue;
    const specialist = registry.roles(row.vertical).some((r) => r.id === row.role && r.id !== ROOT_ROLE_ID);
    const value = { openTasks: row.open, doneTasks: row.done, costUsd: row.costUsd, pendingApprovals: row.pending };
    const key = `${row.vertical}/${specialist ? row.role : ROOT_ROLE_ID}`;
    stats.set(key, add(stats.get(key) ?? zero(), value));
  }

  const node = (r: OrgRole, vertical: string, s: RoleStats): OrgRoleNode => ({
    id: r.id,
    title: r.title,
    mission: r.mission,
    vertical,
    aliases: r.aliases,
    skills: r.skills,
    mcpServers: r.mcpServers ?? registry.get(vertical)?.mcpServers ?? [],
    actions: r.actions,
    schedules: schedulesOf(r.schedules),
    kpis: r.kpis,
    autonomyNotes: r.autonomyNotes,
    stats: s,
  });

  let assistant = zero();
  const verticals: OrgVerticalNode[] = registry.all().map((v) => {
    const own = stats.get(`${v.id}/${ROOT_ROLE_ID}`) ?? zero();
    assistant = add(assistant, own);
    const specialists = registry
      .roles(v.id)
      .filter((r) => r.id !== ROOT_ROLE_ID)
      .map((r) => node(r, v.id, stats.get(`${v.id}/${r.id}`) ?? zero()));
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      color: v.color ?? null,
      brainFolder: v.brainFolder,
      policies: v.policies,
      defaultPolicy: v.defaultPolicy,
      dailyBudgetUsd: v.dailyBudgetUsd ?? null,
      schedules: schedulesOf(v.schedules),
      stats: specialists.reduce((sum, n) => add(sum, n.stats), own),
      specialists,
    };
  });

  const root = node(registry.root, registry.rootVertical, assistant);
  return { windowDays, generatedAt: now.toISOString(), root: { ...root, verticals } };
}
