import type pg from "pg";
import { type SecretBox, SecretsUnreadable } from "./secrets";

/** One saved integration: a catalogue kind plus an id (e.g. "odoo/default", "instagram/dms-instagram"). */
export interface Entry {
  kind: string;
  id: string;
  /** Non-secret fields. */
  data: Record<string, unknown>;
  /** Secret fields, decrypted. Empty when `unreadable`. */
  secrets: Record<string, string>;
  /** Server-kept status: lastTest, expiresAt, account name, error. */
  meta: EntryMeta;
  /** The secrets couldn't be decrypted; the entry needs entering again. */
  unreadable?: boolean;
  updatedAt: Date;
}

export interface EntryMeta {
  /** Who it is signed in as, e.g. "dave@gmail.com" or "@3dpandme". */
  account?: string;
  /** ISO time the token stops working (Meta long-lived tokens). */
  expiresAt?: string;
  lastTest?: { at: string; ok: boolean; message: string };
  [key: string]: unknown;
}

interface Row {
  kind: string;
  id: string;
  data: Record<string, unknown>;
  secrets_enc: string | null;
  meta: EntryMeta;
  updated_at: Date;
}

export class IntegrationStore {
  constructor(
    private readonly pool: pg.Pool,
    /** A getter: the key is loaded in start(), after the server object exists. */
    private readonly box: () => SecretBox,
  ) {}

  async list(): Promise<Entry[]> {
    const { rows } = await this.pool.query<Row>("select kind, id, data, secrets_enc, meta, updated_at from integration_entries order by kind, id");
    return rows.map((r) => this.decode(r));
  }

  async get(kind: string, id: string): Promise<Entry | null> {
    const { rows } = await this.pool.query<Row>("select kind, id, data, secrets_enc, meta, updated_at from integration_entries where kind = $1 and id = $2", [kind, id]);
    return rows[0] ? this.decode(rows[0]) : null;
  }

  async put(entry: { kind: string; id: string; data: Record<string, unknown>; secrets: Record<string, string>; meta?: EntryMeta }, actor: string, action = "saved"): Promise<void> {
    const secrets = Object.keys(entry.secrets).length ? this.box().seal(entry.secrets) : null;
    await this.pool.query(
      `insert into integration_entries (kind, id, data, secrets_enc, meta) values ($1, $2, $3, $4, $5)
       on conflict (kind, id) do update set data = excluded.data, secrets_enc = excluded.secrets_enc, meta = excluded.meta, updated_at = now()`,
      [entry.kind, entry.id, entry.data, secrets, entry.meta ?? {}],
    );
    await this.audit(actor, entry.kind, entry.id, action);
  }

  /** Merges into meta only (test results, expiry); no audit row. */
  async patchMeta(kind: string, id: string, meta: Partial<EntryMeta>): Promise<void> {
    await this.pool.query("update integration_entries set meta = meta || $3 where kind = $1 and id = $2", [kind, id, meta]);
  }

  async remove(kind: string, id: string, actor: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("delete from integration_entries where kind = $1 and id = $2", [kind, id]);
    if (rowCount) await this.audit(actor, kind, id, "removed");
    return !!rowCount;
  }

  async audit(actor: string, kind: string, id: string, action: string): Promise<void> {
    await this.pool.query("insert into integration_audit (actor, kind, entry_id, action) values ($1, $2, $3, $4)", [actor, kind, id, action]);
  }

  async recentAudit(limit = 20): Promise<{ at: Date; actor: string; kind: string; entryId: string; action: string }[]> {
    const { rows } = await this.pool.query("select at, actor, kind, entry_id as \"entryId\", action from integration_audit order by id desc limit $1", [limit]);
    return rows;
  }

  // --- OAuth state: single use, short-lived, bound to who started it ---
  async putState(state: { state: string; provider: string; actor: string; data: Record<string, unknown>; ttlSeconds?: number }): Promise<void> {
    await this.pool.query("delete from oauth_states where expires_at < now()");
    await this.pool.query("insert into oauth_states (state, provider, actor, data, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))", [
      state.state,
      state.provider,
      state.actor,
      state.data,
      state.ttlSeconds ?? 600,
    ]);
  }

  /** Deletes and returns the state if it exists, matches the provider and hasn't expired. */
  async takeState(state: string, provider: string): Promise<{ actor: string; data: Record<string, unknown> } | null> {
    const { rows } = await this.pool.query<{ actor: string; data: Record<string, unknown> }>(
      "delete from oauth_states where state = $1 and provider = $2 and expires_at > now() returning actor, data",
      [state, provider],
    );
    return rows[0] ?? null;
  }

  private decode(r: Row): Entry {
    let secrets: Record<string, string> = {};
    let unreadable = false;
    if (r.secrets_enc) {
      try {
        secrets = this.box().open(r.secrets_enc);
      } catch (err) {
        if (!(err instanceof SecretsUnreadable)) throw err;
        unreadable = true;
      }
    }
    return { kind: r.kind, id: r.id, data: r.data, secrets, meta: r.meta, updatedAt: r.updated_at, ...(unreadable ? { unreadable } : {}) };
  }
}
