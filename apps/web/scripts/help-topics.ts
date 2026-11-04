// Writes src/help-topics.json: each help context key the docs declare (a resourceid with
// appname="command-centre" in docs/topics) and the page, or page#section, it opens.
// The app uses it to open help in a new tab when the OpenD panel isn't available (see
// src/help.ts). test/help.e2e.test.ts fails when it is out of date; rerun after editing docs:
//   pnpm --filter @cc/web help-topics
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const DOCS_DIR = here("../../../docs");
export const OUT = here("../src/help-topics.json");

const ditaFiles = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? ditaFiles(p) : p.endsWith(".dita") ? [p] : [];
    });

/** Key → docs-relative page URL, with `#id` when the key belongs to a nested topic. */
export function helpTopics(docsDir = DOCS_DIR, app = "command-centre"): Record<string, string> {
  const map: Record<string, string> = {};
  for (const file of ditaFiles(join(docsDir, "topics"))) {
    const xml = readFileSync(file, "utf8");
    const page = relative(docsDir, file).split(sep).join("/").replace(/\.dita$/, ".html");
    const topics = [...xml.matchAll(/<(?:topic|concept|task|reference|troubleshooting)\s[^>]*?\bid="([^"]+)"/g)];
    const root = topics[0]?.index;
    for (const m of xml.matchAll(/<resourceid\s[^>]*?appname="([^"]+)"[^>]*?appid="([^"]+)"/g)) {
      if (m[1] !== app) continue;
      // A resourceid sits in the prolog of the topic that opens just before it.
      const owner = topics.filter((t) => t.index! < m.index!).at(-1);
      map[m[2]!] = owner && owner.index !== root ? `${page}#${owner[1]}` : page;
    }
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, `${JSON.stringify(helpTopics(), null, 2)}\n`);
  console.log(`wrote ${relative(process.cwd(), OUT)}`);
}
