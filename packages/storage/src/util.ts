import { Readable, Transform } from "node:stream";
import type { BlobSource } from "./types";

export function toReadable(source: BlobSource): Readable {
  if (source instanceof Readable) return source;
  if (source instanceof Uint8Array) return Readable.from([Buffer.from(source.buffer, source.byteOffset, source.byteLength)]);
  return Readable.fromWeb(source as import("node:stream/web").ReadableStream<Uint8Array>);
}

/** Strips OAuth tokens, secrets and resumable upload ids from anything that may end up in a log or error. */
export function redact(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, "ya29.[redacted]")
    .replace(/1\/\/[\w.-]{20,}/g, "[redacted refresh token]")
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:access_token|refresh_token|client_secret|upload_id|key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|client_secret|id_token)"\s*:\s*")[^"]+"/gi, '$1[redacted]"');
}

/** Passes bytes start..end (inclusive) of a stream that begins at byte 0. */
export function sliceStream(start: number, end: number): Transform {
  let pos = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const from = Math.max(0, start - pos);
      const to = Math.min(chunk.length, end - pos + 1);
      pos += chunk.length;
      done(null, to > from ? chunk.subarray(from, to) : undefined);
    },
  });
}

/** Parses `Range: bytes=0-42` (a 308 reply) into the next byte to send. No header means nothing was stored. */
export function nextOffset(rangeHeader: string | null): number {
  const m = /bytes=(\d+)-(\d+)/.exec(rangeHeader ?? "");
  return m ? Number(m[2]) + 1 : 0;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google's recommended backoff: min(2^n s + random ms ≤ 1000, max). */
export function backoffMs(attempt: number, maxMs = 32_000, random = Math.random): number {
  return Math.min(2 ** attempt * 1000 + Math.floor(random() * 1000), maxMs);
}
