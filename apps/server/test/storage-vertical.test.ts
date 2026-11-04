import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../src/db/migrations";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

describe.skipIf(!DB_URL)("storage by vertical (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({});
  });
  afterAll(async () => ctx?.server.stop());

  it("backfills existing files' verticals from what names them, and marks video work in progress", async () => {
    const pool = ctx.server.store.pool;
    const file = async (id: string, name: string, folder = "media") =>
      pool.query(
        `insert into storage_files (id, backend, name, size, content_type, folder, status) values ($1, 'local', $2, 10, 'video/mp4', $3, 'ready')`,
        [id, name, folder],
      );
    const a = "a".repeat(32);
    const prod = "11111111-2222-3333-4444-555555555555";
    await file(`${a}.mp4`, "upload.mp4");
    await file(`${"b".repeat(32)}.webm`, `reel-${prod}/intro.webm`, "renders");
    await file(`${"c".repeat(32)}.mp4`, `reel-${prod}/reel.mp4`, "renders");
    await file(`${"d".repeat(32)}.png`, "orphan.png");
    await pool.query(
      `insert into proposals (id, vertical, action_type, summary, payload, policy, status) values (gen_random_uuid(), 'dms', 'social.post', 'x', $1, 'draft', 'pending')`,
      [JSON.stringify({ content: { media: [{ url: `https://x/media/${a}.mp4` }] } })],
    );
    const sql = migrations.find((m) => m.id === "0022_storage_vertical")!.sql;
    await pool.query(sql); // as the deploy runs it over existing rows

    const { rows } = await pool.query("select id, vertical, work, wip from storage_files order by id");
    expect(rows).toEqual([
      { id: `${a}.mp4`, vertical: "dms", work: null, wip: false },
      { id: `${"b".repeat(32)}.webm`, vertical: null, work: `video:${prod}`, wip: true },
      { id: `${"c".repeat(32)}.mp4`, vertical: null, work: `video:${prod}`, wip: false },
      { id: `${"d".repeat(32)}.png`, vertical: null, work: null, wip: false },
    ]);
  });

  it("lists, filters and moves files by vertical over the API", async () => {
    const storage = ctx.server.storage;
    const f = await storage.put(Buffer.from("x"), { name: "note.pdf", contentType: "application/pdf", folder: "attachments" });
    expect((await ctx.api(`/api/storage/${f.id}`, { method: "PATCH", json: { vertical: "dms" } })).body).toMatchObject({ id: f.id, vertical: "dms" });
    expect((await ctx.api(`/api/storage/${f.id}`, { method: "PATCH", json: { vertical: "nope" } })).status).toBe(400);
    const listed = (await ctx.api("/api/storage?vertical=dms")).body;
    expect(listed.files.map((x: { id: string }) => x.id)).toContain(f.id);
    expect(listed.byFolder).toEqual(expect.arrayContaining([expect.objectContaining({ vertical: "dms", folder: "attachments" })]));
    expect((await ctx.api("/api/storage?vertical=personal")).body.files.map((x: { id: string }) => x.id)).not.toContain(f.id);
    expect((await ctx.api(`/api/storage/${f.id}`, { method: "PATCH", json: { vertical: "shared" } })).body).toMatchObject({ vertical: null });
  });
});
