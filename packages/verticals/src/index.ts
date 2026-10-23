import { leadOf, type OrgRoot, ROOT_ROLE_ID, type Role, rolesOf, schedulesOf, type VerticalManifest } from "@cc/core";
import threeDPandMe from "./3dpandme";
import dms from "./dms";
import opend from "./opend";
import openv from "./openv";
import { chiefOfStaff } from "./org";
import personal from "./personal";

export { chiefOfStaff } from "./org";
export { parseRolePrefix, routeRole, type RoleRoute } from "./routing";

/** All verticals. To add one, create a manifest file and list it here. */
export const verticals: readonly VerticalManifest[] = [personal, dms, threeDPandMe, openv, opend];

/** Fallback vertical for events nothing else claims. */
export const DEFAULT_VERTICAL = "personal";

/** A role as the server uses it: a vertical role, or the org root (whose `reportsTo` is null). */
export type OrgRole = Omit<Role, "reportsTo"> & { reportsTo: string | null };

export class VerticalRegistry {
  private readonly byId: Map<string, VerticalManifest>;
  /** The Chief of Staff, as a role. */
  readonly root: OrgRole;
  /** Vertical the Chief of Staff's tasks run in. */
  readonly rootVertical: string;

  constructor(list: readonly VerticalManifest[] = verticals, root: OrgRoot = chiefOfStaff) {
    this.byId = new Map();
    for (const v of list) {
      if (this.byId.has(v.id)) throw new Error(`Duplicate vertical id: ${v.id}`);
      this.byId.set(v.id, v);
    }
    const { homeVertical, ...rest } = root;
    this.root = { ...rest, reportsTo: null };
    // A registry built from a subset (in tests) may lack the home vertical: use the first one.
    this.rootVertical = this.byId.has(homeVertical) ? homeVertical : (list[0]?.id ?? homeVertical);
    const home = this.byId.get(this.rootVertical);
    for (const s of root.mcpServers ?? []) {
      if (home && !home.mcpServers.includes(s)) throw new Error(`${ROOT_ROLE_ID} lists MCP server "${s}", which ${home.id} does not have`);
    }
    // Root schedules fire in the home vertical, so their ids share its namespace (and dedupe keys).
    const homeSchedules = new Set(home ? schedulesOf(home).map((s) => s.schedule.id) : []);
    for (const s of root.schedules) {
      if (homeSchedules.has(s.id)) throw new Error(`${ROOT_ROLE_ID} schedule "${s.id}" clashes with a ${home!.id} schedule`);
    }
  }

  all(): VerticalManifest[] {
    return [...this.byId.values()];
  }

  get(id: string): VerticalManifest | undefined {
    return this.byId.get(id);
  }

  require(id: string): VerticalManifest {
    const v = this.byId.get(id);
    if (!v) throw new Error(`Unknown vertical: ${id}`);
    return v;
  }

  /** A vertical's roles, lead first; in the root's vertical the Chief of Staff comes before them. */
  roles(verticalId: string): OrgRole[] {
    const v = this.byId.get(verticalId);
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
    const v = this.byId.get(verticalId);
    if (!v) return [];
    return this.roleFor(verticalId, roleId).mcpServers ?? v.mcpServers;
  }
}
