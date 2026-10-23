import type { AdapterContext, MediaRef } from "../../types";
import { redact, YOUTUBE_UPLOAD_API, YouTubeApiError, type YouTubeClient, type YouTubeCredentials } from "./client";

/**
 * Resumable video upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
 *
 * 1. `POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with the video
 *    resource as JSON and `X-Upload-Content-Type` / `X-Upload-Content-Length`. The session URI
 *    comes back in `Location`.
 * 2. `PUT <session>` per chunk with `Content-Range: bytes FIRST-LAST/TOTAL`. Chunks are a multiple
 *    of 256 KiB (except the last). `308 Resume Incomplete` + `Range: bytes=0-N` says what arrived;
 *    the final chunk returns `200`/`201` with the video resource.
 * 3. On 500/502/503/504 or a dropped connection, ask for the status (`PUT` with
 *    `Content-Range: bytes * /TOTAL` and no body) and resume from the byte after `Range`.
 *
 * The video is streamed from the media host: only the current chunk is held in memory. When the
 * host doesn't send a Content-Length, the total is sent as `*` until the last chunk.
 */

export const CHUNK_UNIT = 256 * 1024;
/** 8 MiB: Google recommends large chunks; this keeps memory use small. */
export const DEFAULT_CHUNK_BYTES = 32 * CHUNK_UNIT;
const MAX_RETRIES = 5;
/** A single chunk PUT may take a while on a slow link. */
const CHUNK_TIMEOUT_MS = 10 * 60_000;
const RETRY_STATUSES = new Set([500, 502, 503, 504]);

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

/** Reads a byte stream in pieces of a requested size; only the piece being built is buffered. */
export class ChunkReader {
  private carry: Uint8Array = new Uint8Array(0);
  private done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Up to `n` bytes; fewer only at the end of the stream. */
  async read(n: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let have = 0;
    if (this.carry.byteLength) {
      const take = this.carry.subarray(0, n);
      parts.push(take);
      have = take.byteLength;
      this.carry = this.carry.subarray(take.byteLength);
    }
    while (have < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (!value?.byteLength) continue;
      const need = n - have;
      if (value.byteLength > need) {
        parts.push(value.subarray(0, need));
        this.carry = value.subarray(need);
        have = n;
      } else {
        parts.push(value);
        have += value.byteLength;
      }
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(have);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  get ended(): boolean {
    return this.done && this.carry.byteLength === 0;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

const EXT_TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv", "3gp": "video/3gpp", mpg: "video/mpeg", mpeg: "video/mpeg",
};

function videoMime(url: string, header: string | null): string {
  const h = header?.split(";")[0]?.trim().toLowerCase();
  if (h && (h.startsWith("video/") || h === "application/octet-stream")) return h;
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

export interface UploadDeps {
  client: YouTubeClient;
  chunkBytes: number;
  sleep: Sleep;
}

export interface UploadedVideo {
  id: string;
  status?: { uploadStatus?: string; privacyStatus?: string; rejectionReason?: string; failureReason?: string; publishAt?: string };
  snippet?: { title?: string };
}

/** Downloads `media` from its URL and uploads it as a new video with `resource` (snippet/status). */
export async function uploadVideo(
  deps: UploadDeps,
  ctx: AdapterContext,
  c: YouTubeCredentials,
  media: MediaRef,
  resource: unknown,
  query: Record<string, string | undefined> = {},
): Promise<UploadedVideo> {
  const { client } = deps;
  const secrets = () => client.secrets(c);
  let src: Response;
  try {
    src = await ctx.fetch(media.url, { signal: ctx.signal });
  } catch (err) {
    throw new Error(`Couldn't download the video for YouTube from the media host: ${(err as Error).message}`);
  }
  if (!src.ok || !src.body) {
    await src.body?.cancel().catch(() => {});
    throw new Error(`Couldn't download the video for YouTube: the media host answered ${src.status}`);
  }
  const mime = videoMime(media.url, src.headers.get("content-type"));
  const lengthHeader = src.headers.get("content-encoding") ? null : src.headers.get("content-length");
  const total = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
  if (total === 0) {
    await src.body.cancel().catch(() => {});
    throw new Error("The video file on the media host is empty");
  }
  const reader = new ChunkReader(src.body.getReader());

  try {
    // 1. Start the session.
    const init = await client.raw(ctx, c, "POST", `${YOUTUBE_UPLOAD_API}/videos`, "start the video upload", {
      query: { uploadType: "resumable", part: "snippet,status", ...query },
      json: resource,
      headers: { "X-Upload-Content-Type": mime, ...(total !== undefined ? { "X-Upload-Content-Length": String(total) } : {}) },
    });
    await init.body?.cancel().catch(() => {});
    const session = init.headers.get("location");
    if (!session) throw new YouTubeApiError("YouTube started the upload but sent no session URI", "server", init.status);

    // 2. Send chunks. `pending` holds the bytes from `offset` that YouTube hasn't confirmed yet.
    let offset = 0;
    let pending: Uint8Array = new Uint8Array(0);
    let retries = 0;
    for (;;) {
      if (pending.byteLength < deps.chunkBytes && !reader.ended) {
        const more = await reader.read(deps.chunkBytes - pending.byteLength);
        if (more.byteLength) pending = pending.byteLength ? concat(pending, more) : more;
      }
      const last = reader.ended;
      const size = last ? offset + pending.byteLength : total;
      if (total !== undefined && offset + pending.byteLength > total) {
        throw new Error("The media host sent more bytes than its Content-Length; upload aborted");
      }
      if (last && total !== undefined && size !== total) {
        throw new Error(`The media host sent ${size} bytes but announced ${total}; upload aborted`);
      }
      const range = pending.byteLength
        ? `bytes ${offset}-${offset + pending.byteLength - 1}/${size ?? "*"}`
        : `bytes */${size ?? "*"}`;

      let res: Response;
      try {
        res = await client.raw(
          ctx,
          c,
          "PUT",
          session,
          "upload the video",
          { body: pending as unknown as NonNullable<RequestInit["body"]>, headers: { "Content-Type": mime, "Content-Range": range }, timeoutMs: CHUNK_TIMEOUT_MS },
          [308],
        );
      } catch (err) {
        if (!retryable(err) || retries >= MAX_RETRIES) throw explainUploadError(err, secrets());
        retries++;
        await deps.sleep(Math.min(32_000, 1000 * 2 ** (retries - 1)), ctx.signal);
        const status = await queryStatus(deps, ctx, c, session, total, secrets);
        if (status.video) return status.video;
        ({ offset, pending } = advance(offset, pending, status.received));
        continue;
      }

      if (res.status === 308) {
        await res.body?.cancel().catch(() => {});
        const received = receivedFrom(res.headers.get("range"));
        if (received < offset) throw new YouTubeApiError("YouTube lost part of the upload; start it again", "server", 308);
        ({ offset, pending } = advance(offset, pending, received));
        retries = 0;
        if (last && !pending.byteLength && range.startsWith("bytes */")) {
          throw new YouTubeApiError("YouTube didn't accept the end of the upload; start it again", "server", 308);
        }
        // With the stream finished and nothing left, the next round sends `bytes */N` to close it.
        continue;
      }
      const video = (await res.json().catch(() => null)) as UploadedVideo | null;
      if (!video?.id) throw new YouTubeApiError("YouTube finished the upload but returned no video id", "server", res.status);
      return video;
    }
  } finally {
    await reader.cancel();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Drop the bytes YouTube confirmed (everything before `received`). */
function advance(offset: number, pending: Uint8Array, received: number): { offset: number; pending: Uint8Array } {
  if (received < offset) throw new YouTubeApiError("YouTube lost part of the upload; start it again", "server");
  const drop = Math.min(received - offset, pending.byteLength);
  return { offset: offset + drop, pending: pending.subarray(drop) };
}

/** `Range: bytes=0-999` -> 1000 bytes received; no header -> 0. */
function receivedFrom(range: string | null): number {
  const m = range ? /bytes=\d+-(\d+)/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

function retryable(err: unknown): boolean {
  if (!(err instanceof YouTubeApiError)) return false;
  return err.kind === "network" || (err.status !== undefined && RETRY_STATUSES.has(err.status));
}

function explainUploadError(err: unknown, secrets: string[]): unknown {
  if (err instanceof YouTubeApiError && err.status === 404) {
    return new YouTubeApiError(redact("The YouTube upload session expired; start the upload again", secrets), "not_found", 404, err.reason);
  }
  return err;
}

async function queryStatus(
  deps: UploadDeps,
  ctx: AdapterContext,
  c: YouTubeCredentials,
  session: string,
  total: number | undefined,
  secrets: () => string[],
): Promise<{ received: number; video?: UploadedVideo }> {
  let res: Response;
  try {
    res = await deps.client.raw(
      ctx,
      c,
      "PUT",
      session,
      "check the upload status",
      { headers: { "Content-Range": `bytes */${total ?? "*"}` } },
      [308],
    );
  } catch (err) {
    throw explainUploadError(err, secrets());
  }
  if (res.status === 308) {
    await res.body?.cancel().catch(() => {});
    return { received: receivedFrom(res.headers.get("range")) };
  }
  const video = (await res.json().catch(() => null)) as UploadedVideo | null;
  if (!video?.id) throw new YouTubeApiError("YouTube reported the upload finished but returned no video id", "server", res.status);
  return { received: Number.POSITIVE_INFINITY, video };
}
