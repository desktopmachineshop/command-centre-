import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/db/migrations";
import { migrate } from "../src/db/pool";
import { DB_URL, resetDatabase } from "./helpers";

const sql = (id: string) => migrations.find((m) => m.id === id)!.sql;

describe.skipIf(!DB_URL)("migrations", () => {
  it("boots a database migrated while the budgets SQL was called 0002_budgets_digests", async () => {
    await resetDatabase(DB_URL!);
    const pool = new pg.Pool({ connectionString: DB_URL });
    try {
      // The schema as the budgets branch left it: 0001_init, then the budgets SQL under its old id.
      await pool.query("create table schema_migrations (id text primary key, applied_at timestamptz not null default now())");
      for (const [id, body] of [["0001_init", sql("0001_init")], ["0002_budgets_digests", sql("0003_budgets_digests")]] as const) {
        await pool.query(body);
        await pool.query("insert into schema_migrations (id) values ($1)", [id]);
      }

      // Everything after 0001_init, including 0003 again under its final id (it is safe to rerun).
      expect(await migrate(pool)).toEqual(migrations.map((m) => m.id).filter((id) => id !== "0001_init"));
      const cols = await pool.query("select column_name from information_schema.columns where table_name = 'tasks' and column_name in ('note', 'duplicate_of', 'budget_override')");
      expect(cols.rows).toHaveLength(3);
      expect(await migrate(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("migrates an empty database", async () => {
    await resetDatabase(DB_URL!);
    const pool = new pg.Pool({ connectionString: DB_URL });
    try {
      expect(await migrate(pool)).toEqual(migrations.map((m) => m.id));
    } finally {
      await pool.end();
    }
  });
});
