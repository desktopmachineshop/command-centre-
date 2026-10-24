import type { Readable } from "node:stream";
import { CHUNK_UNIT, DEFAULT_CHUNK_SIZE } from "./types";
import { backoffMs, nextOffset, redact, sleep } from "./util";

/**
 * Client side of Google's resumable upload protocol, which our local chunk
 * endpoint also speaks (Drive API v3, "Perform a resumable upload":
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable):
 *
 * - PUT each chunk to the session URI with `Content-Range: bytes a-b/total`
 *   (`/*` while the total is unknown). Chunks are multiples of 256 KiB except the last.
 * - `308 Resume Incomplete` + `Range: bytes=0-n` says what was stored; continue at n+1
 *   (never assume the whole chunk arrived).
 * - After a dropped connection, 5xx, 429 or rate-limit 403, ask with an empty PUT and
 *   `Content-Range: bytes * /total`, then resend from there, with exponential backoff.
 * - 200/201 means done and carries the file resource. 404/410: the session expired
 *   (they last a week) and the upload must start again.
 */
export interface ResumableOptions {
  uploadUrl: string;
  fetch?: typeof fetch;
  chunkSize?: number;
  /** Consecutive failures tolerated before giving up. */
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number | null) => void;
  /** Overridable for tests. */
  backoff?: (attempt: number) => number;
}

export class UploadSessionExpiredError extends Error {}
export class ResumableUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Outcome = { done: true; body: unknown } | { done: false; confirmed: number };

const retryable = (status: number, text: string) =>
  status >= 500 || status === 429 || (status === 403 && /rate ?limit/i.test(text));

class Sender {
  private readonly doFetch: typeof fetch;
  private failures = 0;
  constructor(private readonly o: ResumableOptions) {
    this.doFetch = o.fetch ?? fetch;
  }

  get chunkSize(): number {
    const size = this.o.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (size <= 0 || size % CHUNK_UNIT !== 0) throw new Error("chunkSize must be a positive multiple of 256 KiB");
    return size;
  }

  private async read(res: Response): Promise<Outcome | { retry: true }> {
    if (res.status === 200 || res.status === 201) {
      this.failures = 0;
      const text = await res.text();
      return { done: true, body: text ? JSON.parse(text) : {} };
    }
    if (res.status === 308) {
      this.failures = 0;
      await res.body?.cancel();
      return { done: false, confirmed: nextOffset(res.headers.get("range")) };
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404 || res.status === 410) throw new UploadSessionExpiredError("the upload session has expired; start a new one");
    if (retryable(res.status, text)) return { retry: true };
    throw new ResumableUploadError(`upload failed (${res.status}): ${redact(text).slice(0, 300)}`, res.status);
  }

  private async pause() {
    if (++this.failures > (this.o.retries ?? 6)) throw new ResumableUploadError("upload failed: too many errors in a row");
    await sleep((this.o.backoff ?? backoffMs)(this.failures - 1));
  }

  /** Sends one chunk; on a transient failure, asks the server what it has instead. */
  async send(start: number, chunk: Buffer, total: number | "*"): Promise<Outcome> {
    const end = start + chunk.length - 1;
    try {
      const res = await this.doFetch(this.o.uploadUrl, {
        method: "PUT",
        headers: { "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(chunk.length) },
        body: chunk as unknown as Uint8Array<ArrayBuffer>,
        signal: this.o.signal,
      });
      const out = await this.read(res);
      if (!("retry" in out)) return out;
    } catch (err) {
      if (this.o.signal?.aborted || err instanceof UploadSessionExpiredError || err instanceof ResumableUploadError) throw err;
    }
    await this.pause();
    return this.status(total);
  }

  /** `Content-Range: bytes * /total` with no body: how much has the server stored? */
  async status(total: number | "*"): Promise<Outcome> {
    for (;;) {
      try {
        const res = await this.doFetch(this.o.uploadUrl, {
          method: "PUT",
          headers: { "content-range": `bytes */${total}`, "content-length": "0" },
          signal: this.o.signal,
        });
        const out = await this.read(res);
        if (!("retry" in out)) return out;
      } catch (err) {
        if (this.o.signal?.aborted || err instanceof UploadSessionExpiredError || err instanceof ResumableUploadError) throw err;
      }
      await this.pause();
    }
  }
}

/**
 * Uploads `size` bytes read by `readChunk(start, length)` (e.g. from a file), so
 * any chunk can be re-read for a resume. Returns the final response body.
 */
export async function uploadResumable(
  options: ResumableOptions & { size: number; readChunk: (start: number, length: number) => Promise<Buffer> },
): Promise<unknown> {
  const sender = new Sender(options);
  const { size } = options;
  const chunkSize = sender.chunkSize;
  if (size === 0) {
    const out = await sender.status(0);
    if (out.done) return out.body;
    throw new ResumableUploadError("empty upload was not accepted");
  }
  let offset = 0;
  for (;;) {
    let out: Outcome;
    if (offset >= size) out = await sender.status(size);
    else {
      const chunk = await options.readChunk(offset, Math.min(chunkSize, size - offset));
      out = await sender.send(offset, chunk, size);
    }
    if (out.done) {
      options.onProgress?.(size, size);
      return out.body;
    }
    offset = out.confirmed;
    options.onProgress?.(offset, size);
  }
}

/**
 * Uploads a stream of unknown length, holding at most about one chunk in memory:
 * full chunks go out with total `*`, the last one with the real total.
 */
export async function uploadStreamResumable(source: Readable, options: ResumableOptions): Promise<{ body: unknown; size: number }> {
  const sender = new Sender(options);
  const chunkSize = sender.chunkSize;
  let confirmed = 0;
  let pieces: Buffer[] = [];
  let buffered = 0;
  const take = (): Buffer => {
    const all = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
    pieces = [all];
    return all;
  };
  const advance = (to: number) => {
    if (to < confirmed || to > confirmed + buffered) throw new ResumableUploadError("server reported an offset outside the bytes in flight; start again");
    const all = take().subarray(to - confirmed);
    pieces = [all];
    buffered = all.length;
    confirmed = to;
  };

  for await (const piece of source) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    pieces.push(buf);
    buffered += buf.length;
    while (buffered > chunkSize) {
      const out = await sender.send(confirmed, take().subarray(0, chunkSize), "*");
      if (out.done) throw new ResumableUploadError("server finished the upload before the stream ended");
      advance(out.confirmed);
      options.onProgress?.(confirmed, null);
    }
  }
  const total = confirmed + buffered;
  for (;;) {
    const out = buffered > 0 ? await sender.send(confirmed, take(), total) : await sender.status(total);
    if (out.done) {
      options.onProgress?.(total, total);
      return { body: out.body, size: total };
    }
    if (buffered === 0 && out.confirmed >= total) throw new ResumableUploadError("server has every byte but did not finish the upload");
    advance(out.confirmed);
  }
}
