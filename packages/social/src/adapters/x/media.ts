import type { AdapterContext, MediaRef } from "../../types";
import type { XClient } from "./client";
import { XApiError } from "./errors";

/**
 * Media upload with the v2 endpoints (https://docs.x.com/x-api/media/quickstart/media-upload-chunked):
 *
 * - still images: one `POST /2/media/upload` (multipart: `media`, `media_category=tweet_image`);
 * - GIFs and video: `POST /2/media/upload/initialize` (JSON), `POST /2/media/upload/{id}/append`
 *   (multipart, `segment_index` from 0, segments ≤ 5 MB), `POST /2/media/upload/{id}/finalize`,
 *   then `GET /2/media/upload?command=STATUS&media_id=…` until `processing_info.state` is
 *   `succeeded` or `failed`;
 * - alt text: `POST /2/media/metadata` with `{ id, metadata: { alt_text: { text } } }` (≤ 1000 chars).
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_GIF_BYTES = 15 * 1024 * 1024;
/** X allows up to 512 MB for a normal account; we hold the file in memory, so keep a sane cap. */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ALT_TEXT = 1000;
/** Give up waiting for X to process a video after this long. */
const MAX_PROCESSING_MS = 10 * 60_000;

interface UploadData {
  data?: {
    id?: string;
    processing_info?: { state?: "pending" | "in_progress" | "succeeded" | "failed"; check_after_secs?: number; error?: { message?: string } };
  };
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4",
};

function mimeFor(ref: MediaRef, header: string | null): string {
  const fromHeader = header?.split(";")[0]?.trim().toLowerCase();
  if (fromHeader && fromHeader !== "application/octet-stream") return fromHeader;
  const ext = new URL(ref.url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? (ref.type === "video" ? "video/mp4" : "image/jpeg");
}

async function download(ref: MediaRef, ctx: AdapterContext): Promise<{ bytes: Uint8Array; mime: string }> {
  let res: Response;
  try {
    res = await ctx.fetch(ref.url, { signal: ctx.signal });
  } catch (err) {
    throw new Error(`Couldn't download media for X from the media host: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`Couldn't download media for X: the media host answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mime: mimeFor(ref, res.headers.get("content-type")) };
}

export async function uploadMedia(
  client: XClient,
  ref: MediaRef,
  ctx: AdapterContext,
  sleep: Sleep,
): Promise<string> {
  const { bytes, mime } = await download(ref, ctx);
  const isGif = mime === "image/gif";
  const isVideo = ref.type === "video" || mime.startsWith("video/");
  const limit = isVideo ? MAX_VIDEO_BYTES : isGif ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength > limit) {
    throw new Error(`Media is too large for X: ${(bytes.byteLength / 1048576).toFixed(1)} MB (limit ${limit / 1048576} MB)`);
  }

  let id: string;
  if (!isVideo && !isGif) {
    const form = new FormData();
    form.set("media", new Blob([new Uint8Array(bytes)], { type: mime }), "image");
    form.set("media_category", "tweet_image");
    const res = await client.request<UploadData>("POST", "/2/media/upload", "upload an image", { multipart: form });
    id = requireId(res);
    await waitForProcessing(client, id, res, ctx, sleep);
  } else {
    id = await chunkedUpload(client, bytes, mime, isVideo ? "tweet_video" : "tweet_gif", ctx, sleep);
  }

  if (ref.alt?.trim() && !isVideo) {
    await client.request("POST", "/2/media/metadata", "add alt text to an image", {
      json: { id, metadata: { alt_text: { text: ref.alt.trim().slice(0, MAX_ALT_TEXT) } } },
    });
  }
  return id;
}

function requireId(res: UploadData): string {
  const id = res.data?.id;
  if (!id) throw new XApiError("X accepted the media upload but returned no media id", 200);
  return id;
}

async function chunkedUpload(
  client: XClient,
  bytes: Uint8Array,
  mime: string,
  category: "tweet_video" | "tweet_gif",
  ctx: AdapterContext,
  sleep: Sleep,
): Promise<string> {
  const what = category === "tweet_video" ? "upload a video" : "upload a GIF";
  const init = await client.request<UploadData>("POST", "/2/media/upload/initialize", what, {
    json: { media_type: mime, total_bytes: bytes.byteLength, media_category: category },
  });
  const id = requireId(init);
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, index++) {
    const form = new FormData();
    form.set("segment_index", String(index));
    form.set("media", new Blob([new Uint8Array(bytes.subarray(offset, offset + CHUNK_BYTES))], { type: mime }), "chunk");
    await client.request("POST", `/2/media/upload/${id}/append`, what, { multipart: form });
  }
  const fin = await client.request<UploadData>("POST", `/2/media/upload/${id}/finalize`, what);
  await waitForProcessing(client, id, fin, ctx, sleep);
  return id;
}

async function waitForProcessing(
  client: XClient,
  id: string,
  first: UploadData,
  ctx: AdapterContext,
  sleep: Sleep,
): Promise<void> {
  let info = first.data?.processing_info;
  const started = ctx.now().getTime();
  let waited = 0;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") {
      throw new XApiError(`X couldn't process the media: ${info.error?.message ?? "processing failed"}`, 200);
    }
    const delay = Math.max(1, info.check_after_secs ?? 2) * 1000;
    waited += delay;
    if (waited > MAX_PROCESSING_MS || ctx.now().getTime() - started > MAX_PROCESSING_MS) {
      throw new XApiError("X is taking too long to process the media; try again later", 200);
    }
    await sleep(delay, ctx.signal);
    const status = await client.request<UploadData>("GET", "/2/media/upload", "check media processing", undefined, {
      command: "STATUS",
      media_id: id,
    });
    info = status.data?.processing_info;
  }
}
