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

  it("brain folders are unique", () => {
    const folders = verticals.map((v) => v.brainFolder);
    expect(new Set(folders).size).toBe(folders.length);
  });
});
