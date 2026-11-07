import { type Brain, BrainConflictError } from "@cc/brain";
import type { VerticalRegistry } from "@cc/verticals";
import { howWeWorkPath } from "./assistant";
import type { Pool } from "./db/pool";

/**
 * Writes each business's how-we-work note to the brain ("<brainFolder>/how-we-work.md"), once:
 * only where that path has never existed, so Dave's edits (and a note he deleted) stand.
 *
 * The note is the business's `guidance` (the old org chart's roles: what good looks like and what
 * always needs Dave), plus, for a business whose roles Dave edited on the old Org page, those
 * roles as he saved them, so nothing he wrote there is lost. Never throws.
 */
export async function seedHowWeWork(brain: Brain, pool: Pool, registry: VerticalRegistry): Promise<void> {
  for (const v of registry.all()) {
    try {
      if (!v.guidance) continue;
      const path = howWeWorkPath(v);
      const seen = await pool.query("select 1 from brain_note_versions where path = $1 limit 1", [path]);
      if (seen.rows.length) continue;
      const edited = await savedRoles(pool, v.id, new Set(registry.roles(v.id).map((r) => r.id)));
      const body = edited ? `${v.guidance}\n\n${edited}` : v.guidance;
      await brain.write(path, { frontmatter: { type: "guide", vertical: v.id }, body }, { author: "system", message: "how-we-work: from the old org chart", expectedVersion: 0 });
    } catch (err) {
      if (!(err instanceof BrainConflictError)) console.error(`[how-we-work] ${v.id}:`, (err as Error).message);
    }
  }
}

type SavedRole = { id?: string; title?: string; mission?: string; autonomyNotes?: string };

/** The roles Dave saved on the old Org page for this business that aren't specialists now, as markdown; null if none. */
async function savedRoles(pool: Pool, vertical: string, specialists: Set<string>): Promise<string | null> {
  const { rows } = await pool.query("select data from org_overrides where unit = $1", [vertical]).catch(() => ({ rows: [] as { data: unknown }[] }));
  const roles = ((rows[0]?.data as { roles?: SavedRole[] } | undefined)?.roles ?? []).filter((r) => r.id && !specialists.has(r.id) && r.mission);
  if (!roles.length) return null;
  const lines = ["# As you last saved them on the Org page", ""];
  for (const r of roles) {
    lines.push(`## ${r.title ?? r.id}`, r.mission!);
    if (r.autonomyNotes) lines.push("", `Needs Dave: ${r.autonomyNotes}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
