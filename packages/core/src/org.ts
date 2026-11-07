import { z } from "zod";
import { Policy } from "./domain";
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

/**
 * What the Org page may change in a vertical: its roles and its action policies.
 * Saved over the code manifest (apps/server/src/org-config.ts); the rest of the
 * manifest (intents, skills, servers, budget) stays in code.
 */
export const VerticalOrgEdit = z.object({
  roles: z.array(Role),
  policies: z.record(z.string(), Policy),
  defaultPolicy: Policy,
});
export type VerticalOrgEdit = z.infer<typeof VerticalOrgEdit>;

/** What the Org page may change about the Chief of Staff: everything but its id and home vertical. */
export const RootOrgEdit = OrgRoot.omit({ id: true, homeVertical: true });
export type RootOrgEdit = z.infer<typeof RootOrgEdit>;

/** One editable part of the org (a vertical, or the Chief of Staff) as the Org page edits it (GET /api/org/config). */
export interface OrgConfigUnit<T> {
  /** A vertical id, or ROOT_ROLE_ID. */
  unit: string;
  /** What the editor starts from: the saved change, or the code's when there is none. */
  current: T;
  /** As the code defines it, for "Reset to code". */
  base: T;
  /** True when a change saved from the app is stored for this unit. */
  overridden: boolean;
  /** Latest saved version (0 when never changed); a save sends it back and gets a 409 if it is stale. */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Why the saved change isn't running (the code changed under it); the code's version runs instead. */
  problem: string | null;
}

export interface OrgConfig {
  verticals: (OrgConfigUnit<VerticalOrgEdit> & { name: string; color: string | null; intents: string[]; mcpServers: string[] })[];
  root: OrgConfigUnit<RootOrgEdit> & { homeVertical: string; mcpServers: string[] };
  /** The skills bank, for the skill pickers. */
  skills: { name: string; description: string }[];
  /** Action types the server can run, for the policy and action pickers. */
  actionTypes: string[];
}

export interface OrgConfigVersion {
  version: number;
  author: string;
  /** True for a reset to the code manifest. */
  reset: boolean;
  createdAt: string;
}

/** Live numbers for one role (GET /api/org), over the last `windowDays`. */
export interface RoleStats {
  openTasks: number;
  doneTasks: number;
  costUsd: number;
  pendingApprovals: number;
}

/** A card on the Businesses page: the assistant, or a specialist. */
export interface OrgRoleNode {
  id: string;
  title: string;
  mission: string;
  /** Business whose tasks it runs (the home business for the assistant, whose tasks run in every business). */
  vertical: string;
  aliases: string[];
  skills: string[];
  mcpServers: string[];
  actions: string[];
  schedules: { id: string; cron: string; timezone: string; enabled: boolean }[];
  kpis: string[];
  autonomyNotes: string;
  stats: RoleStats;
}

/** A business on the Businesses page: its context, its rules, its schedules and its specialists. */
export interface OrgVerticalNode {
  id: string;
  name: string;
  description: string;
  color: string | null;
  brainFolder: string;
  /** Per action type: auto, auto-with-digest or draft. Unlisted types use `defaultPolicy`. */
  policies: Record<string, string>;
  defaultPolicy: string;
  dailyBudgetUsd: number | null;
  /** The business's own schedules (each runs as the assistant). */
  schedules: { id: string; cron: string; timezone: string; enabled: boolean }[];
  /** Everything done in this business: the assistant's tasks and the specialists'. */
  stats: RoleStats;
  specialists: OrgRoleNode[];
}

export interface OrgTree {
  windowDays: number;
  generatedAt: string;
  root: OrgRoleNode & { verticals: OrgVerticalNode[] };
}
