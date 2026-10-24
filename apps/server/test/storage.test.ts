import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_UNIT, uploadResumable } from "@cc/storage";
import { FakeDrive } from "@cc/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const WORKER = "worker-token-for-tests-0123456789";
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 13 + 5) % 251));
const LEGACY = `${"b".repeat(32)}.mp4`;

type Ctx = Awaited<ReturnType<typeof makeServer>>;
/** fetch that sends our own URLs to the in-process app and Google's to the fake Drive. */
const router = (ctx: Ctx, drive?: FakeDrive) => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === "cc.test") return ctx.server.app.request(`${url.pathname}${url.search}`, init);
  return drive!.fetch(input, init);
}) as typeof fetch;

async function serveChecks(ctx: Ctx, path: string, data: Buffer, type: string) {
  const got = await ctx.server.app.request(path);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe(type);
  expect(got.headers.get("x-content-type-options")).toBe("nosniff");
  expect(got.headers.get("content-length")).toBe(String(data.length));
  expect(Buffer.from(await got.arrayBuffer())).toEqual(data);
  const part = await ctx.server.app.request(path, { headers: { range: "bytes=5-14" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 5-14/${data.length}`);
  expect(Buffer.from(await part.arrayBuffer())).toEqual(data.subarray(5, 15));
  const tail = await ctx.server.app.request(path, { headers: { range: "bytes=-4" } });
  expect(Buffer.from(await tail.arrayBuffer())).toEqual(data.subarray(-4));
  expect((await ctx.server.app.request(path, { headers: { range: `bytes=${data.length}-` } })).status).toBe(416);
}

describe.skipIf(!DB_URL)("storage on the local backend", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { PUBLIC_BASE_URL: "https://cc.test", WORKER_TOKEN: WORKER } });
  });
  afterAll(async () => ctx?.server.stop());

  it("serves media through the store with ranges and 404s", async () => {
    const data = bytes(64);
    const up = await ctx.api("/api/media", { method: "POST", headers: { "content-type": "image/webp" }, body: data });
    expect(up.status).toBe(201);
    await serveChecks(ctx, new URL(up.body.url).pathname, data, "image/webp");
    for (const p of [`/media/${"0".repeat(32)}.png`, "/media/x.png", `/media/${up.body.id.replace(".webp", ".png")}`]) {
      expect((await ctx.server.app.request(p)).status, p).toBe(404);
    }
  });

  it("direct uploads in chunks to our own endpoint, then complete; admin and worker paths", async () => {
    const data = bytes(CHUNK_UNIT + 77);
    // No auth, wrong worker token, worker folder outside its scope.
    const req = { name: "render.mp4", contentType: "video/mp4", size: data.length, folder: "renders" };
    expect((await ctx.server.app.request("/api/storage/upload-session", { method: "POST", body: JSON.stringify(req) })).status).toBe(401);
    const asWorker = (path: string, json: unknown, token = WORKER) =>
      ctx.api(path, { method: "POST", json, headers: { authorization: `Bearer ${token}` } });
    expect((await asWorker("/api/worker/storage/upload-session", req, "wrong-token-0123456789")).status).toBe(401);
    expect((await asWorker("/api/worker/storage/upload-session", { ...req, folder: "attachments" })).status).toBe(400);
    expect((await ctx.api("/api/storage", { headers: { authorization: `Bearer ${WORKER}` } })).status).toBe(401); // a worker can't list
    expect((await ctx.api("/api/worker/storage/upload-session", { method: "POST", json: req })).status).toBe(401); // admin token isn't the worker token

    const session = await asWorker("/api/worker/storage/upload-session", req);
    expect(session.status).toBe(201);
    expect(session.body).toMatchObject({ backend: "local", url: `https://cc.test/media/${session.body.id}` });
    expect(session.body.uploadUrl).toMatch(/^https:\/\/cc\.test\/api\/storage\/uploads\//);
    const bad = new URL(session.body.uploadUrl);
    bad.searchParams.set("key", "guess");
    expect((await ctx.server.app.request(`${bad.pathname}${bad.search}`, { method: "PUT", headers: { "content-range": "bytes */1" } })).status).toBe(404);
    expect((await asWorker("/api/worker/storage/complete", { id: session.body.id })).status).toBe(409);

    await uploadResumable({
      uploadUrl: session.body.uploadUrl, size: data.length, chunkSize: CHUNK_UNIT, fetch: router(ctx),
      readChunk: async (s, n) => data.subarray(s, s + n),
    });
    const done = await asWorker("/api/worker/storage/complete", { id: session.body.id });
    expect(done).toMatchObject({ status: 200, body: { size: data.length, folder: "renders", url: session.body.url } });
    await serveChecks(ctx, `/media/${session.body.id}`, data, "video/mp4");

    // Admin session path too, then the listing.
    const admin = await ctx.api("/api/storage/upload-session", { method: "POST", json: { name: "notes.pdf", contentType: "application/pdf", size: 3, folder: "attachments" } });
    expect(admin.body.url).toBeNull(); // not a media type: no public URL
    const list = await ctx.api("/api/storage");
    expect(list.body).toMatchObject({ backend: "local", drive: null });
    expect(list.body.files.map((f: { id: string }) => f.id)).toContain(session.body.id);
    expect(list.body.byFolder).toEqual(expect.arrayContaining([expect.objectContaining({ folder: "renders", files: 1, bytes: data.length })]));
    expect((await ctx.api("/api/storage/migrate", { method: "POST", json: {} })).status).toBe(409);
  });
});

describe.skipIf(!DB_URL)("storage on Google Drive (fake)", () => {
  let ctx: Ctx;
  const drive = new FakeDrive();
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    // A file from the days before the store: must keep its URL.
    const dataDir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "cc-legacy-"));
    mkdirSync(join(dataDir, "media"));
    writeFileSync(join(dataDir, "media", LEGACY), bytes(40));
    ctx = await makeServer({
      env: {
        DATA_DIR: dataDir, PUBLIC_BASE_URL: "https://cc.test", STORAGE_BACKEND: "gdrive", STORAGE_CACHE_MB: "1",
        GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "1//refresh",
      },
      overrides: { googleFetch: drive.fetch },
    });
  });
  afterAll(async () => ctx?.server.stop());

  it("stores uploads in Drive and serves them at the same /media URLs (cache, then Drive)", async () => {
    const data = bytes(3000);
    const up = await ctx.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4" }, body: data });
    expect(up.status).toBe(201);
    expect(up.body.url).toMatch(/^https:\/\/cc\.test\/media\/[a-f0-9]{32}\.mp4$/);
    expect([...drive.files.values()].some((f) => f.data.equals(data))).toBe(true);
    await serveChecks(ctx, new URL(up.body.url).pathname, data, "video/mp4");
    expect(drive.calls.some((c) => c.url.includes("alt=media"))).toBe(true);
    // The legacy local file still works.
    await serveChecks(ctx, `/media/${LEGACY}`, bytes(40), "video/mp4");
  });

  it("hands out Drive resumable sessions and lists usage with the folder link", async () => {
    const data = bytes(CHUNK_UNIT * 2);
    const s = await ctx.api("/api/storage/upload-session", { method: "POST", json: { name: "raw.mov", contentType: "video/quicktime", size: data.length, folder: "footage" } });
    expect(s.body).toMatchObject({ backend: "gdrive" });
    expect(s.body.uploadUrl).toMatch(/^https:\/\/www\.googleapis\.com\/upload\//);
    await uploadResumable({ uploadUrl: s.body.uploadUrl, size: data.length, chunkSize: CHUNK_UNIT, fetch: drive.fetch, readChunk: async (a, n) => data.subarray(a, a + n) });
    expect((await ctx.api("/api/storage/complete", { method: "POST", json: { id: s.body.id } })).body).toMatchObject({ size: data.length, backend: "gdrive" });

    const migrated = await ctx.api("/api/storage/migrate", { method: "POST", json: { deleteLocal: true } });
    expect(migrated.body).toEqual({ copied: [LEGACY], failed: [] });
    await serveChecks(ctx, `/media/${LEGACY}`, bytes(40), "video/mp4");

    const list = await ctx.api("/api/storage");
    expect(list.body.backend).toBe("gdrive");
    expect(list.body.drive.folderUrl).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    expect(list.body.byFolder.every((u: { backend: string }) => u.backend === "gdrive")).toBe(true);
    // No Drive URL or token leaks into anything public.
    expect(JSON.stringify(list.body)).not.toMatch(/ya29|googleapis\.com\/upload/);
    expect((await ctx.api(`/api/storage/${LEGACY}`, { method: "DELETE" })).status).toBe(200);
    expect((await ctx.server.app.request(`/media/${LEGACY}`)).status).toBe(404);
  });

  it("refuses gdrive without Google credentials", async () => {
    await expect(makeServer({ env: { STORAGE_BACKEND: "gdrive" } })).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});


