import { FOLDERS, type BlobInfo, type Storage, UploadIncompleteError } from "@cc/storage";
import { Readable, Transform } from "node:stream";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { bearer } from "../auth";
import type { WorkerAuth } from "./ws";
import { MEDIA_FILE, publicOrigin } from "./social";

export interface StorageApiDeps {
  storage: Storage;
  publicBaseUrl?: string;
  /** Largest direct upload accepted. */
  uploadMaxBytes: number;
  /** Worker credentials: a linked desktop app's token, or WORKER_TOKEN / ADMIN_TOKEN (see ./ws.ts). */
  workerAuth: WorkerAuth;
  /**
   * Why an upload of this many bytes (0: not known yet) can't be taken, or null. The server
   * refuses uploads that would fill its own volume (./storage-housekeeping.ts).
   */
  refuseUpload?: (bytes: number) => Promise<string | null>;
  /** The server volume's free and total bytes and the housekeeping limits, for the Storage page. */
  volume?: () => Promise<{ free: number; total: number; minFreeBytes: number; renderRetentionDays: number } | null>;
}

/** 507 Insufficient Storage when the volume can't take the upload. */
async function full(c: Context, deps: StorageApiDeps, bytes: number) {
  const why = await deps.refuseUpload?.(bytes);
  return why ? c.json({ error: why }, 507) : null;
}

const declaredLength = (c: Context) => {
  const n = Number(c.req.header("content-length"));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const SessionRequest = z.object({
  name: z.string().trim().min(1).max(255),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, "a MIME type like video/mp4").toLowerCase(),
  size: z.number().int().positive(),
  folder: z.enum(FOLDERS).default("media"),
});
const Complete = z.object({ id: z.string().regex(/^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/) });

/** The public /media URL for a blob, when its extension is one /media serves. */
function publicUrl(c: Context, deps: StorageApiDeps, id: string): string | null {
  return MEDIA_FILE.test(id) ? `${publicOrigin(c, deps.publicBaseUrl)}/media/${id}` : null;
}

const withUrl = (c: Context, deps: StorageApiDeps, info: BlobInfo) => ({ ...info, url: publicUrl(c, deps, info.id) });

async function createSession(c: Context, deps: StorageApiDeps, folders: readonly string[]) {
  const body = SessionRequest.parse(await c.req.json());
  if (!folders.includes(body.folder)) return c.json({ error: `folder must be one of ${folders.join(", ")}` }, 400);
  if (body.size > deps.uploadMaxBytes) return c.json({ error: `file is larger than ${Math.round(deps.uploadMaxBytes / 1024 / 1024)} MB` }, 413);
  const refused = await full(c, deps, body.size);
  if (refused) return refused;
  const session = await deps.storage.createUploadSession({
    ...body,
    origin: c.req.header("origin") || undefined,
    baseUrl: `${publicOrigin(c, deps.publicBaseUrl)}/api/storage/uploads`,
  });
  return c.json({ ...session, url: publicUrl(c, deps, session.id), completeWith: { id: session.id } }, 201);
}

async function complete(c: Context, deps: StorageApiDeps) {
  const { id } = Complete.parse(await c.req.json());
  try {
    return c.json(withUrl(c, deps, await deps.storage.completeUpload(id)));
  } catch (err) {
    if (err instanceof UploadIncompleteError) return c.json({ error: err.message, received: err.received ?? null }, 409);
    throw err;
  }
}

/**
 * Admin API (mounted under /api, after the session/admin check):
 * direct-upload sessions, completion, the file list with usage, delete, and migration to Drive.
 */
export function storageApiRoutes(deps: StorageApiDeps) {
  const { storage } = deps;
  const app = new Hono();

  /** A URL to PUT the file to in chunks (Drive's resumable session URI, or our own chunk endpoint). */
  app.post("/storage/upload-session", (c) => createSession(c, deps, FOLDERS));
  app.post("/storage/complete", (c) => complete(c, deps));

  app.get("/storage", async (c) => {
    const folder = z.enum(FOLDERS).optional().parse(c.req.query("folder") || undefined);
    const limit = z.coerce.number().int().min(1).max(1000).default(200).parse(c.req.query("limit"));
    const files = await storage.list(folder, { limit });
    return c.json({ ...(await storage.usage()), volume: (await deps.volume?.()) ?? null, files: files.map((f) => withUrl(c, deps, f)) });
  });

  app.delete("/storage/:id", async (c) => {
    const id = c.req.param("id");
    return (await storage.delete(id)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /** Copies local files into Drive (same ids, same URLs). `deleteLocal` frees the volume afterwards. */
  app.post("/storage/migrate", async (c) => {
    if (!storage.drive) return c.json({ error: "set STORAGE_BACKEND=gdrive first" }, 409);
    const body = z.object({ deleteLocal: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await storage.migrateToDrive({ deleteLocal: body.deleteLocal, log: (l) => console.log(`[storage] ${l}`) }));
  });

  return app;
}

/** Folders a worker may upload into (outputs only: it can't list, read or delete). */
const WORKER_FOLDERS = ["renders", "media", "footage", "assets"] as const;

/**
 * Routes with their own credentials, mounted before the /api auth middleware:
 * - `/api/worker/storage/{upload-session,complete}`: `Authorization: Bearer <worker token>` (a linked desktop app's own token, or WORKER_TOKEN).
 * - `/api/storage/uploads/:id?key=…`: the local backend's chunk endpoint. The key in
 *   the URL is the credential for that one upload, like Drive's session URI.
 */
export function storagePublicRoutes(deps: StorageApiDeps) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof UploadIncompleteError) return c.json({ error: err.message }, 400);
    // Unauthenticated routes: the detail (paths, backend errors) stays in the log.
    console.error("[storage]", err);
    return c.json({ error: "internal error" }, 500);
  });

  const worker = new Hono();
  worker.use("*", async (c, next) => {
    if (!(await deps.workerAuth(bearer(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  worker.post("/upload-session", (c) => createSession(c, deps, WORKER_FOLDERS));
  worker.post("/complete", (c) => complete(c, deps));
  app.route("/worker/storage", worker);

  app.put("/storage/uploads/:id", async (c) => {
    const row = await deps.storage.local.pendingUpload(c.req.param("id"), c.req.query("key") ?? "");
    if (!row) return c.json({ error: "not found" }, 404);
    // The session was checked for the whole file; a chunk is refused only if the disk filled up since.
    const refused = await full(c, deps, declaredLength(c));
    if (refused) return refused;
    // One chunk at a time: they all append to the same partial file.
    if (!(await deps.storage.index.transition(row.id, "pending", "uploading"))) return c.json({ error: "another request for this upload is in progress" }, 409);
    let out: Awaited<ReturnType<typeof deps.storage.local.receiveChunk>>;
    try {
      out = await deps.storage.local.receiveChunk(row, c.req.header("content-range"), c.req.raw.body);
    } finally {
      await deps.storage.index.transition(row.id, "uploading", "pending");
    }
    if (out.done) return c.json(withUrl(c, deps, out.info), 201);
    return c.body(null, 308, out.received > 0 ? { range: `bytes=0-${out.received - 1}` } : {});
  });

  /** One-shot whole-file PUT for a reservation (video jobs), streamed into the configured backend. */
  app.put("/storage/put/:id", async (c) => {
    const id = c.req.param("id");
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);
    const refused = await full(c, deps, declaredLength(c));
    if (refused) return refused;
    const r = await deps.storage.claimReservation(id, c.req.query("key") ?? "");
    if (!r) return c.json({ error: "not found" }, 404);
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _e, done) {
        seen += chunk.length;
        done(seen > deps.uploadMaxBytes ? new Error("too large") : null, chunk);
      },
    });
    const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
    limit.on("error", () => source.destroy());
    source.on("error", (err) => limit.destroy(err)); // a broken request body fails the upload instead of hanging it
    try {
      const info = await deps.storage.put(source.pipe(limit), { id, ...r });
      return c.json(withUrl(c, deps, info), 201);
    } catch (err) {
      await deps.storage.releaseReservation(id);
      throw err;
    }
  });

  return app;
}
