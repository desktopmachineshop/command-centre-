import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Pkg = { name: string; dependencies?: Record<string, string> };
const root = join(import.meta.dirname, "../../..");
const read = (path: string): Pkg => JSON.parse(readFileSync(path, "utf8"));

describe("server bundle", () => {
  // tsup inlines @cc/* workspace packages but leaves npm packages external, so
  // every npm dependency of a bundled workspace package must also be a server dependency.
  it("declares the npm dependencies of every bundled workspace package", () => {
    const server = read(join(root, "apps/server/package.json"));
    const workspace = new Map(
      readdirSync(join(root, "packages")).map((dir) => {
        const pkg = read(join(root, "packages", dir, "package.json"));
        return [pkg.name, pkg] as const;
      }),
    );

    const missing: string[] = [];
    const seen = new Set<string>();
    const walk = (name: string) => {
      const pkg = workspace.get(name);
      if (!pkg || seen.has(name)) return;
      seen.add(name);
      for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
        if (version.startsWith("workspace:")) walk(dep);
        else if (!server.dependencies?.[dep]) missing.push(`${dep} (from ${name})`);
      }
    };
    for (const [dep, version] of Object.entries(server.dependencies ?? {})) if (version.startsWith("workspace:")) walk(dep);

    expect(missing).toEqual([]);
  });
});
