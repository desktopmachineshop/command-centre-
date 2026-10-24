import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { BlobIndex, BlobRecord } from "../blob-index";
import type { DiskCache } from "../cache";
import { toInfo } from "../local";
import { uploadStreamResumable } from "../resumable";
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
} from "../types";
import { backoffMs, redact, sleep, sliceStream, toReadable } from "../util";
import type { GoogleTokenProvider } from "./oauth";

/**
 * Google Drive API v3 (https://developers.google.com/workspace/drive/api/reference/rest/v3).
 * Scope: `drive.file`, so the app only sees files and folders it created itself.
 */
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(redact(message));
  }
}

export interface GoogleDriveBlobStoreOptions {
  tokens: GoogleTokenProvider;
  index: BlobIndex;
  fetch?: typeof fetch;
  cache?: DiskCache;
  /** Top-level folder in My Drive. */
  rootFolderName?: string;
  chunkSize?: number;
  retries?: number;
  /** Overridable for tests. */
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
}

/** Drive query string literal: backslash-escape `\` and `'` (see "Search for files and folders"). */
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export class GoogleDriveBlobStore implements BlobStore {
  readonly kind = "gdrive" as const;
  private readonly doFetch: typeof fetch;
  private readonly folders = new Map<string, Promise<string>>();
  private readonly filling = new Set<string>();

  constructor(private readonly o: GoogleDriveBlobStoreOptions) {
    this.doFetch = o.fetch ?? fetch;
  }

  get rootFolderName() {
    return this.o.rootFolderName ?? "Command Centre";
  }

  private log(line: string) {
    (this.o.log ?? console.log)(`[storage] ${redact(line)}`);
  }

  /**
   * An authorised request. A 401 refreshes the token once; 429, 5xx and rate-limit 403s
   * back off exponentially ("Handle errors": exponential backoff, max 32-64 s).
   */
  async request(url: string, init: RequestInit = {}, attempt = 0, refreshed = false): Promise<Response> {
    const token = await this.o.tokens.getAccessToken({ forceRefresh: refreshed });
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    let res: Response;
    try {
      res = await this.doFetch(url, { ...init, headers });
    } catch (err) {
      if (attempt >= (this.o.retries ?? 5) || init.body instanceof ReadableStream) throw new DriveApiError(`Drive request failed: ${(err as Error).message}`, 0);
      await sleep((this.o.backoff ?? backoffMs)(attempt));
      return this.request(url, init, attempt + 1, refreshed);
    }
    if (res.status === 401 && !refreshed) {
      await res.body?.cancel();
      return this.request(url, init, attempt, true);
    }
    if (res.status === 429 || res.status >= 500 || res.status === 403) {
      const text = await res.clone().text().catch(() => "");
      const rate = res.status !== 403 || /rate ?limit/i.test(text);
      if (rate && attempt < (this.o.retries ?? 5)) {
        await res.body?.cancel();
        await sleep((this.o.backoff ?? backoffMs)(attempt));
        return this.request(url, init, attempt + 1, refreshed);
      }
    }
    return res;
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    const text = await res.text();
    if (!res.ok) throw new DriveApiError(`Drive ${init.method ?? "GET"} ${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Finds (by name, among the app's own files) or creates a folder, remembered in the index state. */
  private async ensureFolder(name: string, parent: string | "root", stateKey: string): Promise<string> {
    const known = await this.o.index.getState(stateKey);
    if (known) return known;
    const query = `name = ${q(name)} and mimeType = '${FOLDER_MIME}' and ${q(parent)} in parents and trashed = false`;
    const found = await this.json<{ files: { id: string }[] }>(
      `${DRIVE_API}/files?${new URLSearchParams({ q: query, spaces: "drive", fields: "files(id)", pageSize: "1" })}`,
    );
    let id = found.files[0]?.id;
    if (!id) {
      id = (
        await this.json<{ id: string }>(`${DRIVE_API}/files?fields=id`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
        })
      ).id;
      this.log(`created Drive folder "${name}"`);
    }
    await this.o.index.setState(stateKey, id);
    return id;
  }

  rootFolderId(): Promise<string> {
    return this.memo("root", () => this.ensureFolder(this.rootFolderName, "root", "gdrive.folder.root"));
  }

  folderId(folder: Folder): Promise<string> {
    return this.memo(folder, async () => this.ensureFolder(folder, await this.rootFolderId(), `gdrive.folder.${folder}`));
  }

  private memo(key: string, make: () => Promise<string>): Promise<string> {
    let p = this.folders.get(key);
    if (!p) {
      p = make().catch((err) => {
        this.folders.delete(key);
        throw err;
      });
      this.folders.set(key, p);
    }
    return p;
  }

  /** The Drive folder Dave can open to see everything. */
  async folderUrl(): Promise<string> {
    return `https://drive.google.com/drive/folders/${await this.rootFolderId()}`;
  }

  /** Starts a resumable session and returns its session URI (the Location header). */
  private async startSession(id: string, o: { name: string; contentType: string; folder: Folder; size?: number; origin?: string }): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": o.contentType };
    if (o.size !== undefined) headers["x-upload-content-length"] = String(o.size);
    if (o.origin) headers.origin = o.origin;
    const res = await this.request(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,size,mimeType`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: o.name, mimeType: o.contentType, parents: [await this.folderId(o.folder)], appProperties: { ccId: id } }),
    });
    const location = res.headers.get("location");
    if (!res.ok || !location) throw new DriveApiError(`Drive upload session failed (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
    await res.body?.cancel();
    return location;
  }

  async put(source: BlobSource, options: PutOptions): Promise<BlobInfo> {
    const folder = options.folder ?? "media";
    const id = options.id ?? newBlobId(options.name);
    const uploadUrl = await this.startSession(id, { ...options, folder });
    const { body, size } = await uploadStreamResumable(toReadable(source), {
      uploadUrl,
      fetch: this.doFetch,
      chunkSize: this.o.chunkSize ?? DEFAULT_CHUNK_SIZE,
      retries: this.o.retries,
      backoff: this.o.backoff,
    });
    const file = body as { id: string; size?: string };
    const record: BlobRecord = {
      id, backend: "gdrive", remoteId: file.id, name: options.name, size: file.size ? Number(file.size) : size,
      contentType: options.contentType, folder, status: "ready", uploadUrl: null, localPath: null, createdAt: new Date(),
    };
    await this.o.index.put(record);
    return toInfo(record);
  }

  private async row(id: string): Promise<BlobRecord | null> {
    if (!isBlobId(id)) return null;
    const row = await this.o.index.get(id);
    return row && row.backend === "gdrive" && row.status === "ready" && row.remoteId ? row : null;
  }

  async head(id: string): Promise<BlobInfo | null> {
    const row = await this.row(id);
    return row ? toInfo(row) : null;
  }

  /** From the cache when warm, else streamed from Drive (`alt=media`, with Range passed through). */
  async get(id: string, options: { range?: ByteRange } = {}): Promise<BlobBody | null> {
    const row = await this.row(id);
    if (!row) return null;
    const { range } = options;
    const cached = await this.o.cache?.lookup(id);
    if (cached) {
      return { stream: createReadStream(cached, range ? { start: range.start, end: range.end } : {}), size: row.size, contentType: row.contentType, range };
    }
    const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(row.remoteId!)}?alt=media`, {
      headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) throw new DriveApiError(`Drive download failed (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
    let stream: Readable = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    // A server that ignores Range answers 200 with everything: cut it down ourselves.
    if (range && res.status === 200) stream = stream.pipe(sliceStream(range.start, range.end));
    this.warm(row);
    return { stream, size: row.size, contentType: row.contentType, range };
  }

  /** Downloads the whole file into the cache in the background, once. */
  private warm(row: BlobRecord) {
    const cache = this.o.cache;
    if (!cache || !cache.fits(row.size) || this.filling.has(row.id) || cache.has(row.id)) return;
    this.filling.add(row.id);
    void (async () => {
      try {
        const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(row.remoteId!)}?alt=media`);
        if (!res.ok || !res.body) return void (await res.body?.cancel());
        await cache.fill(row.id, Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), row.size);
      } catch (err) {
        this.log(`cache fill for ${row.id} failed: ${(err as Error).message}`);
      } finally {
        this.filling.delete(row.id);
      }
    })();
  }

  /** Resolves when background cache fills have finished (tests). */
  async idle() {
    while (this.filling.size) await sleep(5);
  }

  async delete(id: string): Promise<boolean> {
    if (!isBlobId(id)) return false;
    const row = await this.o.index.get(id);
    if (!row || row.backend !== "gdrive") return false;
    if (row.remoteId) {
      const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(row.remoteId)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new DriveApiError(`Drive delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
      await res.body?.cancel();
    }
    await this.o.cache?.evict(id);
    await this.o.index.delete(id);
    return true;
  }

  async list(folder?: Folder, options: { limit?: number } = {}): Promise<BlobInfo[]> {
    return (await this.o.index.list({ folder, backend: "gdrive", status: "ready", limit: options.limit })).map(toInfo);
  }

  /**
   * A session URI the client uploads to directly (bytes never pass through our
   * server). The URI itself is the credential for that one upload, so the
   * access token is never handed out.
   */
  async createUploadSession(options: UploadSessionOptions): Promise<UploadSession> {
    const folder = options.folder ?? "media";
    const id = newBlobId(options.name);
    const uploadUrl = await this.startSession(id, { ...options, folder });
    await this.o.index.put({
      id, backend: "gdrive", remoteId: null, name: options.name, size: options.size, contentType: options.contentType, folder,
      status: "pending", uploadUrl, localPath: null, createdAt: new Date(),
    });
    return { id, uploadUrl, chunkSize: this.o.chunkSize ?? DEFAULT_CHUNK_SIZE, backend: "gdrive", expiresAt: new Date(Date.now() + 7 * 86_400_000) };
  }

  /**
   * Confirms a direct upload with Drive itself rather than trusting the client:
   * a status query on the session (200/201 carries the file), or, if the session is
   * gone, a search for the file tagged with our id in `appProperties`.
   */
  async completeUpload(id: string): Promise<BlobInfo> {
    const row = await this.o.index.get(id);
    if (!row || row.backend !== "gdrive") throw new UploadIncompleteError(`no upload ${id}`);
    if (row.status === "ready") return toInfo(row);
    let file: { id: string; size?: string } | undefined;
    if (row.uploadUrl) {
      const res = await this.doFetch(row.uploadUrl, { method: "PUT", headers: { "content-range": `bytes */${row.size}`, "content-length": "0" } });
      if (res.status === 200 || res.status === 201) file = (await res.json()) as typeof file;
      else if (res.status === 308) {
        const received = Number(/bytes=\d+-(\d+)/.exec(res.headers.get("range") ?? "")?.[1] ?? -1) + 1;
        throw new UploadIncompleteError(`upload ${id} has ${received} of ${row.size} bytes`, received);
      } else await res.body?.cancel();
    }
    if (!file) {
      const query = `appProperties has { key='ccId' and value=${q(id)} } and trashed = false`;
      const found = await this.json<{ files: { id: string; size?: string }[] }>(
        `${DRIVE_API}/files?${new URLSearchParams({ q: query, spaces: "drive", fields: "files(id,size)", pageSize: "1" })}`,
      );
      file = found.files[0];
    }
    if (!file) throw new UploadIncompleteError(`upload ${id} has not reached Drive`);
    const size = Number(file.size ?? row.size);
    if (size !== row.size) throw new UploadIncompleteError(`upload ${id} is ${size} bytes, expected ${row.size}`, size);
    await this.o.index.update(id, { status: "ready", remoteId: file.id, uploadUrl: null });
    return toInfo({ ...row, status: "ready", remoteId: file.id });
  }

  /** Drive storage quota (bytes; `limit` is absent on unlimited plans). */
  async quota(): Promise<{ limit: number | null; usage: number; usageInDrive: number }> {
    const about = await this.json<{ storageQuota: { limit?: string; usage?: string; usageInDrive?: string } }>(`${DRIVE_API}/about?fields=storageQuota`);
    const s = about.storageQuota;
    return { limit: s.limit ? Number(s.limit) : null, usage: Number(s.usage ?? 0), usageInDrive: Number(s.usageInDrive ?? 0) };
  }
}

