import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AdapterMap,
  CampaignPayload,
  campaignSummary,
  publicAccount,
  type ScheduledPostStatus,
  type SocialAccount,
} from "@cc/social";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ActionService } from "../actions";
import type { Store } from "../db/store";

/** Upload types: content type → extension. The extension decides the type served back. */
const MEDIA_TYPES: Record<string, { ext: string; kind: "image" | "video" }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
};
const BY_EXT = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([type, m]) => [m.ext, type]));
/** 32 hex characters (128 random bits) plus a known extension; nothing else is ever served. */
const MEDIA_FILE = new RegExp(`^[a-f0-9]{32}\\.(${Object.keys(BY_EXT).join("|")})$`);

export interface SocialApiDeps {
  store: Store;
  actions: ActionService;
  accounts: SocialAccount[];
  adapters: AdapterMap;
  timeZone: string;
  media: { dir: string; maxBytes: number; publicBaseUrl?: string };
}

class TooLarge extends Error {}

/** The server's public origin: PUBLIC_BASE_URL, else what the request (or its proxy) says. */
function publicOrigin(c: Context, configured?: string): string {
  if (configured) return configured;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (host) return `${proto ?? new URL(c.req.url).protocol.replace(":", "")}://${host}`;
  return new URL(c.req.url).origin;
}

/**
 * Admin API for the Social page (mounted under /api, after the admin check):
 * accounts, recent events, scheduled posts, the composer, and media uploads.
 */
export function socialApiRoutes(deps: SocialApiDeps) {
  const { store, actions, accounts, adapters } = deps;
  const app = new Hono();

  app.get("/social/accounts", (c) => c.json(accounts.map((a) => publicAccount(a, adapters))));

  app.get("/social/events", async (c) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(c.req.query("limit"));
    return c.json(await store.listSocialEvents(limit));
  });

  app.get("/social/scheduled", async (c) => {
    const status = c.req.query("status") as ScheduledPostStatus | undefined;
    return c.json(await store.listScheduledPosts({ status: status || undefined }));
  });

  app.post("/social/scheduled/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success || !(await store.getScheduledPost(id))) return c.json({ error: "not found" }, 404);
    const post = await store.cancelScheduledPost(id);
    return post ? c.json(post) : c.json({ error: "only a post that is still scheduled can be cancelled" }, 409);
  });

  /** The composer: one social.campaign proposal, made with the admin's authority, waiting under Approvals. */
  app.post("/social/compose", async (c) => {
    const body = CampaignPayload.extend({ summary: z.string().trim().min(1).optional() }).parse(await c.req.json());
    const verticals = new Set<string>();
    for (const post of body.posts) {
      const account = accounts.find((a) => a.id === post.accountId);
      if (!account) return c.json({ error: `Unknown social account "${post.accountId}"` }, 400);
      verticals.add(account.vertical);
    }
    if (verticals.size > 1) return c.json({ error: "All posts in one campaign must be for accounts of the same vertical" }, 400);
    const { summary, ...payload } = body;
    try {
      const proposal = await actions.propose({
        taskId: null,
        vertical: [...verticals][0]!,
        actionType: "social.campaign",
        summary: summary ?? campaignSummary(payload, accounts, deps.timeZone),
        payload,
      });
      return c.json(proposal, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /**
   * Upload an image or video, as multipart (field "file") or a raw body with its
   * content type. Returns a public, unguessable URL platforms can fetch.
   */
  app.post("/media", async (c) => {
    const { dir, maxBytes } = deps.media;
    const tooLarge = () => c.json({ error: `file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB` }, 413);
    const declared = Number(c.req.header("content-length"));
    // Multipart adds a little framing around the file.
    if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) return tooLarge();

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    await mkdir(dir, { recursive: true });
    const id = randomBytes(16).toString("hex");

    let type: string;
    let media: (typeof MEDIA_TYPES)[string] | undefined;
    let bytes: number;
    let path: string;
    if (contentType === "multipart/form-data") {
      const form = await c.req.formData();
      const upload = form.get("file");
      if (!(upload instanceof File)) return c.json({ error: 'multipart upload needs a "file" field' }, 400);
      type = upload.type.split(";")[0]!.trim().toLowerCase();
      media = MEDIA_TYPES[type];
      if (!media) return c.json({ error: unsupported(type) }, 415);
      if (upload.size > maxBytes) return tooLarge();
      path = join(dir, `${id}.${media.ext}`);
      await writeFile(`${path}.part`, Buffer.from(await upload.arrayBuffer()));
      bytes = upload.size;
    } else {
      type = contentType;
      media = MEDIA_TYPES[type];
      if (!media) return c.json({ error: unsupported(type) }, 415);
      const body = c.req.raw.body;
      if (!body) return c.json({ error: "empty body" }, 400);
      path = join(dir, `${id}.${media.ext}`);
      bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          done(bytes > maxBytes ? new TooLarge() : null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), limit, createWriteStream(`${path}.part`));
      } catch (err) {
        await rm(`${path}.part`, { force: true });
        if (err instanceof TooLarge) return tooLarge();
        throw err;
      }
    }
    if (bytes === 0) {
      await rm(`${path}.part`, { force: true });
      return c.json({ error: "empty file" }, 400);
    }
    await rename(`${path}.part`, path);
    const file = `${id}.${media.ext}`;
    return c.json(
      { id: file, url: `${publicOrigin(c, deps.media.publicBaseUrl)}/media/${file}`, type: media.kind, contentType: type, bytes },
      201,
    );
  });

  return app;
}

const unsupported = (type: string) =>
  `unsupported media type ${type || "(none)"}; use one of ${Object.keys(MEDIA_TYPES).join(", ")}`;

/**
 * Public, unauthenticated media at /media/<id>.<ext>. Only exact random-id
 * file names are served (no listing, no paths), with byte ranges for video.
 */
export function mediaRoutes(dir: string) {
  const app = new Hono();
  app.get("/:file", async (c) => {
    const file = c.req.param("file");
    if (!MEDIA_FILE.test(file)) return c.text("not found", 404);
    const path = join(dir, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return c.text("not found", 404);

    const headers: Record<string, string> = {
      "content-type": BY_EXT[file.split(".").pop()!]!,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };
    let start = 0;
    let end = info.size - 1;
    let status: 200 | 206 = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(0, info.size - Number(range[2]));
      }
      if (start > end || start >= info.size) {
        return c.body(null, 416, { "content-range": `bytes */${info.size}` });
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["content-length"] = String(end - start + 1);
    if (c.req.method === "HEAD") return c.body(null, status, headers);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return c.body(stream, status, headers);
  });
  return app;
}
