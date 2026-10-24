import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { uploadResumable } from "@cc/storage";

/**
 * Uploads job output to Command Centre storage (Google Drive or the server's
 * volume, whichever the server uses) without going through the job result.
 *
 *   const { url, id } = await ctx.storage!.uploadFile(outputPath, { folder: "renders" });
 *
 * 1. POST /api/worker/storage/upload-session (Bearer WORKER_TOKEN) → {id, uploadUrl, chunkSize}.
 * 2. PUT the file to `uploadUrl` in chunks (Google's resumable protocol), resuming after
 *    dropped connections and 5xx from the byte the server confirmed. The worker
 *    token is only ever sent to our server, never to `uploadUrl`.
 * 3. POST /api/worker/storage/complete → the file, with its public `/media/...` URL
 *    when it is an image or video (null for other types).
 */
export interface UploadedFile {
  id: string;
  /** Public https URL on our domain (`/media/<id>`), or null if the type isn't served there. */
  url: string | null;
  size: number;
  contentType: string;
  folder: string;
}

export interface UploadFileOptions {
  /** Defaults to the file's name. */
  name?: string;
  /** Defaults to a guess from the extension. */
  contentType?: string;
  /** renders (default), media, footage or assets. */
  folder?: "renders" | "media" | "footage" | "assets";
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface StorageUploader {
  uploadFile(path: string, options?: UploadFileOptions): Promise<UploadedFile>;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
};

export const guessContentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** `wss://cc.example.com/ws` (or an https URL) → `https://cc.example.com`. */
export function toHttpUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "").replace(/\/$/, "");
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function createStorageUploader(options: { serverUrl: string; token: string; fetch?: typeof fetch; retries?: number; backoff?: (attempt: number) => number }): StorageUploader {
  const base = toHttpUrl(options.serverUrl);
  const doFetch = options.fetch ?? fetch;
  const call = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`storage ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };

  return {
    async uploadFile(path, o = {}) {
      const { size } = await stat(path);
      const name = o.name ?? basename(path);
      const contentType = o.contentType ?? guessContentType(name);
      const session = await call<{ id: string; uploadUrl: string; chunkSize: number }>(
        "/api/worker/storage/upload-session",
        { name, contentType, size, folder: o.folder ?? "renders" },
        o.signal,
      );
      const file = await open(path, "r");
      try {
        await uploadResumable({
          uploadUrl: session.uploadUrl,
          size,
          chunkSize: session.chunkSize,
          fetch: doFetch,
          retries: options.retries,
          backoff: options.backoff,
          signal: o.signal,
          onProgress: (sent, total) => o.onProgress?.(total ? sent / total : 0),
          readChunk: async (start, length) => {
            const buf = Buffer.alloc(length);
            const { bytesRead } = await file.read(buf, 0, length, start);
            return buf.subarray(0, bytesRead);
          },
        });
      } finally {
        await file.close();
      }
      return call<UploadedFile>("/api/worker/storage/complete", { id: session.id }, o.signal);
    },
  };
}
