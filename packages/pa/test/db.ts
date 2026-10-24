import pg from "pg";
import { PA_MIGRATION_SQL, PgPaStore } from "../src";

export const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * The PA tables in their own schema, so these tests never touch the server
 * tests' `public` schema even when turbo runs both packages at once.
 */
const SCHEMA = "pa_pkg_test";

export async function freshStore() {
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${SCHEMA}`, max: 4 });
  await pool.query(PA_MIGRATION_SQL);
  return { pool, store: new PgPaStore(pool) };
}
