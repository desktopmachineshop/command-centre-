import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobIndex, BlobRecord } from "./blob-index";
import {
  type BlobBody,
  type BlobInfo,
  type BlobSource,
  type BlobStore,
  type ByteRange,
  DEFAULT_CHUNK_SIZE,
  type Folder,
  isBlobId,
  newBlobId,
  type PutOptions,
  type UploadSession,
  type UploadSessionOptions,
  UploadIncompleteError,
} from "./types";
import { toReadable } from "./util";

/** Content types for files that predate the index, by extension (the same set /media serves). */
const LEGACY_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export interface LocalBlobStoreOptions {
  /** `media` → DATA_DIR/media (unchanged), others → DATA_DIR/storage/<folder>. */
  dataDir: string;
  index: BlobIndex;
  /** Chunked-upload URL base on our server, e.g. https://cc.example.com/api/storage/uploads */
  uploadBaseUrl?: string;
  /** Pending direct uploads expire after this long. */
  uploadTtlMs?: number;
}

export type ChunkResult = { done: false; received: number } | { done: true; info: BlobInfo };

export const toInfo = (r: BlobRecord): BlobInfo => ({
  id: r.id,
  name: r.name,
  size: r.size,
  contentType: r.contentType,
  folder: r.folder,
  backend: r.backend,
  createdAt: r.createdAt,
});

/**
 * Files on the server's volume: the behaviour Command Centre always had.
 * Files under DATA_DIR/media from before the index still work (see `indexExisting`
 * and the fallback in `head`).
 */
export class LocalBlobStore implements BlobStore {
  readonly kind = "local" as const;
  constructor(private readonly options: LocalBlobStoreOptions) {}

  dirFor(folder: Folder): string {
    return folder === "media" ? join(this.options.dataDir, "media") : join(this.options.dataDir, "storage", folder);
  }

  pathFor(id: string, folder: Folder): string {
    if (!isBlobId(id)) throw new Error(`invalid blob id ${id}`);
    return join(this.dirFor(folder), id);
  }

  async put(source: BlobSource, options: PutOptions): Promise<BlobInfo> {
    const folder = options.folder ?? "media";
    const id = options.id ?? newBlobId(options.name);
    const path = this.pathFor(id, folder);
    await mkdir(this.dirFor(folder), { recursive: true });
    try {
      await pipeline(toReadable(source), createWriteStream(`${path}.part`));
      await rename(`${path}.part`, path);
    } catch (err) {
      await rm(`${path}.part`, { force: true });
      throw err;
    }
    const { size } = await stat(path);
    const record: BlobRecord = {
      id, backend: "local", remoteId: null, name: options.name, size, contentType: options.contentType, folder,
      status: "ready", uploadUrl: null, localPath: path, createdAt: new Date(),
    };
    await this.options.index.put(record);
    return toInfo(record);
  }

  async head(id: string): Promise<BlobInfo | null> {
    if (!isBlobId(id)) return null;
    const row = await this.options.index.get(id);
    if (row) return row.status === "ready" && row.backend === "local" ? toInfo(row) : null;
    return this.legacy(id);
  }

  /** A file in DATA_DIR/media that the index doesn't know yet. */
  private async legacy(id: string): Promise<BlobInfo | null> {
    const type = LEGACY_TYPES[id.split(".")[1] ?? ""];
    if (!type) return null;
    const info = await stat(this.pathFor(id, "media")).catch(() => null);
    if (!info?.isFile()) return null;
    return { id, name: id, size: info.size, contentType: type, folder: "media", backend: "local", createdAt: info.mtime };
  }

  async get(id: string, options: { range?: ByteRange } = {}): Promise<BlobBody | null> {
    const info = await this.head(id);
    if (!info) return null;
    const { range } = options;
    const stream = createReadStream(this.pathFor(id, info.folder), range ? { start: range.start, end: range.end } : {});
    return { stream, size: info.size, contentType: info.contentType, range };
  }

  async delete(id: string): Promise<boolean> {
    const info = await this.head(id);
    if (!info) return false;
    await rm(this.pathFor(id, info.folder), { force: true });
    await rm(`${this.pathFor(id, info.folder)}.part`, { force: true });
    await this.options.index.delete(id);
    return true;
  }

  async list(folder?: Folder, options: { limit?: number } = {}): Promise<BlobInfo[]> {
    return (await this.options.index.list({ folder, backend: "local", status: "ready", limit: options.limit })).map(toInfo);
  }

  /** Adds index rows for files in DATA_DIR/media written before the index existed. Returns how many. */
  async indexExisting(): Promise<number> {
    const names = await readdir(this.dirFor("media")).catch(() => [] as string[]);
    let added = 0;
    for (const name of names) {
      if (!isBlobId(name) || (await this.options.index.get(name))) continue;
      const info = await this.legacy(name);
      if (!info) continue;
      await this.options.index.put({ ...info, remoteId: null, status: "ready", uploadUrl: null, localPath: this.pathFor(name, "media") });
      added++;
    }
    return added;
  }

  async createUploadSession(options: UploadSessionOptions & { baseUrl?: string }): Promise<UploadSession> {
    const base = options.baseUrl ?? this.options.uploadBaseUrl;
    if (!base) throw new Error("local uploads need the server's upload URL");
    const folder = options.folder ?? "media";
    const id = newBlobId(options.name);
    const key = randomBytes(24).toString("base64url");
    const uploadUrl = `${base.replace(/\/+$/, "")}/${id}?key=${key}`;
    await mkdir(this.dirFor(folder), { recursive: true });
    await this.options.index.put({
      id, backend: "local", remoteId: null, name: options.name, size: options.size, contentType: options.contentType, folder,
      status: "pending", uploadUrl, localPath: null, createdAt: new Date(),
    });
    return { id, uploadUrl, chunkSize: DEFAULT_CHUNK_SIZE, backend: "local", expiresAt: new Date(Date.now() + this.ttl) };
  }

  private get ttl() {
    return this.options.uploadTtlMs ?? 7 * 86_400_000;
  }

  /** The pending upload `id`, if `key` is the one its upload URL carries. */
  async pendingUpload(id: string, key: string): Promise<BlobRecord | null> {
    if (!isBlobId(id)) return null;
    const row = await this.options.index.get(id);
    if (!row || row.status !== "pending" || row.backend !== "local" || !row.uploadUrl) return null;
    if (Date.now() - row.createdAt.getTime() > this.ttl) return null;
    const expected = Buffer.from(new URL(row.uploadUrl).searchParams.get("key") ?? "");
    const given = Buffer.from(key);
    return expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given) ? row : null;
  }

  /**
   * One request of the resumable protocol on our server, mirroring Drive:
   * `Content-Range: bytes a-b/total` with the bytes, or `bytes * /total` (no body) to ask
   * how much arrived. A chunk that doesn't start where the stored bytes end is
   * ignored, and the reply says where to continue.
   */
  async receiveChunk(row: BlobRecord, contentRange: string | undefined, body: ReadableStream<Uint8Array> | null): Promise<ChunkResult> {
    const part = `${this.pathFor(row.id, row.folder)}.part`;
    const have = (await stat(part).catch(() => null))?.size ?? 0;
    const status = /^bytes \*\/(\d+|\*)$/.exec(contentRange ?? "");
    const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    if (status || !chunk || !body) {
      if (have === row.size && row.size > 0) return { done: true, info: await this.finish(row) };
      return { done: false, received: have };
    }
    const [start, end, total] = [Number(chunk[1]), Number(chunk[2]), Number(chunk[3])];
    if (total !== row.size) throw new UploadIncompleteError(`total ${total} does not match the declared size ${row.size}`);
    if (end < start || end >= total) throw new UploadIncompleteError("bad Content-Range");
    if (start !== have) {
      await body.cancel().catch(() => {});
      return { done: false, received: have };
    }
    let written = 0;
    const max = end - start + 1;
    const limit = new Transform({
      transform(c: Buffer, _e, done) {
        written += c.length;
        done(written > max ? new UploadIncompleteError("chunk is longer than its Content-Range") : null, c);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), limit, createWriteStream(part, { flags: "a" }));
    } catch (err) {
      // Keep what arrived intact up to `have`: a partial chunk is rolled back.

      await truncate(part, have).catch(() => {});
      throw err;
    }
    if (written !== max) {

      await truncate(part, have);
      return { done: false, received: have };
    }
    if (have + written === row.size) return { done: true, info: await this.finish(row) };
    return { done: false, received: have + written };
  }

  private async finish(row: BlobRecord): Promise<BlobInfo> {
    const path = this.pathFor(row.id, row.folder);
    await rename(`${path}.part`, path);
    await this.options.index.update(row.id, { status: "ready", uploadUrl: null, localPath: path });
    return toInfo({ ...row, status: "ready", localPath: path });
  }

  async completeUpload(id: string): Promise<BlobInfo> {
    const row = await this.options.index.get(id);
    if (!row || row.backend !== "local") throw new UploadIncompleteError(`no upload ${id}`);
    if (row.status === "ready") return toInfo(row);
    const have = (await stat(`${this.pathFor(id, row.folder)}.part`).catch(() => null))?.size ?? 0;
    if (have !== row.size || row.size === 0) throw new UploadIncompleteError(`upload ${id} has ${have} of ${row.size} bytes`, have);
    return this.finish(row);
  }
}
