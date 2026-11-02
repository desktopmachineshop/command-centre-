import {
  leadOf,
  OrgRoot,
  ROOT_ROLE_ID,
  type Role,
  type RootOrgEdit,
  rolesOf,
  schedulesOf,
  VerticalManifest,
  type VerticalOrgEdit,
} from "@cc/core";
import threeDPandMe from "./3dpandme";
import commandCentre from "./command-centre";
import dms from "./dms";
import opend from "./opend";
import openv from "./openv";
import { chiefOfStaff } from "./org";
import personal from "./personal";

export { chiefOfStaff } from "./org";
export { parseRolePrefix, routeRole, type RoleRoute } from "./routing";

/** All verticals. To add one, create a manifest file and list it here. */
export const verticals: readonly VerticalManifest[] = [personal, dms, threeDPandMe, openv, opend, commandCentre];

/** Fallback vertical for events nothing else claims. */
export const DEFAULT_VERTICAL = "personal";

/** A role as the server uses it: a vertical role, or the org root (whose `reportsTo` is null). */
export type OrgRole = Omit<Role, "reportsTo"> & { reportsTo: string | null };

/** Org changes saved from the app, over the code manifests: per vertical, and for the Chief of Staff. */
export interface OrgOverrides {
  verticals?: Record<string, VerticalOrgEdit>;
  root?: RootOrgEdit;
}

/** An org that fails its checks; `issues` lists every problem, one line each. */
export class OrgError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "OrgError";
  }
}

type State = { byId: Map<string, VerticalManifest>; root: OrgRole; rootVertical: string };

/** One line per zod issue under `scope` (a vertical id), naming a role by its id rather than its index. */
export function issueLines(scope: string, error: { issues: { code: string; message: string; path: PropertyKey[] }[] }, input: { roles?: { id?: string }[] }): string[] {
  return error.issues.map((i) => {
    if (i.code === "custom" && i.message.startsWith(`${scope}: `)) return i.message;
    const [head, index, ...rest] = i.path.map(String);
    const where =
      head === "roles" && index !== undefined
        ? [`role "${input.roles?.[Number(index)]?.id ?? Number(index) + 1}"`, ...rest]
        : [head, index, ...rest].filter((p) => p !== undefined);
    return `${scope}: ${where.length ? `${where.join(" ")}: ` : ""}${i.message}`;
  });
}

function build(list: readonly VerticalManifest[], root: OrgRoot): State {
  const byId = new Map<string, VerticalManifest>();
  for (const v of list) {
    if (byId.has(v.id)) throw new Error(`Duplicate vertical id: ${v.id}`);
    byId.set(v.id, v);
  }
  const { homeVertical, ...rest } = root;
  // A registry built from a subset (in tests) may lack the home vertical: use the first one.
  const rootVertical = byId.has(homeVertical) ? homeVertical : (list[0]?.id ?? homeVertical);
  const home = byId.get(rootVertical);
  for (const s of root.mcpServers ?? []) {
    if (home && !home.mcpServers.includes(s)) throw new Error(`${ROOT_ROLE_ID} lists MCP server "${s}", which ${home.id} does not have`);
  }
  // Root schedules fire in the home vertical, so their ids share its namespace (and dedupe keys).
  const homeSchedules = new Set(home ? schedulesOf(home).map((s) => s.schedule.id) : []);
  for (const s of root.schedules) {
    if (homeSchedules.has(s.id)) throw new Error(`${ROOT_ROLE_ID} schedule "${s.id}" clashes with a ${home!.id} schedule`);
  }
  return { byId, root: { ...rest, reportsTo: null }, rootVertical };
}

/**
 * The verticals and the org as the server runs them: the code manifests, with any
 * org changes saved from the app applied over them (`apply`). Everything holding the
 * registry reads it per call, so an applied change reaches the next task at once.
 */
export class VerticalRegistry {
  private state: State;
  private readonly baseById: Map<string, VerticalManifest>;

  constructor(
    list: readonly VerticalManifest[] = verticals,
    /** The Chief of Staff as the code defines it. */
    readonly baseRoot: OrgRoot = chiefOfStaff,
  ) {
    this.state = build(list, baseRoot);
    this.baseById = this.state.byId;
  }

  /** The Chief of Staff, as a role. */
  get root(): OrgRole {
    return this.state.root;
  }

  /** Vertical the Chief of Staff's tasks run in. */
  get rootVertical(): string {
    return this.state.rootVertical;
  }

  /** A vertical as its code manifest defines it, before any change from the app. */
  base(id: string): VerticalManifest | undefined {
    return this.baseById.get(id);
  }

  /** Throws an OrgError listing every problem if `overrides` over the code manifests is not a valid org. */
  check(overrides: OrgOverrides): void {
    this.resolve(overrides);
  }

  /** Runs `overrides` over the code manifests from now on (replacing any earlier ones), or throws an OrgError and keeps the current org. */
  apply(overrides: OrgOverrides): void {
    this.state = this.resolve(overrides);
  }

  private resolve(overrides: OrgOverrides): State {
    const issues: string[] = [];
    const list = [...this.baseById.values()].map((v) => {
      const edit = overrides.verticals?.[v.id];
      if (!edit) return v;
      const input = { ...v, ...edit };
      const parsed = VerticalManifest.safeParse(input);
      if (parsed.success) return parsed.data;
      issues.push(...issueLines(v.id, parsed.error, input));
      return v;
    });
    for (const id of Object.keys(overrides.verticals ?? {})) {
      if (!this.baseById.has(id)) issues.push(`${id}: no such vertical`);
    }
    let root = this.baseRoot;
    if (overrides.root) {
      const parsed = OrgRoot.safeParse({ ...overrides.root, id: ROOT_ROLE_ID, homeVertical: this.baseRoot.homeVertical });
      if (parsed.success) root = parsed.data;
      else issues.push(...issueLines(ROOT_ROLE_ID, parsed.error, {}));
    }
    if (issues.length) throw new OrgError(issues);
    try {
      return build(list, root);
    } catch (err) {
      throw new OrgError([(err as Error).message]);
    }
  }

  all(): VerticalManifest[] {
    return [...this.state.byId.values()];
  }

  get(id: string): VerticalManifest | undefined {
    return this.state.byId.get(id);
  }

  require(id: string): VerticalManifest {
    const v = this.state.byId.get(id);
    if (!v) throw new Error(`Unknown vertical: ${id}`);
    return v;
  }

  /** A vertical's roles, lead first; in the root's vertical the Chief of Staff comes before them. */
  roles(verticalId: string): OrgRole[] {
    const v = this.state.byId.get(verticalId);
    if (!v) return [];
    return verticalId === this.rootVertical ? [this.root, ...rolesOf(v)] : rolesOf(v);
  }

  /** The role a task in `verticalId` runs as. Unknown or unset role ids get the vertical lead. */
  roleFor(verticalId: string, roleId: string | null | undefined): OrgRole {
    const v = this.require(verticalId);
    if (roleId === ROOT_ROLE_ID && verticalId === this.rootVertical) return this.root;
    return rolesOf(v).find((r) => r.id === roleId) ?? leadOf(v);
  }

  /** MCP servers a role's runs may use: the role's list, or the vertical's. */
  mcpServersFor(verticalId: string, roleId: string | null | undefined): string[] {
    const v = this.state.byId.get(verticalId);
    if (!v) return [];
    return this.roleFor(verticalId, roleId).mcpServers ?? v.mcpServers;
  }
}
