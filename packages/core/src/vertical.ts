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

/** Id of the org root, the cross-vertical Chief of Staff every vertical lead reports to. */
export const ROOT_ROLE_ID = "chief-of-staff";

const slug = z.string().regex(/^[a-z0-9-]+$/);

/**
 * One agent role in a vertical's org chart: the lead (reporting to the Chief of
 * Staff) or a specialist under it. A role decides which tasks a run takes (its
 * intents), what the run sees (skills, MCP servers) and how it behaves (mission
 * and autonomy notes, carried into the system prompt). See docs/ORG.md.
 */
export const Role = z.object({
  id: slug,
  title: z.string().min(1),
  /** Two or three sentences: what the role is for and what good looks like. */
  mission: z.string().min(1),
  /** Id of the role this one reports to, or ROOT_ROLE_ID for the vertical lead. */
  reportsTo: z.string().min(1),
  /** Extra names Dave can address the role by in chat ("support: ..."). */
  aliases: z.array(slug).default([]),
  /** Triage intents this role owns. Intents no role owns go to the vertical lead. */
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
  /** GitHub repository ("owner/name") checked out for each of the role's tasks, in its workspace (needs GITHUB_TOKEN). */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name")
    .optional(),
  /** Schedules whose tasks go to this role. Ids are unique across the whole vertical. */
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
    /** Display colour (CSS hex) for the org chart. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    /**
     * The vertical's org chart: exactly one lead (reportsTo ROOT_ROLE_ID) and the
     * roles under it. Empty: one implicit lead with the vertical's skills and servers.
     */
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
 * Problems with a vertical's org chart, as messages (empty when valid): unique
 * ids and aliases, exactly one lead, `reportsTo` naming a role of the vertical
 * (or the root, for the lead), no cycles, role intents declared by the vertical
 * and each owned by at most one role (unowned ones fall to the lead), role MCP
 * servers a subset of the vertical's, and schedule ids unique across the vertical.
 */
export function orgIssues(v: Pick<VerticalManifest, "id" | "intents" | "mcpServers" | "schedules" | "roles">): string[] {
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
  if (roles.length) {
    const leads = roles.filter((r) => r.reportsTo === ROOT_ROLE_ID);
    if (leads.length !== 1) issues.push(`${v.id}: needs exactly one lead reporting to ${ROOT_ROLE_ID}, found ${leads.length}`);
  }
  for (const r of roles) {
    if (r.reportsTo === r.id) issues.push(`${v.id}: ${r.id} reports to itself`);
    else if (r.reportsTo !== ROOT_ROLE_ID && !ids.has(r.reportsTo)) issues.push(`${v.id}: ${r.id} reports to unknown role "${r.reportsTo}"`);
  }
  // Follow each role's reporting line: one that comes back to a role it passed never reaches the root.
  const reported = new Set<string>();
  for (const r of roles) {
    const seen: string[] = [];
    let at: Role | undefined = r;
    while (at && at.reportsTo !== ROOT_ROLE_ID && at.reportsTo !== at.id) {
      if (seen.includes(at.id)) {
        const cycle = seen.slice(seen.indexOf(at.id));
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) issues.push(`${v.id}: reporting cycle ${[...cycle, at.id].join(" -> ")}`);
        reported.add(key);
        break;
      }
      seen.push(at.id);
      at = ids.get(at.reportsTo);
    }
  }
  const declared = new Set([...v.intents, "other"]);
  const owner = new Map<string, string>();
  for (const r of roles) {
    for (const intent of r.intents) {
      if (!declared.has(intent)) issues.push(`${v.id}: ${r.id} owns intent "${intent}", which the vertical does not declare`);
      const prev = owner.get(intent);
      if (prev && prev !== r.id) issues.push(`${v.id}: intent "${intent}" is owned by both ${prev} and ${r.id}`);
      owner.set(intent, r.id);
    }
    for (const s of r.mcpServers ?? []) {
      if (!v.mcpServers.includes(s)) issues.push(`${v.id}: ${r.id} lists MCP server "${s}", which the vertical does not have`);
    }
  }
  const scheduleIds = new Set<string>();
  for (const s of [...v.schedules, ...roles.flatMap((r) => r.schedules)]) {
    if (scheduleIds.has(s.id)) issues.push(`${v.id}: duplicate schedule id "${s.id}"`);
    scheduleIds.add(s.id);
  }
  return issues;
}

/** The role a vertical without an org chart runs as: one lead with the vertical's skills and servers. */
export function implicitLead(v: VerticalManifest): Role {
  return {
    id: "lead",
    title: `${v.name} Lead`,
    mission: `Handles everything for ${v.name}. ${v.description}`,
    reportsTo: ROOT_ROLE_ID,
    aliases: [],
    intents: [],
    skills: v.skills,
    tools: [],
    actions: [],
    schedules: [],
    kpis: [],
    autonomyNotes: "Follows the vertical's action policies; anything outward-facing is a proposal.",
  };
}

/** A vertical's roles, lead first. A vertical with no org chart has just its implicit lead. */
export function rolesOf(v: VerticalManifest): Role[] {
  if (!v.roles.length) return [implicitLead(v)];
  const lead = v.roles.find((r) => r.reportsTo === ROOT_ROLE_ID)!;
  return [lead, ...v.roles.filter((r) => r !== lead)];
}

export function leadOf(v: VerticalManifest): Role {
  return rolesOf(v)[0]!;
}

const nameKey = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A role by id, alias or title ("Customer Support" matches customer-support), case-insensitive. */
export function findRole(v: VerticalManifest, name: string): Role | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return rolesOf(v).find((r) => r.id === key || r.aliases.includes(key) || nameKey(r.title) === key);
}

/** The role owning a triage intent, otherwise the lead. */
export function roleForIntent(v: VerticalManifest, intent: string): Role {
  return rolesOf(v).find((r) => r.intents.includes(intent)) ?? leadOf(v);
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
