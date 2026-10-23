import { z } from "zod";
import { ROOT_ROLE_ID, Role } from "./vertical";

/**
 * The top of the org chart: the Chief of Staff, above every vertical lead. It
 * has no vertical of its own, so its tasks run in `homeVertical` (for budgets,
 * run slots and MCP access) with the role "chief-of-staff".
 */
export const OrgRoot = Role.omit({ reportsTo: true }).extend({
  id: z.literal(ROOT_ROLE_ID),
  homeVertical: z.string().regex(/^[a-z0-9-]+$/),
});
export type OrgRoot = z.infer<typeof OrgRoot>;
export type OrgRootInput = z.input<typeof OrgRoot>;

export function defineOrgRoot(input: OrgRootInput): OrgRoot {
  return OrgRoot.parse(input);
}

/** Live numbers for one role (GET /api/org), over the last `windowDays`. */
export interface RoleStats {
  openTasks: number;
  doneTasks: number;
  costUsd: number;
  pendingApprovals: number;
}

/** One card in the org chart. */
export interface OrgRoleNode {
  id: string;
  title: string;
  mission: string;
  /** Vertical whose tasks this role runs (the home vertical for the Chief of Staff). */
  vertical: string;
  reportsTo: string | null;
  /** True for the lead a vertical without an org chart gets. */
  implicit: boolean;
  aliases: string[];
  intents: string[];
  skills: string[];
  mcpServers: string[];
  actions: string[];
  schedules: { id: string; cron: string; timezone: string; enabled: boolean }[];
  kpis: string[];
  autonomyNotes: string;
  stats: RoleStats;
  children: OrgRoleNode[];
}

export interface OrgVerticalNode {
  id: string;
  name: string;
  description: string;
  color: string | null;
  /** Sum over the vertical's roles. */
  stats: RoleStats;
  lead: OrgRoleNode;
}

export interface OrgTree {
  windowDays: number;
  generatedAt: string;
  root: OrgRoleNode & { verticals: OrgVerticalNode[] };
}
