import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { BlobIndex, UsageRow } from "./blob-index";
import type { CacheStats, DiskCache } from "./cache";
import type { GoogleDriveBlobStore } from "./google/drive";
import type { LocalBlobStore } from "./local";
import type {
  BackendKind,
  BlobBody,
  BlobInfo,
  BlobSource,
  BlobStore,
  ByteRange,
  Folder,
  PutOptions,
  UploadSession,
  UploadSessionOptions,
} from "./types";
import { isBlobId, newBlobId } from "./types";

export interface StorageOptions {
  index: BlobIndex;
  local: LocalBlobStore;
  /** When set, new files go to Drive; files already local keep being served locally. */
  drive?: GoogleDriveBlobStore;
  cache?: DiskCache;
}

/**
 * The BlobStore the server uses: writes go to the configured backend (Drive or
 * local), reads go wherever the index says the bytes are, so local media from
 * before Drive was switched on keeps working.
 */
export class Storage implements BlobStore {
  readonly index: BlobIndex;
  readonly local: LocalBlobStore;
  readonly drive?: GoogleDriveBlobStore;
  readonly cache?: DiskCache;

  constructor(o: StorageOptions) {
    this.index = o.index;
    this.local = o.local;
    this.drive = o.drive;
    this.cache = o.cache;
  }

  get kind(): BackendKind {
    return this.drive ? "gdrive" : "local";
  }

  private get primary(): BlobStore {
    return this.drive ?? this.local;
  }

  /** Indexes legacy local media and warms the cache's view of the disk. */
  async init(): Promise<{ indexed: number }> {
    await this.cache?.init();
    return { indexed: await this.local.indexExisting() };
  }

  private async backendOf(id: string): Promise<BlobStore | null> {
    if (!isBlobId(id)) return null;
    const row = await this.index.get(id);
    if (!row) return this.local; // a legacy file the index hasn't seen yet
    if (row.backend === "gdrive") return this.drive ?? null;
    return this.local;
  }

  put(source: BlobSource, options: PutOptions): Promise<BlobInfo> {
    return this.primary.put(source, options);
  }

  async get(id: string, options?: { range?: ByteRange }): Promise<BlobBody | null> {
    return (await this.backendOf(id))?.get(id, options) ?? null;
  }

  async head(id: string): Promise<BlobInfo | null> {
    return (await this.backendOf(id))?.head(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.backendOf(id))?.delete(id) ?? false;
  }

  async list(folder?: Folder, options: { limit?: number } = {}): Promise<BlobInfo[]> {
    const rows = await this.index.list({ folder, status: "ready", limit: options.limit });
    return rows.map((r) => ({ id: r.id, name: r.name, size: r.size, contentType: r.contentType, folder: r.folder, backend: r.backend, createdAt: r.createdAt }));
  }

  createUploadSession(options: UploadSessionOptions & { baseUrl?: string }): Promise<UploadSession> {
    return this.drive ? this.drive.createUploadSession(options) : this.local.createUploadSession(options);
  }

  /**
   * A one-shot upload URL for clients that send a whole file in a single PUT
   * (video jobs): `<baseUrl>/api/storage/put/<id>?key=…`. The server streams the
   * body into the configured backend under that id.
   */
  async reserve(o: { name: string; contentType: string; folder?: Folder; baseUrl: string }): Promise<{ id: string; putUrl: string }> {
    const id = newBlobId(o.name);
    const putUrl = `${o.baseUrl.replace(/\/+$/, "")}/api/storage/put/${id}?key=${randomBytes(24).toString("base64url")}`;
    await this.index.put({
      id, backend: "local", remoteId: null, name: o.name, size: 0, contentType: o.contentType, folder: o.folder ?? "renders",
      status: "pending", uploadUrl: putUrl, localPath: null, createdAt: new Date(),
    });
    return { id, putUrl };
  }

  /**
   * Claims the reservation for `id`, if `key` matches and it is still unused (one week):
   * atomically, so of concurrent PUTs only one gets it. Hand it back with
   * `releaseReservation` if the upload fails, so a retry works.
   */
  async claimReservation(id: string, key: string): Promise<{ name: string; contentType: string; folder: Folder } | null> {
    if (!isBlobId(id)) return null;
    const row = await this.index.get(id);
    if (!row || row.status !== "pending" || !row.uploadUrl?.includes("/api/storage/put/")) return null;
    if (Date.now() - row.createdAt.getTime() > 7 * 86_400_000) return null;
    const expected = Buffer.from(new URL(row.uploadUrl).searchParams.get("key") ?? "");
    const given = Buffer.from(key);
    if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (!(await this.index.transition(id, "pending", "uploading"))) return null;
    return { name: row.name, contentType: row.contentType, folder: row.folder };
  }

  /** Puts a claimed reservation back to pending (its upload failed). */
  async releaseReservation(id: string): Promise<void> {
    await this.index.transition(id, "uploading", "pending");
  }

  async completeUpload(id: string): Promise<BlobInfo> {
    const row = await this.index.get(id);
    if (row?.backend === "gdrive" && this.drive) return this.drive.completeUpload(id);
    return this.local.completeUpload(id);
  }

  async usage(): Promise<{
    backend: BackendKind;
    byFolder: UsageRow[];
    totalBytes: number;
    files: number;
    cache: CacheStats | null;
    drive: { folderUrl: string; quota: { limit: number | null; usage: number; usageInDrive: number } | null } | null;
  }> {
    const byFolder = await this.index.usage();
    let drive = null;
    if (this.drive) {
      const folderUrl = await this.drive.folderUrl();
      const quota = await this.drive.quota().catch(() => null);
      drive = { folderUrl, quota };
    }
    return {
      backend: this.kind,
      byFolder,
      totalBytes: byFolder.reduce((n, u) => n + u.bytes, 0),
      files: byFolder.reduce((n, u) => n + u.files, 0),
      cache: this.cache?.stats() ?? null,
      drive,
    };
  }

  /**
   * Copies every local file into Drive, keeping its id (so its /media URL is
   * unchanged). With `deleteLocal`, the local copy then moves into the cache (or is
   * removed if it doesn't fit), freeing the volume.
   */
  async migrateToDrive(options: { deleteLocal?: boolean; limit?: number; log?: (line: string) => void } = {}): Promise<{ copied: string[]; failed: { id: string; error: string }[] }> {
    if (!this.drive) throw new Error("STORAGE_BACKEND=gdrive is needed to migrate to Drive");
    await this.local.indexExisting();
    const copied: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const row of await this.index.list({ backend: "local", status: "ready", limit: options.limit ?? 10_000 })) {
      const path = this.local.pathFor(row.id, row.folder);
      try {
        const info = await this.drive.put(createReadStream(path), { id: row.id, name: row.name, contentType: row.contentType, folder: row.folder });
        if (info.size !== row.size) throw new Error(`size mismatch after upload (${info.size} vs ${row.size})`);
        copied.push(row.id);
        if (options.deleteLocal) {
          if (!(await this.cache?.adopt(row.id, path))) await rm(path, { force: true });
          await this.index.update(row.id, { localPath: this.cache?.has(row.id) ? this.cache.pathOf(row.id) : null });
        }
        options.log?.(`migrated ${row.id} (${row.size} bytes)`);
      } catch (err) {
        // The row may already say gdrive if the failure came after put(); put it back.
        await this.index.put({ ...row });
        failed.push({ id: row.id, error: (err as Error).message });
      }
    }
    return { copied, failed };
  }
}
