import { type Brain, BrainConflictError } from "@cc/brain";
import type { VerticalManifest } from "@cc/core";
import { slugOf } from "@cc/research";
import { COMPETITOR_WATCH_ID, competitorRegistryPath, type VerticalRegistry } from "@cc/verticals";
import type { Pool } from "./db/pool";

/**
 * Each business's competitor registry: one brain note, "<brainFolder>/competitors.md", with a
 * section per competitor (see skills/competitor-analysis). Dave and the agents edit it like any
 * note. The server only seeds it, empty, with the template, and reads it for one thing: the weekly
 * competitor watch doesn't fire while it lists nobody.
 */

export const usesCompetitorAnalysis = (v: Pick<VerticalManifest, "skills">) => v.skills.includes("competitor-analysis");

export function registryTemplate(business: string): string {
  return `# Competitors: ${business}

Who else ${business}'s customers could buy from. One section per competitor, in the shape below.
The weekly competitor watch covers every competitor listed here (and does nothing while there are
none); "do a competitor analysis for …" adds to it. Edit freely.

<!-- Copy this for each competitor, outside this comment:

## Rival Tools
- Site: https://rival-tools.co.uk
- Sells: what they sell, in a line
- Overlap: which of our products or customers they compete for
- Watch pages: https://rival-tools.co.uk/pages/shipping, https://rival-tools.co.uk/pages/returns
- Notes: anything worth remembering, with its date

-->
`;
}

export interface RegisteredCompetitor {
  name: string;
  /** What the research snapshot tools call it. */
  slug: string;
  site: string;
  watchPages: string[];
}

/** The competitors a registry note lists: each "## Name" section with a "Site:" line (the commented-out template is ignored). */
export function parseRegistry(body: string): RegisteredCompetitor[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const out: RegisteredCompetitor[] = [];
  for (const section of text.split(/^##\s+/m).slice(1)) {
    const [heading = "", ...lines] = section.split("\n");
    const name = heading.trim();
    const field = (label: string) => {
      const line = lines.find((l) => new RegExp(`^\\s*[-*]?\\s*\\**${label}\\**\\s*:`, "i").test(l));
      return line ? line.slice(line.indexOf(":") + 1).trim() : "";
    };
    const site = /(https?:\/\/[^\s,)>\]]+|(?:[a-z0-9-]+\.)+[a-z]{2,}[^\s,)>\]]*)/i.exec(field("Site"))?.[1];
    if (!name || !site) continue;
    const watchPages = [...field("Watch pages").matchAll(/https?:\/\/[^\s,)>\]]+/g)].map((m) => m[0]);
    out.push({ name, slug: slugOf(name), site, watchPages });
  }
  return out;
}

/** Writes the empty registry for each business that does competitor analysis, once: only where the note has never existed. Never throws. */
export async function seedCompetitorRegistries(brain: Brain, pool: Pool, registry: VerticalRegistry): Promise<void> {
  for (const v of registry.all()) {
    if (!usesCompetitorAnalysis(v)) continue;
    try {
      const path = competitorRegistryPath(v.brainFolder);
      const seen = await pool.query("select 1 from brain_note_versions where path = $1 limit 1", [path]);
      if (seen.rows.length) continue;
      await brain.write(path, { frontmatter: { type: "registry", vertical: v.id }, body: registryTemplate(v.name) }, { author: "system", message: "competitors: empty registry", expectedVersion: 0 });
    } catch (err) {
      if (!(err instanceof BrainConflictError)) console.error(`[competitors] ${v.id}:`, (err as Error).message);
    }
  }
}

/**
 * Whether a schedule should fire now. The competitor watch is skipped while the business's
 * registry lists no competitors, so the weekly run costs nothing until there is someone to watch.
 * Anything else, and any doubt (the note can't be read), fires.
 */
export async function scheduleShouldFire(brain: Pick<Brain, "read">, vertical: Pick<VerticalManifest, "brainFolder">, scheduleId: string): Promise<boolean> {
  if (scheduleId !== COMPETITOR_WATCH_ID) return true;
  try {
    const note = await brain.read(competitorRegistryPath(vertical.brainFolder));
    return note ? parseRegistry(note.body).length > 0 : false;
  } catch {
    return true;
  }
}
