import { type Snapshot, type SnapshotMeta, type SnapshotStore } from "@cc/research";
import type pg from "pg";

/**
 * Competitor snapshots in Postgres (`competitor_snapshots`, one row per snapshot, the catalogue as
 * jsonb). They live here rather than in the brain because they are raw data: a catalogue can be
 * thousands of rows, every brain save is kept as a version and indexed for search, and diffs want
 * structured rows. What people read (the competitor registry and the dated reports) is in the
 * brain, written by the agent.
 */
export class PgSnapshotStore implements SnapshotStore {
  constructor(
    private readonly pool: pg.Pool,
    /** Snapshots kept per competitor; older ones are dropped on save. */
    private readonly keep = 60,
  ) {}

  async save(s: Snapshot): Promise<void> {
    await this.pool.query("insert into competitor_snapshots (id, vertical, competitor, site, taken_at, data) values ($1, $2, $3, $4, $5, $6)", [s.id, s.vertical, s.competitor, s.site, s.takenAt, JSON.stringify(s)]);
    await this.pool.query(
      `delete from competitor_snapshots where vertical = $1 and competitor = $2
       and id not in (select id from competitor_snapshots where vertical = $1 and competitor = $2 order by taken_at desc limit $3)`,
      [s.vertical, s.competitor, this.keep],
    );
  }

  async latest(vertical: string, competitor: string, before?: Date): Promise<Snapshot | null> {
    const { rows } = await this.pool.query(
      "select data from competitor_snapshots where vertical = $1 and competitor = $2 and ($3::timestamptz is null or taken_at <= $3) order by taken_at desc limit 1",
      [vertical, competitor, before ?? null],
    );
    return rows[0] ? (rows[0].data as Snapshot) : null;
  }

  async lastTwo(vertical: string, competitor: string): Promise<Snapshot[]> {
    const { rows } = await this.pool.query("select data from competitor_snapshots where vertical = $1 and competitor = $2 order by taken_at desc limit 2", [vertical, competitor]);
    return rows.map((r) => r.data as Snapshot);
  }

  async list(vertical: string, competitor?: string, limit = 50): Promise<SnapshotMeta[]> {
    const { rows } = await this.pool.query(
      `select id, vertical, competitor, site, taken_at, data->>'source' as source,
         jsonb_array_length(data->'products') as products, jsonb_array_length(data->'pages') as pages
       from competitor_snapshots where vertical = $1 and ($2::text is null or competitor = $2) order by taken_at desc limit $3`,
      [vertical, competitor ?? null, limit],
    );
    return rows.map((r) => ({ id: r.id, vertical: r.vertical, competitor: r.competitor, site: r.site, takenAt: new Date(r.taken_at).toISOString(), source: r.source, products: Number(r.products), pages: Number(r.pages) }));
  }
}

