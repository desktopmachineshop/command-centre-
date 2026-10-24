import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  CHUNK_UNIT,
  createGoogleTokenProvider,
  DiskCache,
  GoogleDriveBlobStore,
  LocalBlobStore,
  MemoryBlobIndex,
  Storage,
  UploadIncompleteError,
  uploadResumable,
} from "../src";
import { FakeDrive } from "../src/testing";

const tmp = () => mkdtempSync(join(tmpdir(), "cc-storage-"));
const bytes = (n: number, seed = 7) => Buffer.from(Array.from({ length: n }, (_, i) => (i * seed + 3) % 251));

function drive(options: { cacheMb?: number; chunk?: number } = {}) {
  const fake = new FakeDrive();
  const index = new MemoryBlobIndex();
  const cache = options.cacheMb ? new DiskCache(join(tmp(), "cache"), options.cacheMb * 1024 * 1024) : undefined;
  const tokens = createGoogleTokenProvider({ clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh", fetch: fake.fetch });
  const store = new GoogleDriveBlobStore({ tokens, index, fetch: fake.fetch, cache, chunkSize: options.chunk ?? CHUNK_UNIT, backoff: () => 0, log: () => {} });
  return { fake, index, cache, store, tokens };
}

describe("LocalBlobStore", () => {
  it("puts, heads, gets ranges, lists and deletes under DATA_DIR", async () => {
    const dataDir = tmp();
    const index = new MemoryBlobIndex();
    const local = new LocalBlobStore({ dataDir, index });
    const data = bytes(1000);
    const info = await local.put(Readable.from([data.subarray(0, 400), data.subarray(400)]), { name: "photo.PNG", contentType: "image/png" });
    expect(info).toMatchObject({ size: 1000, contentType: "image/png", folder: "media", backend: "local" });
    expect(info.id).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(readdirSync(join(dataDir, "media"))).toEqual([info.id]); // same place as before the store existed

    const part = await local.get(info.id, { range: { start: 10, end: 19 } });
    expect(await buffer(part!.stream)).toEqual(data.subarray(10, 20));
    const render = await local.put(bytes(5), { name: "r.mp4", contentType: "video/mp4", folder: "renders" });
    expect(readdirSync(join(dataDir, "storage", "renders"))).toEqual([render.id]);
    expect((await local.list("media")).map((f) => f.id)).toEqual([info.id]);
    expect(await local.get("nope")).toBeNull();
    expect(await local.delete(info.id)).toBe(true);
    expect(await local.head(info.id)).toBeNull();
  });

  it("serves and indexes media files from before the index", async () => {
    const dataDir = tmp();
    mkdirSync(join(dataDir, "media"));
    const id = `${"a".repeat(32)}.jpg`;
    writeFileSync(join(dataDir, "media", id), "old jpeg");
    writeFileSync(join(dataDir, "media", "notes.txt"), "ignored");
    const index = new MemoryBlobIndex();
    const local = new LocalBlobStore({ dataDir, index });
    expect(await local.head(id)).toMatchObject({ size: 8, contentType: "image/jpeg" });
    expect(await local.indexExisting()).toBe(1);
    expect((await index.get(id))?.backend).toBe("local");
  });

  it("accepts chunked direct uploads with the resumable protocol, resuming after a lost chunk", async () => {
    const local = new LocalBlobStore({ dataDir: tmp(), index: new MemoryBlobIndex(), uploadBaseUrl: "https://cc.test/api/storage/uploads" });
    const data = bytes(CHUNK_UNIT * 2 + 100);
    const session = await local.createUploadSession({ name: "big.mp4", contentType: "video/mp4", size: data.length, folder: "footage" });
    expect(session.uploadUrl).toMatch(/^https:\/\/cc\.test\/api\/storage\/uploads\/[a-f0-9]{32}\.mp4\?key=/);
    const key = new URL(session.uploadUrl).searchParams.get("key")!;
    expect(await local.pendingUpload(session.id, "wrong")).toBeNull();
    let dropped = false;
    // A fetch that routes to receiveChunk, losing the second chunk once.
    const fetchLike = async (_url: string | URL | Request, init: RequestInit = {}) => {
      const row = (await local.pendingUpload(session.id, key))!;
      const range = new Headers(init.headers).get("content-range") ?? undefined;
      if (!dropped && range?.startsWith(`bytes ${CHUNK_UNIT}-`)) {
        dropped = true;
        throw new TypeError("socket hang up");
      }
      const body = init.body ? new Response(init.body as Buffer).body : null;
      const out = await local.receiveChunk(row, range, body);
      return out.done
        ? Response.json(out.info, { status: 201 })
        : new Response(null, { status: 308, headers: out.received ? { range: `bytes=0-${out.received - 1}` } : {} });
    };
    await expect(local.completeUpload(session.id)).rejects.toBeInstanceOf(UploadIncompleteError);
    const done = await uploadResumable({
      uploadUrl: session.uploadUrl, size: data.length, chunkSize: CHUNK_UNIT, fetch: fetchLike as typeof fetch, backoff: () => 0,
      readChunk: async (s, n) => data.subarray(s, s + n),
    });
    expect(dropped).toBe(true);
    expect(done).toMatchObject({ id: session.id, size: data.length });
    expect(await buffer((await local.get(session.id))!.stream)).toEqual(data);
    expect(await local.completeUpload(session.id)).toMatchObject({ folder: "footage" });
  });
});

describe("GoogleDriveBlobStore (mocked fetch)", () => {
  it("creates the Command Centre folders once and remembers them", async () => {
    const { fake, store, index } = drive();
    await store.put(bytes(10), { name: "a.png", contentType: "image/png" });
    await store.put(bytes(10), { name: "b.png", contentType: "image/png" });
    await store.put(bytes(10), { name: "c.mp4", contentType: "video/mp4", folder: "renders" });
    const folders = [...fake.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    expect(folders.map((f) => f.name).sort()).toEqual(["Command Centre", "media", "renders"]);
    const root = folders.find((f) => f.name === "Command Centre")!;
    expect(root.parents).toEqual(["root"]);
    expect(folders.filter((f) => f.name !== "Command Centre").every((f) => f.parents[0] === root.id)).toBe(true);
    expect(await index.getState("gdrive.folder.root")).toBe(root.id);
    expect(await store.folderUrl()).toBe(`https://drive.google.com/drive/folders/${root.id}`);

    // A new process with the same index finds them without searching or creating.
    const before = fake.calls.length;
    const again = new GoogleDriveBlobStore({ tokens: createGoogleTokenProvider({ clientId: "c", clientSecret: "s", refreshToken: "r", fetch: fake.fetch }), index, fetch: fake.fetch, chunkSize: CHUNK_UNIT, log: () => {} });
    await again.put(bytes(3), { name: "d.png", contentType: "image/png" });
    expect(fake.calls.slice(before).filter((c) => c.url.includes("/drive/v3/files") && !c.url.includes("upload"))).toHaveLength(0);
  });

  it("uploads in 256 KiB-multiple chunks and resumes after a dropped connection, a 503 and a partial write", async () => {
    const { fake, store } = drive();
    const data = bytes(CHUNK_UNIT * 3 + 1234);
    fake.failChunks = ["partial", "drop", 503];
    const info = await store.put(Readable.from([data]), { name: "footage.mov", contentType: "video/quicktime", folder: "footage" });
    expect(info).toMatchObject({ size: data.length, folder: "footage", backend: "gdrive" });
    const file = [...fake.files.values()].find((f) => f.name === "footage.mov")!;
    expect(file.data.equals(data)).toBe(true);
    expect(file.appProperties.ccId).toBe(info.id);
    const puts = fake.chunkPuts();
    // Every non-final chunk is a whole number of 256 KiB units and starts where the server said it stopped.
    for (const p of puts.slice(0, -1)) {
      const [, a, b] = /bytes (\d+)-(\d+)/.exec(p.headers["content-range"]!)!;
      expect((Number(b) - Number(a) + 1) % CHUNK_UNIT === 0 || p.headers["content-range"]!.endsWith(`/${data.length}`)).toBe(true);
    }
    expect(puts.at(-1)!.headers["content-range"]).toMatch(new RegExp(`/${data.length}$`));
    expect(fake.calls.some((c) => c.headers["content-range"] === "bytes */*")).toBe(true); // status query after the failure
    // The session init carried metadata, never the bytes.
    const init = fake.calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(init.headers["x-upload-content-type"]).toBe("video/quicktime");
  });

  it("downloads with Range (alt=media) and from the warm cache", async () => {
    const { fake, store, cache } = drive({ cacheMb: 1 });
    const data = bytes(5000);
    const info = await store.put(data, { name: "clip.mp4", contentType: "video/mp4" });
    const part = await store.get(info.id, { range: { start: 100, end: 199 } });
    expect(part).toMatchObject({ size: 5000, contentType: "video/mp4" });
    expect(await buffer(part!.stream)).toEqual(data.subarray(100, 200));
    const dl = fake.calls.filter((c) => c.url.includes("alt=media"));
    expect(dl[0]!.headers.range).toBe("bytes=100-199");
    await store.idle();
    expect(cache!.has(info.id)).toBe(true);

    const calls = fake.calls.length;
    const whole = await store.get(info.id);
    expect(await buffer(whole!.stream)).toEqual(data);
    const ranged = await store.get(info.id, { range: { start: 4990, end: 4999 } });
    expect(await buffer(ranged!.stream)).toEqual(data.subarray(4990));
    expect(fake.calls.length).toBe(calls); // served from the cache, no Drive call
    expect(await store.get(`${"f".repeat(32)}.mp4`)).toBeNull();
  });

  it("deletes from Drive, the cache and the index", async () => {
    const { fake, store, index, cache } = drive({ cacheMb: 1 });
    const info = await store.put(bytes(100), { name: "x.png", contentType: "image/png" });
    await buffer((await store.get(info.id))!.stream);
    await store.idle();
    expect(await store.delete(info.id)).toBe(true);
    expect([...fake.files.values()].some((f) => f.name === "x.png")).toBe(false);
    expect(await index.get(info.id)).toBeNull();
    expect(cache!.has(info.id)).toBe(false);
    expect(await store.delete(info.id)).toBe(false);
  });

  it("refreshes the access token on expiry or a 401, once per refresh", async () => {
    let clock = 0;
    const fake = new FakeDrive();
    const tokens = createGoogleTokenProvider({ clientId: "c", clientSecret: "s", refreshToken: "r", fetch: fake.fetch, now: () => clock });
    const [a, b] = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken()]);
    expect(a).toBe(b);
    expect(fake.tokensIssued).toBe(1);
    clock += 3600_000;
    expect(await tokens.getAccessToken()).not.toBe(a);
    const tokenCall = fake.calls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/token"))!;
    expect(tokenCall.method).toBe("POST");

    // Drive says 401 (revoked token): the store refreshes and retries.
    const { fake: f2, store } = drive();
    await store.put(bytes(1), { name: "a.png", contentType: "image/png" });
    f2.valid.clear();
    await store.put(bytes(1), { name: "b.png", contentType: "image/png" });
    expect(f2.tokensIssued).toBe(2);
  });

  it("redacts tokens and upload ids from errors", async () => {
    const { fake, store } = drive();
    fake.tokenStatus = 400;
    const err = await store.put(bytes(1), { name: "a.png", contentType: "image/png" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/token refresh failed \(400\)/);
    expect(String(err)).not.toContain("secret-refresh-token");
    fake.tokenStatus = 200;
    fake.failChunks = [400];
    const err2 = await store.put(bytes(1), { name: "a.png", contentType: "image/png" }).catch((e: Error) => e);
    expect(String(err2)).toMatch(/upload failed \(400\)/);
    expect(String(err2)).not.toMatch(/ya29\.fake|SECRETUPLOADID/);
  });

  it("creates direct-upload sessions and confirms completion with Drive, not the client", async () => {
    const { fake, store, index } = drive();
    const data = bytes(CHUNK_UNIT + 10);
    const session = await store.createUploadSession({ name: "render.mp4", contentType: "video/mp4", size: data.length, folder: "renders" });
    expect(session).toMatchObject({ backend: "gdrive", chunkSize: CHUNK_UNIT });
    expect(session.uploadUrl).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/session\//);
    expect((await index.get(session.id))?.status).toBe("pending");
    expect(await store.head(session.id)).toBeNull();

    // Half-way: complete refuses.
    await fake.fetch(session.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${CHUNK_UNIT - 1}/${data.length}` }, body: data.subarray(0, CHUNK_UNIT) });
    await expect(store.completeUpload(session.id)).rejects.toThrow(/has 262144 of 262154 bytes/);
    await uploadResumable({ uploadUrl: session.uploadUrl, size: data.length, chunkSize: CHUNK_UNIT, fetch: fake.fetch, readChunk: async (s, n) => data.subarray(s, s + n) });
    const info = await store.completeUpload(session.id);
    expect(info).toMatchObject({ id: session.id, size: data.length, folder: "renders" });
    expect(await buffer((await store.get(session.id))!.stream)).toEqual(data);
  });
});

describe("DiskCache", () => {
  it("evicts the least recently used file past the cap and reloads from disk", async () => {
    const dir = join(tmp(), "cache");
    const cache = new DiskCache(dir, 4000);
    const id = (n: number) => `${String(n).repeat(32)}.bin`;
    for (const n of [1, 2, 3]) expect(await cache.fill(id(n), Readable.from([bytes(1000)]))).toBe(true);
    expect(await cache.lookup(id(1))).toBeTruthy(); // 1 is now the most recent
    await cache.fill(id(4), Readable.from([bytes(1000)]));
    await cache.fill(id(5), Readable.from([bytes(1000)]));
    expect(cache.ids()).toEqual([id(3), id(1), id(4), id(5)]);
    expect(cache.stats()).toMatchObject({ files: 4, bytes: 4000 });
    expect(await cache.lookup(id(2))).toBeNull();
    expect(await cache.fill(id(6), Readable.from([bytes(1001)]))).toBe(false); // over a quarter of the cap
    expect(readdirSync(dir).sort()).toEqual([id(1), id(3), id(4), id(5)].sort());

    const reloaded = new DiskCache(dir, 2000);
    await reloaded.init();
    expect(reloaded.stats().files).toBe(2);
  });
});

describe("Storage (routing)", () => {
  it("keeps serving local files after switching to Drive, and migrates them with the same id", async () => {
    const dataDir = tmp();
    const index = new MemoryBlobIndex();
    const local = new LocalBlobStore({ dataDir, index });
    const old = await local.put(bytes(300), { name: "old.jpg", contentType: "image/jpeg" });
    const { fake, store: gdrive } = (() => {
      const d = drive();
      return { fake: d.fake, store: new GoogleDriveBlobStore({ tokens: d.tokens, index, fetch: d.fake.fetch, chunkSize: CHUNK_UNIT, backoff: () => 0, log: () => {} }) };
    })();
    const cache = new DiskCache(join(dataDir, "cache"), 10_000);
    const storage = new Storage({ index, local, drive: gdrive, cache });
    expect(storage.kind).toBe("gdrive");
    expect(await buffer((await storage.get(old.id))!.stream)).toEqual(bytes(300));
    const fresh = await storage.put(bytes(20), { name: "new.png", contentType: "image/png" });
    expect(fresh.backend).toBe("gdrive");

    const result = await storage.migrateToDrive({ deleteLocal: true });
    expect(result).toEqual({ copied: [old.id], failed: [] });
    expect((await index.get(old.id))?.backend).toBe("gdrive");
    expect(readdirSync(join(dataDir, "media"))).toEqual([]);
    expect(cache.has(old.id)).toBe(true); // the local copy became the warm cache
    expect(await buffer((await storage.get(old.id))!.stream)).toEqual(bytes(300));
    expect([...fake.files.values()].some((f) => f.name === "old.jpg")).toBe(true);
    const usage = await storage.usage();
    expect(usage).toMatchObject({ backend: "gdrive", files: 2, totalBytes: 320, drive: { quota: { limit: 16106127360 } } });
  });
});
