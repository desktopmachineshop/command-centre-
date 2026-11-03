import type { BlobInfo } from "@cc/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanOldRenders, diskSpace, storageHousekeeping, uploadRefusal } from "../src/storage-housekeeping";
import { videoMediaFromStorage } from "../src/storage";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const MB = 1024 * 1024;
const DAY = 86_400_000;
const now = new Date("2026-11-03T03:43:00Z");
const file = (id: string, daysOld: number, size = 10 * MB, backend: "local" | "gdrive" = "local"): BlobInfo => ({
  id,
  name: `${id}.mp4`,
  size,
  contentType: "video/mp4",
  folder: "renders",
  backend,
  createdAt: new Date(now.getTime() - daysOld * DAY),
});

/** A Storage stand-in: just the renders list and delete. */
function fakeStorage(files: BlobInfo[], kind: "local" | "gdrive" = "local") {
  const deleted: string[] = [];
  return {
    kind,
    deleted,
    list: async () => files.filter((f) => !deleted.includes(f.id)),
    delete: async (id: string) => (deleted.push(id), true),
  };
}

describe("storage housekeeping", () => {
  const options = { dataDir: "/data", minFreeBytes: 500 * MB, renderRetentionDays: 30 };

  it("refuses uploads that would leave less than the reserve free, on the local volume only", async () => {
    const disk = { free: 800 * MB, total: 5000 * MB };
    expect(await uploadRefusal({ kind: "local" }, options, 200 * MB, disk)).toBeNull();
    expect(await uploadRefusal({ kind: "local" }, options, 400 * MB, disk)).toMatch(/^Storage is full: 800 MB free on the server, and 500 MB is kept free/);
    // Size unknown yet: refused only once the volume is already below the reserve.
    expect(await uploadRefusal({ kind: "local" }, options, 0, disk)).toBeNull();
    expect(await uploadRefusal({ kind: "local" }, options, 0, { free: 300 * MB, total: 5000 * MB })).not.toBeNull();
    // New files go to Drive: the volume isn't the limit.
    expect(await uploadRefusal({ kind: "gdrive" }, options, 4000 * MB, disk)).toBeNull();
    // Can't tell (no statfs): never blocks.
    expect(await uploadRefusal({ kind: "local" }, options, 4000 * MB, null)).toBeNull();
  });

  it("reads the real disk", async () => {
    const disk = await diskSpace(process.cwd());
    expect(disk!.total).toBeGreaterThan(0);
    expect(disk!.free).toBeLessThanOrEqual(disk!.total);
  });

  it("deletes old local renders, keeping recent ones, Drive ones and any a pending approval plays", async () => {
    const storage = fakeStorage([
      file("aaaa", 45),
      file("bbbb", 31),
      file("cccc", 10),
      file("dddd", 60), // its social.campaign still waits for Dave
      file("eeee", 90, MB, "gdrive"),
    ]);
    const pending = async () => [{ video: { url: "https://cc.example/media/dddd" } }];
    const out = await cleanOldRenders(storage, pending, options, now);
    expect(out).toEqual({ deleted: ["aaaa", "bbbb"], freedBytes: 20 * MB, kept: ["dddd"] });
    expect(storage.deleted).toEqual(["aaaa", "bbbb"]);

    // 0 keeps everything.
    expect((await cleanOldRenders(fakeStorage([file("ffff", 400)]), pending, { renderRetentionDays: 0 }, now)).deleted).toEqual([]);
  });

  it("warns when the volume is still nearly full after cleaning", async () => {
    const notes: { title: string; body: string }[] = [];
    // A threshold of 0 always warns (any used disk); a threshold of 1 never does.
    const run = (warnAtFraction: number) =>
      storageHousekeeping({
        storage: fakeStorage([file("aaaa", 45)]),
        options: { ...options, dataDir: process.cwd(), warnAtFraction },
        pendingPayloads: async () => [],
        notify: async (n) => void notes.push(n),
        now,
      });
    expect(await run(0)).toMatchObject({ deleted: 1, freedBytes: 10 * MB });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Server storage nearly full");
    await run(1.01);
    expect(notes).toHaveLength(1);
  });
});

describe.skipIf(!DB_URL)("storage full (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const WORKER = "worker-token-for-tests-0123456789";

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    // A reserve bigger than any disk: every upload to the volume is refused.
    ctx = await makeServer({ env: { PUBLIC_BASE_URL: "https://cc.test", WORKER_TOKEN: WORKER, STORAGE_MIN_FREE_MB: "100000000" } });
  });
  afterAll(async () => ctx?.server.stop());

  it("answers 507 to direct uploads and to a render's one-shot PUT, without storing anything", async () => {
    const session = await ctx.server.app.request("/api/worker/storage/upload-session", {
      method: "POST",
      headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "render.mp4", contentType: "video/mp4", size: 1000, folder: "renders" }),
    });
    expect(session.status).toBe(507);
    expect(((await session.json()) as { error: string }).error).toMatch(/^Storage is full/);

    const up = await videoMediaFromStorage(ctx.server.storage, "https://cc.test").createUpload("spec-1/final.mp4", "video/mp4");
    const put = new URL(up.putUrl);
    const res = await ctx.server.app.request(`${put.pathname}${put.search}`, { method: "PUT", body: Buffer.alloc(100) });
    expect(res.status).toBe(507);
    expect((await ctx.server.app.request(new URL(up.publicUrl).pathname)).status).toBe(404);
  });

  it("shows the volume and its limits on the Storage page's listing", async () => {
    const { body } = await ctx.api("/api/storage");
    expect(body.backend).toBe("local");
    expect(body.volume).toMatchObject({ minFreeBytes: 100000000 * 1024 * 1024, renderRetentionDays: 30 });
    expect(body.volume.total).toBeGreaterThan(0);
    expect(body.volume.free).toBeLessThanOrEqual(body.volume.total);
  });
});
