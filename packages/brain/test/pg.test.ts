import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_MIGRATION_SQL, BrainConflictError, PgBrain, SEED_NOTES } from "../src";

const DB_URL = process.env.TEST_DATABASE_URL;
/** Own schema, so these tests never touch the server tests' `public` schema. */
const SCHEMA = "brain_pkg_test";

let pool: pg.Pool;
let brain: PgBrain;
let changes: string[];

beforeEach(async () => {
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.end();
  await pool?.end();
  pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA}`, max: 6 });
  await pool.query(BRAIN_MIGRATION_SQL);
  changes = [];
  brain = new PgBrain(pool, { onChange: (path) => changes.push(path) });
});

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!DB_URL)("PgBrain", () => {
  it("writes and reads notes with frontmatter and a version", async () => {
    await brain.write("dms/products/er11-collet.md", { frontmatter: { type: "product" }, body: "# ER11 collet set\n\nFits 300W spindles." });
    const note = await brain.read("/dms/products/er11-collet.md");
    expect(note?.frontmatter.type).toBe("product");
    expect(note?.frontmatter.updated).toBeTypeOf("string");
    expect(note?.body).toBe("# ER11 collet set\n\nFits 300W spindles.");
    expect(note?.version).toBe(1);
    expect(note?.updatedBy).toBe("agent");
    expect(changes).toEqual(["dms/products/er11-collet.md"]);
    expect(await brain.read("dms/nope.md")).toBeNull();
  });

  it("refuses paths outside the brain and non-markdown files", async () => {
    await expect(brain.write("../evil.md", { body: "x" })).rejects.toThrow(/outside/);
    await expect(brain.write("dms/x.sh", { body: "x" })).rejects.toThrow(/\.md/);
    await expect(brain.list("../")).rejects.toThrow(/outside/);
  });

  it("keeps every version, skips no-op saves and restores old ones", async () => {
    await brain.write("dms/faq.md", { body: "# FAQ\n\nv1" }, { author: "dave", message: "first" });
    await brain.write("dms/faq.md", { body: "# FAQ\n\nv2" });
    await brain.write("dms/faq.md", { body: "# FAQ\n\nv2" });
    const history = await brain.history("dms/faq.md");
    expect(history.map((h) => [h.version, h.author, h.message])).toEqual([
      [2, "agent", "brain: update dms/faq.md"],
      [1, "dave", "first"],
    ]);
    expect((await brain.readVersion("dms/faq.md", 1))?.body).toBe("# FAQ\n\nv1");

    const restored = await brain.restore("dms/faq.md", 1, { author: "dave" });
    expect(restored?.body).toBe("# FAQ\n\nv1");
    expect(restored?.version).toBe(3);
    expect(await brain.restore("dms/faq.md", 99)).toBeNull();
  });

  it("refuses a save over a newer version", async () => {
    await brain.write("dms/a.md", { body: "one" }, { expectedVersion: 0 });
    await expect(brain.write("dms/a.md", { body: "x" }, { expectedVersion: 0 })).rejects.toBeInstanceOf(BrainConflictError);
    await brain.write("dms/a.md", { body: "two" }, { expectedVersion: 1 });
    await expect(brain.write("dms/a.md", { body: "x" }, { expectedVersion: 1 })).rejects.toThrow(/changed since/);
  });

  it("deletes notes, keeping their history, and recreates them at the next version", async () => {
    await brain.write("dms/a.md", { body: "one" });
    expect(await brain.delete("dms/a.md", { author: "dave" })).toBe(true);
    expect(await brain.delete("dms/a.md")).toBe(false);
    expect(await brain.read("dms/a.md")).toBeNull();
    expect((await brain.history("dms/a.md"))[0]).toMatchObject({ version: 2, deleted: true, author: "dave" });
    expect((await brain.write("dms/a.md", { body: "again" })).version).toBe(3);
  });

  it("appends to the daily journal without losing concurrent lines", async () => {
    const at = new Date("2026-10-23T09:15:00Z");
    await brain.appendJournal("Shipped order 1042", { vertical: "dms", at });
    await brain.appendJournal("Booked dentist", { at });
    expect((await brain.read("journal/2026-10-23.md"))?.body).toBe("# 2026-10-23\n\n- 09:15 [dms] Shipped order 1042\n- 09:15 Booked dentist\n");

    await Promise.all(Array.from({ length: 8 }, (_, i) => brain.appendJournal(`line ${i}`, { at: new Date("2026-10-24T10:00:00Z") })));
    const body = (await brain.read("journal/2026-10-24.md"))!.body;
    expect(body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
  });

  it("lists notes by folder", async () => {
    await brain.write("dms/a.md", { body: "a" });
    await brain.write("dms-old/b.md", { body: "b" });
    await brain.write("personal/c.md", { body: "c" });
    expect(await brain.list()).toEqual(["dms-old/b.md", "dms/a.md", "personal/c.md"]);
    expect(await brain.list("dms")).toEqual(["dms/a.md"]);
    expect(await brain.list("/dms/")).toEqual(["dms/a.md"]);
  });

  it("ranks search hits by title then body, with stemming and folders", async () => {
    await brain.write("dms/spindle-faq.md", { body: "# Spindle FAQ\n\nRunout questions." });
    await brain.write("personal/shopping.md", { body: "# Shopping\n\nBuy a spindle belt." });
    await brain.write("personal/other.md", { frontmatter: { tags: ["garden"] }, body: "# Other\n\nNothing here." });
    const hits = await brain.search("spindles");
    expect(hits.map((h) => h.path)).toEqual(["dms/spindle-faq.md", "personal/shopping.md"]);
    expect(hits[1]?.snippet).toContain("spindle belt");
    expect(await brain.search("spindle", { folder: "personal" })).toHaveLength(1);
    expect((await brain.search("garden"))[0]?.path).toBe("personal/other.md");
    expect(await brain.search("run")).toHaveLength(1);
    expect(await brain.search("the")).toEqual([]);
    expect(await brain.search("")).toEqual([]);
  });

  it("seeds the README and seed notes once, never over a delete", async () => {
    await brain.init();
    expect(await brain.list()).toEqual([...SEED_NOTES.map((n) => n.path), "README.md"].sort());
    await brain.delete(SEED_NOTES[0]!.path);
    await brain.init();
    expect(await brain.read(SEED_NOTES[0]!.path)).toBeNull();
  });
});
