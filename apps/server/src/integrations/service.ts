import type { Config } from "../config";
import { CATALOG, DEFAULT_ID, GROUPS, type Group, KINDS, type KindDef, RAILWAY_ONLY } from "./catalog";
import { applyEntries, type EntryError, type EntryInput, fingerprint, railwayEntries, validateFields } from "./effective";
import { mask } from "./secrets";
import type { Entry, EntryMeta, IntegrationStore } from "./store";

/**
 * Rebuilds the integrations of the given groups from `config` and returns an error message per
 * group that failed (the old instance stays in use for those). Wired in app.ts.
 */
export type Reloader = (config: Config, groups: Group[]) => Promise<Partial<Record<Group, string>>>;

/**
 * Checks an entry's credentials against the real service. Registered per kind in tests.ts.
 * `app(kind)` gives a developer-app entry's values (e.g. the X consumer keys), or undefined.
 */
export type CredentialTest = (
  entry: EntryInput,
  config: Config,
  ctx: { app: (kind: string) => Promise<Record<string, string> | undefined> },
) => Promise<{ ok: boolean; message: string; account?: string }>;

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

export interface SavePatch {
  /** Non-secret fields to set; null removes one. */
  data?: Record<string, unknown>;
  /** Secret fields: a value replaces, "" or absent keeps what's stored, null clears it. */
  secrets?: Record<string, string | null>;
}

export interface EntryView {
  kind: string;
  id: string;
  source: "app" | "railway";
  data: Record<string, unknown>;
  /** Masked: "••••1234", or null when unset. */
  secrets: Record<string, string | null>;
  meta: EntryMeta;
  /** Why this entry isn't in use (invalid, not connected, unreadable). */
  error?: string;
  updatedAt?: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
/** Social accounts share one id space (executors and inbound checkpoints key on the id alone). */
const SOCIAL_KINDS = new Set(["discord", "instagram", "threads", "x", "reddit", "reddit-session", "reddit-browser", "youtube"]);
/** Mailboxes share one id space too (the poller's checkpoints and email actions key on it). */
const MAIL_KINDS = new Set(["email", "outlook", "gmail"]);

export class IntegrationService {
  private effective: Config;
  private errors: EntryError[] = [];
  private groupErrors: Partial<Record<Group, string>> = {};
  private reloader: Reloader = async () => ({});
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: IntegrationStore,
    private readonly base: Config,
    private readonly options: {
      verticals: () => string[];
      tests?: Record<string, CredentialTest>;
      /** Server-side rules applyEntries can't see (e.g. a platform adapter's credential format); a message means unusable. */
      check?: (config: Config, entry: EntryInput) => string | undefined;
    } = { verticals: () => [] },
  ) {
    this.effective = base;
  }

  setReloader(reloader: Reloader): void {
    this.reloader = reloader;
  }

  /** Called after a change has been applied (for the live feed). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The config in use: Railway's, with the Accounts page's entries applied. */
  current(): Config {
    return this.effective;
  }

  /** At start-up: apply saved entries over the env config the server was built from. */
  async load(): Promise<void> {
    await this.serial(() => this.recompute(this.base));
  }

  async list() {
    const stored = await this.store.list();
    const app = new Set(stored.map((e) => `${e.kind}/${e.id}`));
    const appKinds = new Set(stored.map((e) => e.kind));
    const errorOf = (kind: string, id: string) => this.errors.find((e) => e.kind === kind && e.id === id)?.message;
    const entries: EntryView[] = [
      ...stored.map((e) => this.view(e, "app", e.unreadable ? "Stored secrets can't be decrypted; enter them again" : errorOf(e.kind, e.id))),
      ...railwayEntries(this.base)
        .filter((e) => !app.has(`${e.kind}/${e.id}`) && !(KINDS.get(e.kind)?.multi === false && appKinds.has(e.kind)))
        .map((e) => this.view({ ...e, meta: {} }, "railway")),
    ];
    const verticals = this.options.verticals();
    return {
      kinds: CATALOG.map((k) => ({
        ...k,
        fields: k.fields.map((f) => (f.key === "vertical" ? { ...f, options: verticals } : f)),
        testable: !!this.options.tests?.[k.kind],
      })),
      entries,
      railwayOnly: RAILWAY_ONLY.map((r) => ({ ...r, set: !!process.env[r.name]?.trim() })),
      groups: Object.fromEntries(GROUPS.map((g) => [g, this.groupErrors[g] ?? null])) as Record<Group, string | null>,
      publicBaseUrl: this.base.publicBaseUrl ?? null,
    };
  }

  /** Creates or updates an entry, then reloads what it affects. Invalid input saves nothing. */
  /** `ifUpdatedAt`: only if the stored entry hasn't changed since (the refresh job vs a reconnect). */
  async save(kind: string, id: string, patch: SavePatch, actor: string, meta?: Partial<EntryMeta>, options: { ifUpdatedAt?: Date } = {}) {
    const def = this.def(kind);
    const entryId = this.checkId(def, id);
    return this.serial(async () => {
      await this.checkSocialId(kind, entryId);
      if (options.ifUpdatedAt) {
        const stored = await this.store.get(kind, entryId);
        if (stored?.updatedAt.getTime() !== options.ifUpdatedAt.getTime()) throw new IntegrationError(`${def.label} ${entryId} changed meanwhile`, 409);
      }
      const existing = await this.current_(def, entryId);
      const data = { ...existing.data };
      for (const [k, v] of Object.entries(patch.data ?? {})) {
        if (!def.fields.some((f) => f.key === k && f.type !== "secret")) throw new IntegrationError(`${def.label} has no field ${k}`);
        if (v === null) delete data[k];
        else data[k] = v;
      }
      const secrets = { ...existing.secrets };
      for (const [k, v] of Object.entries(patch.secrets ?? {})) {
        // Secrets moved in from Railway may carry extra keys (e.g. a Reddit password); allow those to be kept, not set.
        if (!def.fields.some((f) => f.key === k && f.type === "secret")) throw new IntegrationError(`${def.label} has no secret ${k}`);
        if (v === null) delete secrets[k];
        // Pasted keys often carry a stray space or newline, which the provider then rejects.
        else if (v.trim() !== "") secrets[k] = v.trim();
      }
      const problems = validateFields(def, data, secrets);
      const vertical = data.vertical;
      if (vertical !== undefined && !this.options.verticals().includes(String(vertical))) problems.push(`Business "${String(vertical)}" doesn't exist`);
      if (Array.isArray(data.alsoVerticals)) {
        for (const v of data.alsoVerticals) if (!this.options.verticals().includes(String(v))) problems.push(`Business "${String(v)}" doesn't exist (the ids are: ${this.options.verticals().join(", ")})`);
      }
      if (problems.length) throw new IntegrationError(problems.join("; "), 400, problems);

      // Would it make a working account? Check before saving.
      const candidate: EntryInput = { kind, id: entryId, data, secrets };
      const others = (await this.inputs()).filter((e) => !(e.kind === kind && e.id === entryId));
      const trialRun = applyEntries(this.base, [...others, candidate]);
      const trial = trialRun.errors.find((e) => e.kind === kind && e.id === entryId)?.message ?? this.options.check?.(trialRun.config, candidate);
      if (trial && !(def.oauth && !Object.keys(secrets).length)) throw new IntegrationError(trial);

      await this.store.put({ kind, id: entryId, data, secrets, meta: { ...existing.meta, ...meta } }, actor, existing.stored ? "updated" : existing.fromRailway ? "moved from Railway" : "created");
      return this.recompute(this.effective, def.affects);
    });
  }

  /** Copies a Railway (env) entry into the app so it can be edited here; the env var can then be deleted. */
  async importFromRailway(kind: string, id: string, actor: string) {
    const def = this.def(kind);
    return this.serial(async () => {
      const env = railwayEntries(this.base).find((e) => e.kind === kind && e.id === id);
      if (!env) throw new IntegrationError(`${def.label} ${id} isn't set in Railway`, 404);
      if (await this.store.get(kind, id)) throw new IntegrationError(`${def.label} ${id} is already in the app`, 409);
      await this.checkSocialId(kind, id);
      await this.store.put({ ...env, meta: {} }, actor, "moved from Railway");
      return this.recompute(this.effective, def.affects);
    });
  }

  async remove(kind: string, id: string, actor: string) {
    const def = this.def(kind);
    return this.serial(async () => {
      if (!(await this.store.remove(kind, id, actor))) throw new IntegrationError(`${def.label} ${id} isn't saved in the app`, 404);
      return this.recompute(this.effective, def.affects);
    });
  }

  async test(kind: string, id: string) {
    const def = this.def(kind);
    const run = this.options.tests?.[kind];
    if (!run) throw new IntegrationError(`${def.label} has no connection test`, 404);
    const stored = await this.store.get(kind, id);
    const entry: EntryInput | undefined = stored ?? railwayEntries(this.base).find((e) => e.kind === kind && e.id === id);
    if (!entry) throw new IntegrationError(`${def.label} ${id} isn't set up`, 404);
    let result: { ok: boolean; message: string; account?: string };
    try {
      result = await run(entry, this.effective, { app: (k) => this.appValues(k) });
    } catch (err) {
      result = { ok: false, message: (err as Error).message };
    }
    result.message = result.message.slice(0, 300);
    if (stored) await this.store.patchMeta(kind, id, { lastTest: { at: new Date().toISOString(), ok: result.ok, message: result.message }, ...(result.account ? { account: result.account } : {}) });
    return result;
  }

  /** The stored entry (secrets decrypted) for server-side use, e.g. by the token refresh job. */
  async entry(kind: string, id: string): Promise<Entry | null> {
    return this.store.get(kind, id);
  }

  /** The entry as in use: the readable stored one, else the Railway (env) one. */
  async resolved(kind: string, id: string = DEFAULT_ID): Promise<EntryInput | null> {
    const stored = await this.store.get(kind, id);
    if (stored && !stored.unreadable) return stored;
    return railwayEntries(this.base).find((e) => e.kind === kind && e.id === id) ?? null;
  }

  /** A single-entry kind's field values (data and secrets, trimmed, non-empty), e.g. a developer app's keys. */
  async appValues(kind: string): Promise<Record<string, string> | undefined> {
    const e = await this.resolved(kind);
    if (!e) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...e.data, ...e.secrets })) if (typeof v === "string" && v.trim()) out[k] = v.trim();
    return out;
  }

  async entries(kind?: string): Promise<Entry[]> {
    const all = await this.store.list();
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  /**
   * A provider rotated a token (Microsoft does on every refresh): store the new one without a
   * reload or an audit row, and update the config in use so the next change doesn't see a
   * difference and restart the integration for nothing.
   */
  async rotateSecret(kind: string, id: string, key: string, value: string): Promise<void> {
    await this.serial(async () => {
      const stored = await this.store.get(kind, id);
      if (!stored || stored.unreadable || stored.secrets[key] === value) return;
      await this.store.putQuietly({ ...stored, secrets: { ...stored.secrets, [key]: value } });
      if (kind === "outlook" && key === "refreshToken") {
        const accounts = this.effective.email.accounts.map((a) => (a.id === id && a.oauth ? { ...a, oauth: { ...a.oauth, refreshToken: value } } : a));
        this.effective = { ...this.effective, email: { ...this.effective.email, accounts } };
      }
      if (kind === "opengym" && key === "token") {
        const accounts = this.effective.gym.accounts.map((a) => (a.id === id ? { ...a, token: value } : a));
        this.effective = { ...this.effective, gym: { ...this.effective.gym, accounts } };
      }
    });
  }

  /** Records status (expiry, account name) without a reload. */
  async patchMeta(kind: string, id: string, meta: Partial<EntryMeta>): Promise<void> {
    await this.store.patchMeta(kind, id, meta);
  }

  /** The stored entry, else the Railway one being edited for the first time, else a new one. */
  private async current_(def: KindDef, id: string) {
    const stored = await this.store.get(def.kind, id);
    if (stored) {
      if (stored.unreadable) return { data: stored.data, secrets: {}, meta: stored.meta, stored: true, fromRailway: false };
      return { data: stored.data, secrets: stored.secrets, meta: stored.meta, stored: true, fromRailway: false };
    }
    const env = railwayEntries(this.base).find((e) => e.kind === def.kind && e.id === id);
    if (env) return { data: env.data, secrets: env.secrets, meta: {} as EntryMeta, stored: false, fromRailway: true };
    const defaults = Object.fromEntries(def.fields.filter((f) => f.default !== undefined && f.type !== "secret").map((f) => [f.key, f.default]));
    return { data: defaults, secrets: {} as Record<string, string>, meta: {} as EntryMeta, stored: false, fromRailway: false };
  }

  private async inputs(): Promise<EntryInput[]> {
    return (await this.store.list()).filter((e) => !e.unreadable);
  }

  /** Recomputes the effective config and reloads the groups whose section changed. */
  private async recompute(previous: Config, hint: readonly Group[] = GROUPS) {
    const { config, errors } = applyEntries(this.base, await this.inputs());
    const changed = GROUPS.filter((g) => fingerprint(previous, g) !== fingerprint(config, g));
    const inputs = await this.inputs();
    for (const e of inputs) {
      if (errors.some((x) => x.kind === e.kind && x.id === e.id)) continue;
      const message = this.options.check?.(config, e);
      if (message) errors.push({ kind: e.kind, id: e.id, message });
    }
    this.errors = errors;
    let failed: Partial<Record<Group, string>> = {};
    if (changed.length) {
      failed = await this.reloader(config, changed);
      // A group that failed keeps its old instance, so keep its old config section too.
      this.effective = mergeFailed(config, previous, failed);
    }
    // An unchanged group already runs what's saved (e.g. the entry that failed was removed), so its error is stale.
    for (const g of GROUPS) {
      if (failed[g]) this.groupErrors[g] = failed[g];
      else delete this.groupErrors[g];
    }
    for (const l of this.listeners) l();
    return { reloaded: changed.filter((g) => !failed[g]), failed, considered: hint };
  }

  private view(e: EntryInput & { meta: EntryMeta; updatedAt?: Date }, source: "app" | "railway", error?: string): EntryView {
    const def = KINDS.get(e.kind);
    const secretKeys = new Set([...(def?.fields.filter((f) => f.type === "secret").map((f) => f.key) ?? []), ...Object.keys(e.secrets)]);
    return {
      kind: e.kind,
      id: e.id,
      source,
      data: e.data,
      secrets: Object.fromEntries([...secretKeys].map((k) => [k, mask(e.secrets[k])])),
      meta: e.meta,
      ...(error ? { error } : {}),
      ...(e.updatedAt ? { updatedAt: e.updatedAt.toISOString() } : {}),
    };
  }

  private def(kind: string): KindDef {
    const def = KINDS.get(kind);
    if (!def) throw new IntegrationError(`unknown account type ${kind}`, 404);
    return def;
  }

  private checkId(def: KindDef, id: string): string {
    if (!def.multi) {
      if (id && id !== DEFAULT_ID) throw new IntegrationError(`${def.label} has a single entry (id "default")`);
      return DEFAULT_ID;
    }
    if (!ID.test(id)) throw new IntegrationError("Name must be letters, digits, - or _ (e.g. dms-instagram)");
    return id;
  }

  private async checkSocialId(kind: string, id: string): Promise<void> {
    const family = SOCIAL_KINDS.has(kind) ? SOCIAL_KINDS : MAIL_KINDS.has(kind) ? MAIL_KINDS : null;
    if (!family) return;
    const taken = [...(await this.store.list()), ...railwayEntries(this.base)].find((e) => e.id === id && e.kind !== kind && family.has(e.kind));
    if (taken) throw new IntegrationError(`The name "${id}" is already used by a ${KINDS.get(taken.kind)?.label ?? taken.kind} account; pick another`, 409);
  }

  /** One change at a time, so two saves can't reload over each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

/** The new config, except failed groups keep their previous section. */
function mergeFailed(next: Config, prev: Config, failed: Partial<Record<Group, string>>): Config {
  const out = { ...next };
  if (failed.runner) {
    const { runner, oauthToken, fallbackApiKey, route, codexAuth, codexModel } = prev.agent;
    out.agent = { ...out.agent, runner, oauthToken, fallbackApiKey, route, codexAuth, codexModel };
  }
  if (failed.triage) out.triage = prev.triage;
  if (failed.voice) out.voice = { ...out.voice, providers: prev.voice.providers };
  if (failed.odoo) Object.assign(out, { odoo: prev.odoo, odooEvents: prev.odooEvents });
  if (failed.shipping) out.shipping = prev.shipping;
  if (failed.email) out.email = { ...out.email, accounts: prev.email.accounts };
  if (failed.social) out.social = { ...out.social, accounts: prev.social.accounts };
  if (failed.calendar) out.pa = { ...out.pa, calendarAccounts: prev.pa.calendarAccounts };
  if (failed.storage) out.storage = prev.storage;
  return out;
}
