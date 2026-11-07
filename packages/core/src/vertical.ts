import { z } from "zod";
import { Policy } from "./domain";

/** True when `Intl` knows the zone, so "today" and cron times can be computed. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const Schedule = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: z.string(),
  timezone: z.string().refine(isTimeZone, "not a known IANA timezone").default("Europe/London"),
  /** Prompt handed to the command agent when the schedule fires. */
  prompt: z.string(),
  enabled: z.boolean().default(true),
});
export type Schedule = z.infer<typeof Schedule>;

/** Id of the org root: Dave's assistant, which takes all work and hands specialist work to the roles. */
export const ROOT_ROLE_ID = "chief-of-staff";

const slug = z.string().regex(/^[a-z0-9-]+$/);

/**
 * A specialist in a business: an agent the assistant hands specialist work to (code changes, a
 * video, a blog post), with its own skills, MCP servers and tools, and its mission and autonomy
 * notes in its system prompt. Every other task runs as the assistant (ROOT_ROLE_ID). See docs/ORG.md.
 */
export const Role = z.object({
  id: slug,
  title: z.string().min(1),
  /** Two or three sentences: what the role is for and what good looks like. */
  mission: z.string().min(1),
  /** Who it reports to: always the assistant (ROOT_ROLE_ID). Kept so older saved edits still parse. */
  reportsTo: z.string().min(1).default(ROOT_ROLE_ID),
  /** Extra names Dave can address the role by in chat ("support: ..."). */
  aliases: z.array(slug).default([]),
  /** No longer used (every task goes to the assistant unless it names a specialist). Kept so older saved edits still parse. */
  intents: z.array(z.string()).default([]),
  /** Skills from the bank this role's workspace gets (and only these). */
  skills: z.array(z.string()).default([]),
  /** A subset of the vertical's MCP servers. Unset: all of the vertical's. */
  mcpServers: z.array(z.string()).optional(),
  /** Action types the role is expected to propose. Guidance and display only: policy still decides. */
  actions: z.array(z.string()).default([]),
  /**
   * Claude Code's own tools the role's runs may use (e.g. Bash, Read, Edit, Write, Glob, Grep for a
   * coding role). Only for tasks Dave started (chat, schedules, and handoffs from those); a task from
   * outside input never gets them. Unset: none, just skills and MCP tools.
   */
  tools: z.array(z.enum(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"])).default([]),
  /** Most agent turns per run for this role. Unset: the server's AGENT_MAX_TURNS. A coding role needs many more than a chat. */
  maxTurns: z.number().int().min(1).max(500).optional(),
  /** GitHub repository ("owner/name") checked out for each of the role's tasks, in its workspace (needs GITHUB_TOKEN). */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name")
    .optional(),
  /** Schedules whose tasks go to this specialist. Ids are unique across the whole vertical. */
  schedules: z.array(Schedule).default([]),
  /** What the role is measured on, for display. */
  kpis: z.array(z.string()).default([]),
  /** What it may propose on its own, and what always needs Dave. */
  autonomyNotes: z.string().default(""),
});
export type Role = z.infer<typeof Role>;
export type RoleInput = z.input<typeof Role>;

/**
 * A vertical is a business, side project or life area the command centre manages.
 * Adding a vertical means adding one manifest; nothing else in the core changes.
 */
export const VerticalManifest = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    description: z.string(),
    /** Folder inside the brain repo that holds this vertical's notes. */
    brainFolder: z.string(),
    /** Intents the triager may assign to events in this vertical. "other" is always allowed. */
    intents: z.array(z.string()).default([]),
    /** Skill names from the shared skills bank this vertical's agents may use. */
    skills: z.array(z.string()).default([]),
    /** Names of MCP servers (from the server's MCP registry) this vertical's agents get. */
    mcpServers: z.array(z.string()).default([]),
    schedules: z.array(Schedule).default([]),
    /** Per action type autonomy. Anything unlisted uses `defaultPolicy`. */
    policies: z.record(z.string(), Policy).default({}),
    defaultPolicy: Policy.default("draft"),
    /** Optional cap on this vertical's agent spend per day; over it, new tasks are deferred. */
    dailyBudgetUsd: z.number().positive().optional(),
    /** Display colour (CSS hex) for the Businesses page. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    /**
     * How the business's work is done (markdown): seeded once into the brain as
     * "<brainFolder>/how-we-work.md", which the assistant reads and Dave edits from then on.
     */
    guidance: z.string().default(""),
    /** The business's specialists (often none): the assistant hands them the work only they can do. */
    roles: z.array(Role).default([]),
  })
  .superRefine((v, ctx) => {
    for (const message of orgIssues(v)) ctx.addIssue({ code: "custom", message, path: ["roles"] });
  });
export type VerticalManifest = z.infer<typeof VerticalManifest>;
export type VerticalManifestInput = z.input<typeof VerticalManifest>;

export function defineVertical(input: VerticalManifestInput): VerticalManifest {
  return VerticalManifest.parse(input);
}

export function policyFor(vertical: VerticalManifest, actionType: string): Policy {
  return vertical.policies[actionType] ?? vertical.defaultPolicy;
}

/**
 * Every write to Odoo (an `odoo.*` action) waits for Dave's approval, whatever a business's
 * policies say: the agents read Odoo freely through the odoo MCP tools, and change it only
 * through proposals Dave approves.
 */
export const ODOO_WRITE_POLICY: Policy = "draft";

/** True for an action that writes to Odoo. */
export const isOdooWrite = (actionType: string) => actionType.startsWith("odoo.");

/**
 * The policy for one proposal: the vertical's (`policyFor`), except that an Odoo write is
 * always `draft` (ODOO_WRITE_POLICY), internal notes included.
 */
export function proposalPolicy(vertical: VerticalManifest, actionType: string, _payload: Record<string, unknown>): Policy {
  if (isOdooWrite(actionType)) return ODOO_WRITE_POLICY;
  return policyFor(vertical, actionType);
}

/**
 * Problems with a business's specialists, as messages (empty when valid): unique ids and aliases,
 * none named like the assistant, role MCP servers a subset of the business's, and schedule ids
 * unique across the business.
 */
export function orgIssues(v: Pick<VerticalManifest, "id" | "mcpServers" | "schedules" | "roles">): string[] {
  const issues: string[] = [];
  const roles = v.roles;
  const ids = new Map<string, Role>();
  for (const r of roles) {
    if (r.id === ROOT_ROLE_ID) issues.push(`${v.id}: role id "${ROOT_ROLE_ID}" is reserved for the org root`);
    if (ids.has(r.id)) issues.push(`${v.id}: duplicate role id "${r.id}"`);
    ids.set(r.id, r);
  }
  const names = new Set(ids.keys());
  for (const r of roles) {
    for (const a of r.aliases) {
      if (names.has(a) || a === ROOT_ROLE_ID) issues.push(`${v.id}: alias "${a}" of ${r.id} clashes with another role name`);
      names.add(a);
    }
  }
  for (const r of roles) {
    for (const srv of r.mcpServers ?? []) {
      if (!v.mcpServers.includes(srv)) issues.push(`${v.id}: ${r.id} lists MCP server "${srv}", which the vertical does not have`);
    }
  }
  const scheduleIds = new Set<string>();
  for (const s of [...v.schedules, ...roles.flatMap((r) => r.schedules)]) {
    if (scheduleIds.has(s.id)) issues.push(`${v.id}: duplicate schedule id "${s.id}"`);
    scheduleIds.add(s.id);
  }
  return issues;
}

/** A business's specialists. */
export function rolesOf(v: VerticalManifest): Role[] {
  return v.roles;
}

const nameKey = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A specialist by id, alias or title ("Video Producer" matches video-producer), case-insensitive. */
export function findRole(v: VerticalManifest, name: string): Role | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return rolesOf(v).find((r) => r.id === key || r.aliases.includes(key) || nameKey(r.title) === key);
}


/** MCP servers a role's runs may use: its own list, or else the vertical's. */
export function roleMcpServers(v: VerticalManifest, role: Pick<Role, "mcpServers"> | undefined): string[] {
  return role?.mcpServers ?? v.mcpServers;
}

/** Every schedule of a vertical with the role it belongs to (none for vertical-level schedules). */
export function schedulesOf(v: VerticalManifest): { schedule: Schedule; role?: string }[] {
  return [
    ...v.schedules.map((schedule) => ({ schedule })),
    ...v.roles.flatMap((r) => r.schedules.map((schedule) => ({ schedule, role: r.id }))),
  ];
}
