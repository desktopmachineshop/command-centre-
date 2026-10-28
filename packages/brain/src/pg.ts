import {
  appendJournalLine,
  BRAIN_README,
  type Brain,
  BrainConflictError,
  journalEntry,
  notePath,
  type SearchHit,
  snippet,
  tokenize,
  type WriteOptions,
  writeOptions,
} from "./brain";
import { type Frontmatter, type Note, noteTitle } from "./note";
import { SEED_NOTES } from "./seed";

/**
 * Schema for the brain. The server applies it as migration `0014_brain`
 * (apps/server/src/db/migrations.ts); the package's own tests apply it to a
 * scratch schema. Never edit it once applied: add a new migration instead.
 */
export const BRAIN_MIGRATION_ID = "0014_brain";

export const BRAIN_MIGRATION_SQL = `
  create table brain_notes (
    path text primary key,
    title text not null,
    frontmatter jsonb not null default '{}',
    body text not null,
    -- Matches brain_note_versions.version of the latest save.
    version integer not null,
    updated_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    search tsvector generated always as (
      setweight(to_tsvector('english', title || ' ' || translate(path, '/-_.', '    ')), 'A') ||
      setweight(jsonb_to_tsvector('english', frontmatter, '["string"]'), 'B') ||
      setweight(to_tsvector('english', body), 'C')
    ) stored
  );
  create index brain_notes_search_idx on brain_notes using gin (search);

  -- Every save and delete, so any note can be read or restored as it was.
  create table brain_note_versions (
    id bigserial primary key,
    path text not null,
    version integer not null,
    -- Both null for a delete.
    frontmatter jsonb,
    body text,
    author text not null,
    message text,
    created_at timestamptz not null default now(),
    unique (path, version)
  );
`;

/** What PgBrain needs from a pg Pool: queries, plus a client for transactions. */
export interface BrainPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }>;
}

export interface NoteVersion {
  version: number;
  author: string;
  message: string | null;
  deleted: boolean;
  createdAt: string;
}

/** A note as stored, with the version an editor sends back to save over it. */
export interface StoredNote extends Note {
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface PgBrainOptions {
  /** Called after every change, e.g. to schedule the git mirror. */
  onChange?: (path: string) => void;
}

type Tx = Awaited<ReturnType<BrainPool["connect"]>>;

/** The brain in Postgres: one row per note, full-text search, and a version history. */
export class PgBrain implements Brain {
  constructor(
    private readonly pool: BrainPool,
    private readonly options: PgBrainOptions = {},
  ) {}

  /** Adds the README and seed notes, each only if that path has never existed. */
  async init(): Promise<void> {
    const seeds = [{ path: "README.md", frontmatter: {}, body: BRAIN_README }, ...SEED_NOTES];
    for (const seed of seeds) {
      const { rows } = await this.pool.query("select 1 from brain_note_versions where path = $1 limit 1", [seed.path]);
      if (rows.length === 0) await this.write(seed.path, seed, { author: "system", message: "brain: seed", expectedVersion: 0 }).catch(ignoreConflict);
    }
  }

  /** True until anything has ever been written (deletes count), so an import runs once. */
  async isEmpty(): Promise<boolean> {
    const { rows } = await this.pool.query("select 1 from brain_note_versions limit 1");
    return rows.length === 0;
  }

  async read(path: string): Promise<StoredNote | null> {
    const { rows } = await this.pool.query(
      "select path, frontmatter, body, version, updated_by, updated_at from brain_notes where path = $1",
      [notePath(path)],
    );
    return rows[0] ? toNote(rows[0]) : null;
  }

  /** Every note, for the git mirror. */
  async all(): Promise<StoredNote[]> {
    const { rows } = await this.pool.query("select path, frontmatter, body, version, updated_by, updated_at from brain_notes order by path");
    return rows.map(toNote);
  }

  async write(path: string, content: { frontmatter?: Frontmatter; body: string }, options?: string | WriteOptions): Promise<StoredNote> {
    const opts = writeOptions(options);
    return this.mutate(path, opts, () => content);
  }

  async appendJournal(text: string, options: { vertical?: string; at?: Date } = {}): Promise<StoredNote> {
    const { path, day, line } = journalEntry(text, options);
    return this.mutate(path, { message: `journal: ${day}`, author: "agent" }, (existing) => ({
      frontmatter: { ...(existing?.frontmatter ?? {}), type: "journal" },
      body: appendJournalLine(existing, day, line),
    }));
  }

  async delete(path: string, options: WriteOptions = {}): Promise<boolean> {
    const rel = notePath(path);
    const deleted = await this.tx(rel, async (tx) => {
      const { rows } = await tx.query("select version from brain_notes where path = $1 for update", [rel]);
      if (!rows[0]) return false;
      if (options.expectedVersion !== undefined && options.expectedVersion !== rows[0].version) {
        throw new BrainConflictError(rel, rows[0].version);
      }
      await tx.query("delete from brain_notes where path = $1", [rel]);
      await tx.query(
        `insert into brain_note_versions (path, version, author, message)
         values ($1, (select coalesce(max(version), 0) + 1 from brain_note_versions where path = $1), $2, $3)`,
        [rel, options.author ?? "agent", options.message ?? `brain: delete ${rel}`],
      );
      return true;
    });
    if (deleted) this.options.onChange?.(rel);
    return deleted;
  }

  async history(path: string, limit = 100): Promise<NoteVersion[]> {
    const { rows } = await this.pool.query(
      `select version, author, message, body is null as deleted, created_at from brain_note_versions
       where path = $1 order by version desc limit $2`,
      [notePath(path), limit],
    );
    return rows.map((r) => ({ version: r.version, author: r.author, message: r.message, deleted: r.deleted, createdAt: iso(r.created_at) }));
  }

  /** A note as it was at one version; null if there is no such version or it was a delete. */
  async readVersion(path: string, version: number): Promise<Note | null> {
    const rel = notePath(path);
    const { rows } = await this.pool.query(
      "select frontmatter, body from brain_note_versions where path = $1 and version = $2 and body is not null",
      [rel, version],
    );
    return rows[0] ? { path: rel, frontmatter: rows[0].frontmatter, body: rows[0].body } : null;
  }

  /** Save an old version as the newest one. */
  async restore(path: string, version: number, options: WriteOptions = {}): Promise<StoredNote | null> {
    const old = await this.readVersion(path, version);
    if (!old) return null;
    const { updated: _updated, ...frontmatter } = old.frontmatter;
    return this.write(path, { frontmatter, body: old.body }, { message: `brain: restore ${old.path} to version ${version}`, ...options });
  }

  async list(folder = ""): Promise<string[]> {
    const prefix = folderPrefix(folder);
    const { rows } = await this.pool.query(
      "select path from brain_notes where $1 = '' or left(path, length($1)) = $1 order by path",
      [prefix],
    );
    return rows.map((r) => r.path);
  }

  /** Full-text search (English stemming, prefix matches); title and path outrank frontmatter, then body. */
  async search(query: string, options: { folder?: string; limit?: number } = {}): Promise<SearchHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const { rows } = await this.pool.query(
      `with q as (select to_tsquery('english', $1) as q)
       select path, title, body, ts_rank(search, q.q) as score from brain_notes, q
       where search @@ q.q and ($2 = '' or left(path, length($2)) = $2)
       order by score desc, path limit $3`,
      [terms.map((t) => `${t}:*`).join(" | "), folderPrefix(options.folder ?? ""), options.limit ?? 10],
    );
    return rows.map((r) => ({ path: r.path, title: r.title, score: Number(r.score), snippet: snippet(r.body, terms) }));
  }

  /**
   * Read-modify-write one note under a per-path lock, so concurrent journal
   * appends never lose a line. A save that changes nothing (bar `updated`)
   * keeps the current version instead of adding one.
   */
  private async mutate(
    path: string,
    opts: WriteOptions,
    change: (existing: Note | null) => { frontmatter?: Frontmatter; body: string },
  ): Promise<StoredNote> {
    const rel = notePath(path);
    const { note, changed } = await this.tx(rel, async (tx) => {
      const { rows } = await tx.query("select path, frontmatter, body, version, updated_by, updated_at from brain_notes where path = $1", [rel]);
      const existing = rows[0] ? toNote(rows[0]) : null;
      const current = existing?.version ?? 0;
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) throw new BrainConflictError(rel, current);
      const next = change(existing);
      const { updated: _updated, ...given } = next.frontmatter ?? {};
      if (existing && existing.body === next.body && sameFrontmatter(existing.frontmatter, given)) return { note: existing, changed: false };

      const frontmatter = { ...given, updated: new Date().toISOString() };
      const title = noteTitle({ path: rel, frontmatter, body: next.body });
      const author = opts.author ?? "agent";
      const saved = await tx.query(
        `insert into brain_note_versions (path, version, frontmatter, body, author, message)
         values ($1, (select coalesce(max(version), 0) + 1 from brain_note_versions where path = $1), $2, $3, $4, $5)
         returning version`,
        [rel, frontmatter, next.body, author, opts.message ?? `brain: update ${rel}`],
      );
      const version = saved.rows[0].version as number;
      const { rows: out } = await tx.query(
        `insert into brain_notes (path, title, frontmatter, body, version, updated_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (path) do update set title = excluded.title, frontmatter = excluded.frontmatter, body = excluded.body,
           version = excluded.version, updated_by = excluded.updated_by, updated_at = now()
         returning path, frontmatter, body, version, updated_by, updated_at`,
        [rel, title, frontmatter, next.body, version, author],
      );
      return { note: toNote(out[0]), changed: true };
    });
    if (changed) this.options.onChange?.(rel);
    return note;
  }

  private async tx<T>(path: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`brain:${path}`]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

function toNote(r: Record<string, any>): StoredNote {
  return { path: r.path, frontmatter: r.frontmatter ?? {}, body: r.body, version: r.version, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) };
}

const iso = (v: Date | string): string => new Date(v).toISOString();

/** "dms" or "dms/" → "dms/"; "" → "". */
function folderPrefix(folder: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  if (trimmed.split("/").includes("..")) throw new Error(`Path outside brain: ${folder}`);
  return trimmed ? `${trimmed}/` : "";
}

function sameFrontmatter(a: Frontmatter, b: Frontmatter): boolean {
  const { updated: _a, ...left } = a;
  const { updated: _b, ...right } = b;
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function ignoreConflict(err: unknown) {
  if (!(err instanceof BrainConflictError)) throw err;
}
