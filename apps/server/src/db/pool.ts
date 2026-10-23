import pg from "pg";
import { migrations } from "./migrations";

export type Pool = pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Applies pending migrations in order, each in its own transaction. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
  );
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent boots (e.g. two replicas starting together).
    await client.query("select pg_advisory_lock(727274)");
    const done = new Set((await client.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [m.id]);
        await client.query("commit");
        applied.push(m.id);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}
