import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

/** Where a blob's bytes live. */
export type BackendKind = "local" | "gdrive";

/**
 * Logical folders. On Drive they are subfolders of the "Command Centre" folder;
 * locally `media` is `DATA_DIR/media` (as before) and the others `DATA_DIR/storage/<folder>`.
 */
export const FOLDERS = ["media", "renders", "footage", "attachments", "assets"] as const;
export type Folder = (typeof FOLDERS)[number];
export const isFolder = (f: unknown): f is Folder => typeof f === "string" && (FOLDERS as readonly string[]).includes(f);

/** Public blob id: 32 hex characters (128 random bits) plus an optional short extension, e.g. `3f…a9.mp4`. */
export const BLOB_ID = /^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/;
export const isBlobId = (id: string) => BLOB_ID.test(id);

/** A fresh unguessable id; the extension comes from `name` (lower-cased, only if it is short and plain). */
export function newBlobId(name?: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? "")?.[1]?.toLowerCase();
  return `${randomBytes(16).toString("hex")}${ext ? `.${ext}` : ""}`;
}

export interface BlobInfo {
  id: string;
  name: string;
  size: number;
  contentType: string;
  folder: Folder;
  backend: BackendKind;
  createdAt: Date;
}

/** Inclusive byte range, as in HTTP: bytes start..end. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface BlobBody {
  stream: Readable;
  /** Size of the whole blob (not of the range). */
  size: number;
  contentType: string;
  range?: ByteRange;
}

/** Anything put() can read: a buffer, a Node stream or a web stream. */
export type BlobSource = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface PutOptions {
  name: string;
  contentType: string;
  folder?: Folder;
  /** Use this id instead of a fresh one (migration keeps ids stable). */
  id?: string;
  /** Known size, if any; streams of unknown length are fine. */
  size?: number;
}

/**
 * A direct upload: the client PUTs the bytes to `uploadUrl` in chunks using
 * Google's resumable protocol (Content-Range, 308 + Range, `bytes * /total` status
 * queries), then the server's `complete(id)` registers the file. The local
 * backend speaks the same protocol on our own server, so one client fits both.
 */
export interface UploadSession {
  id: string;
  uploadUrl: string;
  /** Send chunks of this size (a multiple of 256 KiB); only the last may be smaller. */
  chunkSize: number;
  backend: BackendKind;
  expiresAt: Date;
}

export interface UploadSessionOptions {
  name: string;
  contentType: string;
  size: number;
  folder?: Folder;
  /** The browser origin that will upload (Drive needs it for CORS on the session URI). */
  origin?: string;
}

export interface BlobStore {
  readonly kind: BackendKind;
  put(source: BlobSource, options: PutOptions): Promise<BlobInfo>;
  /** null when the id is unknown. */
  get(id: string, options?: { range?: ByteRange }): Promise<BlobBody | null>;
  head(id: string): Promise<BlobInfo | null>;
  /** true when something was deleted. */
  delete(id: string): Promise<boolean>;
  list(folder?: Folder, options?: { limit?: number }): Promise<BlobInfo[]>;
  createUploadSession(options: UploadSessionOptions): Promise<UploadSession>;
  /** Registers a finished direct upload; throws UploadIncompleteError if bytes are missing. */
  completeUpload(id: string): Promise<BlobInfo>;
}

export class BlobNotFoundError extends Error {
  constructor(id: string) {
    super(`no such blob ${id}`);
  }
}

export class UploadIncompleteError extends Error {
  constructor(
    message: string,
    readonly received?: number,
  ) {
    super(message);
  }
}

/** Resumable uploads send chunks in multiples of this (Drive API v3, "Upload file data"). */
export const CHUNK_UNIT = 256 * 1024;
/** Default chunk: 8 MiB, 32 × 256 KiB. */
export const DEFAULT_CHUNK_SIZE = 32 * CHUNK_UNIT;
