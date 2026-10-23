import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_VERTICAL, VerticalRegistry, verticals } from "../src";

describe("vertical registry", () => {
  it("has unique ids and the default vertical", () => {
    const reg = new VerticalRegistry();
    expect(reg.all()).toHaveLength(verticals.length);
    expect(reg.get(DEFAULT_VERTICAL)).toBeDefined();
  });

  it("rejects duplicates", () => {
    expect(() => new VerticalRegistry([verticals[0]!, verticals[0]!])).toThrow(/Duplicate/);
  });

  it("lists only skills that exist in the skills bank", () => {
    for (const skill of new Set(verticals.flatMap((v) => v.skills))) {
      const file = fileURLToPath(new URL(`../../../skills/${skill}/SKILL.md`, import.meta.url));
      expect(existsSync(file), skill).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+`));
    }
  });

  it("brain folders are unique", () => {
    const folders = verticals.map((v) => v.brainFolder);
    expect(new Set(folders).size).toBe(folders.length);
  });
});
