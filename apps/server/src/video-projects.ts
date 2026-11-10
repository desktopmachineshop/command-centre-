import type { SceneAssetKeys, VideoSpec } from "@cc/video";
import type { Pool } from "./db/pool";

/**
 * Video projects: every production kept as something that can be edited later without making
 * it again. A project is its revisions (each a full VideoSpec, the source of truth, with what
 * it rendered) plus a pool of the expensive assets made so far (narration with its word
 * timings, screen recordings), keyed by a hash of the inputs that produced them (@cc/video
 * project.ts). The files themselves are in the media store; Postgres holds the specs, the
 * manifest (asset key → file) and the history. One table for projects, one for revisions:
 * the smallest thing that survives a restart and can be listed, compared and rolled back.
 */

export interface VideoAsset {
  kind: "voice" | "capture";
  /** Where the file is served from (the media store). */
  url: string;
  /** The scene and revision it was first made for. */
  sceneId: string;
  revision: number;
  createdAt: string;
  format?: "wav" | "mp3";
  durationSec?: number;
  words?: { word: string; start: number; end: number }[];
  /** Seconds of blank page at the start of a recording. */
  trimStartSec?: number;
}

export interface VideoExport {
  format: "fcpxml" | "resolve-draft";
  at: string;
  /** The FCPXML document. */
  url: string;
  /** Every media file it refers to, by the name it uses for it. */
  files: { name: string; url: string }[];
  captionsUrl?: string;
  /** The Resolve job that opens it as a draft timeline, when asked for. */
  davinciJobId?: string;
}

export interface RevisionOutputs {
  video?: { url?: string; path?: string; durationSec: number; width: number; height: number; bytes: number; encoder: string };
  captionsUrl?: string;
  /** Where each scene sits in the render. */
  timeline?: { total: number; scenes: { id: string; start: number; duration: number; voiceStart: number | null }[] };
  exports?: VideoExport[];
}

/** What was asked for when the revision was made, carried to the end of its render. */
export interface RevisionRequest {
  targets: { accountId: string; text: string; title?: string; options?: Record<string, unknown> }[];
  publishAt?: string;
  encoder: "auto" | "cpu" | "gpu";
  preset?: string;
}

export interface VideoRevision {
  revision: number;
  /** The revision this one edited (null for the first). */
  basedOn: number | null;
  spec: VideoSpec;
  /** Each scene's asset keys: look them up in the project's pool. */
  assets: Record<string, SceneAssetKeys>;
  composeKey: string;
  /** What changed from `basedOn`, in words. */
  changes: string[];
  /** What was re-used and what was made (the planner's one line). */
  plan: string;
  status: "producing" | "ready" | "failed";
  error?: string;
  outputs: RevisionOutputs;
  request: RevisionRequest;
  createdAt: string;
}

export interface VideoProject {
  id: string;
  vertical: string;
  specId: string;
  title: string;
  status: "active" | "archived";
  /** The latest revision's number. */
  current: number;
  pool: Record<string, VideoAsset>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface VideoProjectStore {
  create(p: { id: string; vertical: string; specId: string; title: string }): Promise<VideoProject>;
  get(id: string): Promise<VideoProject | null>;
  list(filter?: { vertical?: string; includeArchived?: boolean; limit?: number }): Promise<VideoProject[]>;
  /** Adds assets to the pool (existing keys are kept as they are). */
  addAssets(id: string, assets: Record<string, VideoAsset>): Promise<void>;
  setTitle(id: string, title: string): Promise<void>;
  /** Marks it archived and empties the pool; returns the assets that were in it. */
  archive(id: string, at: Date): Promise<Record<string, VideoAsset>>;
  addRevision(id: string, r: Omit<VideoRevision, "createdAt">): Promise<VideoRevision>;
  updateRevision(id: string, revision: number, patch: Partial<Pick<VideoRevision, "status" | "error" | "outputs">>): Promise<void>;
  revisions(id: string): Promise<VideoRevision[]>;
  revision(id: string, revision: number): Promise<VideoRevision | null>;
}

/** In memory: tests, and a server started without a database for them. */
export class MemoryVideoProjectStore implements VideoProjectStore {
  private readonly projects = new Map<string, VideoProject>();
  private readonly revs = new Map<string, VideoRevision[]>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(p: { id: string; vertical: string; specId: string; title: string }) {
    const at = this.now().toISOString();
    const project: VideoProject = { ...p, status: "active", current: 0, pool: {}, createdAt: at, updatedAt: at, archivedAt: null };
    this.projects.set(p.id, project);
    this.revs.set(p.id, []);
    return structuredClone(project);
  }
  async get(id: string) {
    const p = this.projects.get(id);
    return p ? structuredClone(p) : null;
  }
  async list(filter: { vertical?: string; includeArchived?: boolean; limit?: number } = {}) {
    return [...this.projects.values()]
      .filter((p) => (!filter.vertical || p.vertical === filter.vertical) && (filter.includeArchived || p.status === "active"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, filter.limit ?? 50)
      .map((p) => structuredClone(p));
  }
  private need(id: string) {
    const p = this.projects.get(id);
    if (!p) throw new Error(`No video project ${id}`);
    return p;
  }
  async addAssets(id: string, assets: Record<string, VideoAsset>) {
    const p = this.need(id);
    p.pool = { ...structuredClone(assets), ...p.pool };
    p.updatedAt = this.now().toISOString();
  }
  async setTitle(id: string, title: string) {
    this.need(id).title = title;
  }
  async archive(id: string, at: Date) {
    const p = this.need(id);
    const pool = p.pool;
    Object.assign(p, { status: "archived", pool: {}, archivedAt: at.toISOString(), updatedAt: at.toISOString() });
    return pool;
  }
  async addRevision(id: string, r: Omit<VideoRevision, "createdAt">) {
    const p = this.need(id);
    const revision = structuredClone({ ...r, createdAt: this.now().toISOString() });
    this.revs.get(id)!.push(revision);
    p.current = r.revision;
    p.updatedAt = revision.createdAt;
    return structuredClone(revision);
  }
  async updateRevision(id: string, revision: number, patch: Partial<Pick<VideoRevision, "status" | "error" | "outputs">>) {
    const r = this.revs.get(id)?.find((x) => x.revision === revision);
    if (!r) throw new Error(`No revision ${revision} of video project ${id}`);
    Object.assign(r, structuredClone(patch));
    this.need(id).updatedAt = this.now().toISOString();
  }
  async revisions(id: string) {
    return structuredClone(this.revs.get(id) ?? []);
  }
  async revision(id: string, revision: number) {
    const r = this.revs.get(id)?.find((x) => x.revision === revision);
    return r ? structuredClone(r) : null;
  }
}

type Row = Record<string, any>;
const iso = (v: unknown) => new Date(v as string).toISOString();
const toProject = (r: Row): VideoProject => ({
  id: r.id,
  vertical: r.vertical,
  specId: r.spec_id,
  title: r.title,
  status: r.status,
  current: r.current_revision,
  pool: r.pool ?? {},
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  archivedAt: r.archived_at ? iso(r.archived_at) : null,
});
const toRevision = (r: Row): VideoRevision => ({
  revision: r.revision,
  basedOn: r.based_on,
  spec: r.spec,
  assets: r.assets ?? {},
  composeKey: r.compose_key,
  changes: r.changes ?? [],
  plan: r.plan ?? "",
  status: r.status,
  ...(r.error ? { error: r.error } : {}),
  outputs: r.outputs ?? {},
  request: r.request ?? { targets: [], encoder: "auto" },
  createdAt: iso(r.created_at),
});

/** Postgres (tables video_projects and video_revisions, migration 0027). */
export class PgVideoProjectStore implements VideoProjectStore {
  constructor(private readonly pool: Pool) {}

  async create(p: { id: string; vertical: string; specId: string; title: string }) {
    const { rows } = await this.pool.query("insert into video_projects (id, vertical, spec_id, title) values ($1, $2, $3, $4) returning *", [p.id, p.vertical, p.specId, p.title]);
    return toProject(rows[0]);
  }
  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query("select * from video_projects where id = $1", [id]);
    return rows[0] ? toProject(rows[0]) : null;
  }
  async list(filter: { vertical?: string; includeArchived?: boolean; limit?: number } = {}) {
    const { rows } = await this.pool.query(
      "select * from video_projects where ($1::text is null or vertical = $1) and ($2 or status = 'active') order by updated_at desc limit $3",
      [filter.vertical ?? null, filter.includeArchived === true, filter.limit ?? 50],
    );
    return rows.map(toProject);
  }
  async addAssets(id: string, assets: Record<string, VideoAsset>) {
    // Existing keys win: the same inputs always made the same asset.
    await this.pool.query("update video_projects set pool = $2::jsonb || pool, updated_at = now() where id = $1", [id, JSON.stringify(assets)]);
  }
  async setTitle(id: string, title: string) {
    await this.pool.query("update video_projects set title = $2 where id = $1", [id, title]);
  }
  async archive(id: string, at: Date) {
    const { rows } = await this.pool.query("select pool from video_projects where id = $1", [id]);
    await this.pool.query("update video_projects set status = 'archived', pool = '{}', archived_at = $2, updated_at = $2 where id = $1", [id, at]);
    return (rows[0]?.pool ?? {}) as Record<string, VideoAsset>;
  }
  async addRevision(id: string, r: Omit<VideoRevision, "createdAt">) {
    const { rows } = await this.pool.query(
      `insert into video_revisions (project_id, revision, based_on, spec, assets, compose_key, changes, plan, status, error, outputs, request)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [id, r.revision, r.basedOn, JSON.stringify(r.spec), JSON.stringify(r.assets), r.composeKey, JSON.stringify(r.changes), r.plan, r.status, r.error ?? null, JSON.stringify(r.outputs), JSON.stringify(r.request)],
    );
    await this.pool.query("update video_projects set current_revision = $2, updated_at = now() where id = $1", [id, r.revision]);
    return toRevision(rows[0]);
  }
  async updateRevision(id: string, revision: number, patch: Partial<Pick<VideoRevision, "status" | "error" | "outputs">>) {
    await this.pool.query(
      `update video_revisions set status = coalesce($3, status), error = coalesce($4, error), outputs = coalesce($5::jsonb, outputs), updated_at = now()
       where project_id = $1 and revision = $2`,
      [id, revision, patch.status ?? null, patch.error ?? null, patch.outputs ? JSON.stringify(patch.outputs) : null],
    );
    await this.pool.query("update video_projects set updated_at = now() where id = $1", [id]);
  }
  async revisions(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
    const { rows } = await this.pool.query("select * from video_revisions where project_id = $1 order by revision", [id]);
    return rows.map(toRevision);
  }
  async revision(id: string, revision: number) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query("select * from video_revisions where project_id = $1 and revision = $2", [id, revision]);
    return rows[0] ? toRevision(rows[0]) : null;
  }
}
