import type { BackendKind, Folder } from "./types";

/** One row of the storage index (Postgres table `storage_files`, migration 0011_storage). */
export interface BlobRecord {
  id: string;
  backend: BackendKind;
  /** Drive file id (gdrive), null locally. */
  remoteId: string | null;
  name: string;
  size: number;
  contentType: string;
  folder: Folder;
  /** "pending" while a direct upload is open; "uploading" while one request holds it. */
  status: "pending" | "uploading" | "ready";
  /** Resumable session URI (Drive) or our own chunk URL (local), only while pending. */
  uploadUrl: string | null;
  /** The local file (local backend) or warm cache copy (gdrive), if any. */
  localPath: string | null;
  createdAt: Date;
}

export interface UsageRow {
  folder: Folder;
  backend: BackendKind;
  files: number;
  bytes: number;
}

/** Our public id ↔ where the bytes are. Postgres in the server, memory in tests. */
export interface BlobIndex {
  get(id: string): Promise<BlobRecord | null>;
  /** Insert or replace. */
  put(record: BlobRecord): Promise<void>;
  update(id: string, patch: Partial<Omit<BlobRecord, "id" | "createdAt">>): Promise<void>;
  /** Atomically moves `id` from status `from` to `to`; the updated row, or null if it wasn't `from`. */
  transition(id: string, from: BlobRecord["status"], to: BlobRecord["status"]): Promise<BlobRecord | null>;
  delete(id: string): Promise<void>;
  list(filter?: { folder?: Folder; backend?: BackendKind; status?: BlobRecord["status"]; limit?: number }): Promise<BlobRecord[]>;
  usage(): Promise<UsageRow[]>;
  /** Small key/value state, e.g. remembered Drive folder ids. */
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
}

export class MemoryBlobIndex implements BlobIndex {
  readonly rows = new Map<string, BlobRecord>();
  readonly state = new Map<string, string>();
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async put(record: BlobRecord) {
    this.rows.set(record.id, { ...record });
  }
  async update(id: string, patch: Partial<BlobRecord>) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...patch });
  }
  async transition(id: string, from: BlobRecord["status"], to: BlobRecord["status"]) {
    const r = this.rows.get(id);
    if (!r || r.status !== from) return null;
    this.rows.set(id, { ...r, status: to });
    return { ...r, status: to };
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async list(filter: { folder?: Folder; backend?: BackendKind; status?: BlobRecord["status"]; limit?: number } = {}) {
    return [...this.rows.values()]
      .filter((r) => (!filter.folder || r.folder === filter.folder) && (!filter.backend || r.backend === filter.backend) && (!filter.status || r.status === filter.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit ?? 1000)
      .map((r) => ({ ...r }));
  }
  async usage() {
    const by = new Map<string, UsageRow>();
    for (const r of this.rows.values()) {
      if (r.status !== "ready") continue;
      const k = `${r.folder}/${r.backend}`;
      const u = by.get(k) ?? { folder: r.folder, backend: r.backend, files: 0, bytes: 0 };
      u.files++;
      u.bytes += r.size;
      by.set(k, u);
    }
    return [...by.values()];
  }
  async getState(key: string) {
    return this.state.get(key) ?? null;
  }
  async setState(key: string, value: string) {
    this.state.set(key, value);
  }
}

/** Anything with pg's `query(text, params)`: a Pool or a Client. */
export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const COLUMNS: Record<keyof Omit<BlobRecord, "id" | "createdAt">, string> = {
  backend: "backend",
  remoteId: "remote_id",
  name: "name",
  size: "size",
  contentType: "content_type",
  folder: "folder",
  status: "status",
  uploadUrl: "upload_url",
  localPath: "local_path",
};

function fromRow(r: any): BlobRecord {
  return {
    id: r.id,
    backend: r.backend,
    remoteId: r.remote_id,
    name: r.name,
    size: Number(r.size),
    contentType: r.content_type,
    folder: r.folder,
    status: r.status,
    uploadUrl: r.upload_url,
    localPath: r.local_path,
    createdAt: new Date(r.created_at),
  };
}

/** The index in Postgres: tables `storage_files` and `storage_state` (see the server's 0011_storage migration). */
export class PgBlobIndex implements BlobIndex {
  constructor(private readonly db: Queryable) {}

  async get(id: string) {
    const { rows } = await this.db.query("select * from storage_files where id = $1", [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async put(r: BlobRecord) {
    await this.db.query(
      `insert into storage_files (id, backend, remote_id, name, size, content_type, folder, status, upload_url, local_path, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set backend = excluded.backend, remote_id = excluded.remote_id, name = excluded.name,
         size = excluded.size, content_type = excluded.content_type, folder = excluded.folder, status = excluded.status,
         upload_url = excluded.upload_url, local_path = excluded.local_path`,
      [r.id, r.backend, r.remoteId, r.name, r.size, r.contentType, r.folder, r.status, r.uploadUrl, r.localPath, r.createdAt],
    );
  }

  async update(id: string, patch: Partial<Omit<BlobRecord, "id" | "createdAt">>) {
    const entries = Object.entries(patch).filter(([k]) => k in COLUMNS);
    if (!entries.length) return;
    const sets = entries.map(([k], i) => `${COLUMNS[k as keyof typeof COLUMNS]} = $${i + 2}`);
    await this.db.query(`update storage_files set ${sets.join(", ")} where id = $1`, [id, ...entries.map(([, v]) => v)]);
  }

  async transition(id: string, from: BlobRecord["status"], to: BlobRecord["status"]) {
    const { rows } = await this.db.query("update storage_files set status = $3 where id = $1 and status = $2 returning *", [id, from, to]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async delete(id: string) {
    await this.db.query("delete from storage_files where id = $1", [id]);
  }

  async list(filter: { folder?: Folder; backend?: BackendKind; status?: BlobRecord["status"]; limit?: number } = {}) {
    const { rows } = await this.db.query(
      `select * from storage_files where ($1::text is null or folder = $1) and ($2::text is null or backend = $2)
       and ($3::text is null or status = $3) order by created_at desc limit $4`,
      [filter.folder ?? null, filter.backend ?? null, filter.status ?? null, filter.limit ?? 1000],
    );
    return rows.map(fromRow);
  }

  async usage() {
    const { rows } = await this.db.query(
      "select folder, backend, count(*)::int as files, coalesce(sum(size), 0)::bigint as bytes from storage_files where status = 'ready' group by folder, backend order by folder, backend",
    );
    return rows.map((r: any) => ({ folder: r.folder, backend: r.backend, files: Number(r.files), bytes: Number(r.bytes) }));
  }

  async getState(key: string) {
    const { rows } = await this.db.query<{ value: string }>("select value from storage_state where key = $1", [key]);
    return rows[0]?.value ?? null;
  }

  async setState(key: string, value: string) {
    await this.db.query(
      "insert into storage_state (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
      [key, value],
    );
  }
}
