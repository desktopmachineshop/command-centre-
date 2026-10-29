import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OrgConfig,
  type OrgConfigUnit,
  type OrgConfigVersion,
  type OrgRoot,
  ROOT_ROLE_ID,
  RootOrgEdit,
  type VerticalManifest,
  VerticalOrgEdit,
} from "@cc/core";
import { issueLines, OrgError, type OrgOverrides, type VerticalRegistry } from "@cc/verticals";
import type { Pool } from "./db/pool";

/** A save over a version that is no longer the latest (someone else saved first). */
export class OrgConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`The org changed since you opened it (now version ${currentVersion}). Reload and try again.`);
    this.name = "OrgConflictError";
  }
}

type Saved = { data: unknown; version: number; updatedBy: string; updatedAt: string };

const verticalEdit = (v: VerticalManifest): VerticalOrgEdit => ({ roles: v.roles, policies: v.policies, defaultPolicy: v.defaultPolicy });
const rootEdit = ({ id: _id, homeVertical: _home, ...rest }: OrgRoot): RootOrgEdit => rest;

/**
 * Org changes made on the Org page: roles (hierarchy, missions, autonomy, intents,
 * skills, servers, schedules) and action policies, one stored document per vertical
 * plus one for the Chief of Staff. Each is checked as a whole org before it is saved,
 * then applied to the registry at once. Every save and reset is kept as a version.
 */
export class OrgConfigService {
  private saved = new Map<string, Saved>();
  private versions = new Map<string, number>();
  private problems = new Map<string, string>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly registry: VerticalRegistry,
    private readonly options: { skillsDir: string; actionTypes: () => string[] },
  ) {}

  /** Called after every change that reached the registry (to restart schedules, tell the app). */
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  /**
   * Loads the saved changes and applies them. One that no longer fits the code (a role
   * whose intent the code removed, say) is left out and reported, so the rest still run.
   */
  async load(): Promise<void> {
    const { rows } = await this.pool.query("select unit, data, version, updated_by, updated_at from org_overrides order by unit");
    const latest = await this.pool.query("select unit, max(version)::int as version from org_override_versions group by unit");
    this.versions = new Map(latest.rows.map((r) => [r.unit as string, r.version as number]));
    this.saved = new Map(rows.map((r) => [r.unit as string, { data: r.data, version: r.version, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() }]));
    this.problems.clear();
    let good: OrgOverrides = {};
    for (const [unit, s] of this.saved) {
      try {
        const next = this.with(good, unit, s.data);
        this.registry.check(next);
        good = next;
      } catch (err) {
        const message = err instanceof OrgError ? err.message : (err as Error).message;
        this.problems.set(unit, message);
        console.warn(`[org] saved change for ${unit} is not applied: ${message}`);
      }
    }
    this.registry.apply(good);
  }

  /** Everything the Org page's editor needs. */
  async config(): Promise<OrgConfig> {
    const meta = (unit: string) => {
      const s = this.saved.get(unit);
      return {
        unit,
        overridden: !!s,
        version: this.versions.get(unit) ?? 0,
        updatedBy: s?.updatedBy ?? null,
        updatedAt: s?.updatedAt ?? null,
        problem: this.problems.get(unit) ?? null,
      };
    };
    const home = this.registry.require(this.registry.rootVertical);
    const baseRoot = rootEdit(this.registry.baseRoot);
    return {
      verticals: this.registry.all().map((v) => {
        const base = verticalEdit(this.registry.base(v.id) ?? v);
        const s = this.saved.get(v.id);
        const unit: OrgConfigUnit<VerticalOrgEdit> = { ...meta(v.id), base, current: s ? VerticalOrgEdit.catch(base).parse(s.data) : base };
        return { ...unit, name: v.name, color: v.color ?? null, intents: v.intents, mcpServers: v.mcpServers };
      }),
      root: {
        ...meta(ROOT_ROLE_ID),
        base: baseRoot,
        current: this.saved.has(ROOT_ROLE_ID) ? RootOrgEdit.catch(baseRoot).parse(this.saved.get(ROOT_ROLE_ID)!.data) : baseRoot,
        homeVertical: home.id,
        mcpServers: home.mcpServers,
      },
      skills: await this.skills(),
      actionTypes: [...this.options.actionTypes()].sort(),
    };
  }

  /** Saves a unit's change (`data` null resets it to the code), after checking the whole org with it. Throws OrgError or OrgConflictError. */
  async save(unit: string, data: unknown, options: { author: string; expectedVersion: number }): Promise<void> {
    const parsed = data === null ? null : this.parse(unit, data);
    if (parsed) await this.checkSkills(unit, parsed);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // One org-wide lock: the check below must see every other unit as it will be saved.
      await client.query("select pg_advisory_xact_lock(hashtext('org_overrides'))");
      const { rows } = await client.query("select coalesce(max(version), 0)::int as version from org_override_versions where unit = $1", [unit]);
      const current = rows[0].version as number;
      if (current !== options.expectedVersion) throw new OrgConflictError(current);
      const next = this.with(this.applied(), unit, parsed);
      this.registry.check(next);
      const version = current + 1;
      await client.query("insert into org_override_versions (unit, version, data, author) values ($1, $2, $3, $4)", [unit, version, parsed && JSON.stringify(parsed), options.author]);
      if (parsed) {
        await client.query(
          `insert into org_overrides (unit, data, version, updated_by) values ($1, $2, $3, $4)
           on conflict (unit) do update set data = excluded.data, version = excluded.version, updated_by = excluded.updated_by, updated_at = now()`,
          [unit, JSON.stringify(parsed), version, options.author],
        );
      } else {
        await client.query("delete from org_overrides where unit = $1", [unit]);
      }
      await client.query("commit");
      this.registry.apply(next);
      this.versions.set(unit, version);
      this.problems.delete(unit);
      if (parsed) this.saved.set(unit, { data: parsed, version, updatedBy: options.author, updatedAt: new Date().toISOString() });
      else this.saved.delete(unit);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    for (const fn of this.listeners) fn();
  }

  async history(unit: string): Promise<OrgConfigVersion[]> {
    const { rows } = await this.pool.query(
      "select version, author, data is null as reset, created_at from org_override_versions where unit = $1 order by version desc limit 100",
      [unit],
    );
    return rows.map((r) => ({ version: r.version, author: r.author, reset: r.reset, createdAt: new Date(r.created_at).toISOString() }));
  }

  /** A saved version's document, or null for a reset (the code's version then). Undefined when there is no such version. */
  async readVersion(unit: string, version: number): Promise<unknown | null | undefined> {
    const { rows } = await this.pool.query("select data from org_override_versions where unit = $1 and version = $2", [unit, version]);
    return rows.length ? rows[0].data : undefined;
  }

  /** Saves an earlier version again as the newest one. False when there is no such version. */
  async restore(unit: string, version: number, options: { author: string }): Promise<boolean> {
    const data = await this.readVersion(unit, version);
    if (data === undefined) return false;
    await this.save(unit, data, { author: options.author, expectedVersion: this.versions.get(unit) ?? 0 });
    return true;
  }

  private parse(unit: string, data: unknown): VerticalOrgEdit | RootOrgEdit {
    if (unit !== ROOT_ROLE_ID && !this.registry.get(unit)) throw new OrgError([`${unit}: no such vertical`]);
    const parsed = (unit === ROOT_ROLE_ID ? RootOrgEdit : VerticalOrgEdit).safeParse(data);
    if (!parsed.success) throw new OrgError(issueLines(unit, parsed.error, data as { roles?: { id?: string }[] }));
    return parsed.data;
  }

  /** The overrides running now: every saved change but the ones with a problem. */
  private applied(): OrgOverrides {
    let o: OrgOverrides = {};
    for (const [unit, s] of this.saved) if (!this.problems.has(unit)) o = this.with(o, unit, s.data);
    return o;
  }

  private with(o: OrgOverrides, unit: string, data: unknown | null): OrgOverrides {
    if (unit === ROOT_ROLE_ID) {
      const { root: _root, ...rest } = o;
      return data ? { ...rest, root: RootOrgEdit.parse(data) } : rest;
    }
    const { [unit]: _old, ...others } = o.verticals ?? {};
    return { ...o, verticals: data ? { ...others, [unit]: VerticalOrgEdit.parse(data) } : others };
  }

  /** Skills added from the app must be in the bank, or the role's workspace would silently lack them. The code's own are checked by its tests. */
  private async checkSkills(unit: string, data: VerticalOrgEdit | RootOrgEdit) {
    if (!existsSync(this.options.skillsDir)) return;
    const base = unit === ROOT_ROLE_ID ? this.registry.baseRoot.skills : (this.registry.base(unit)?.roles.flatMap((r) => r.skills) ?? []);
    const bank = new Set([...(await this.skills()).map((s) => s.name), ...base]);
    const roles = "roles" in data ? data.roles : [{ id: ROOT_ROLE_ID, skills: data.skills }];
    const issues = roles.flatMap((r) => r.skills.filter((s) => !bank.has(s)).map((s) => `${unit}: role "${r.id}" lists skill "${s}", which is not in the skills bank`));
    if (issues.length) throw new OrgError(issues);
  }

  private async skills(): Promise<{ name: string; description: string }[]> {
    const dir = this.options.skillsDir;
    if (!existsSync(dir)) return [];
    const out: { name: string; description: string }[] = [];
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = join(dir, d.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8");
      out.push({ name: d.name, description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "" });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
