import { describe, expect, it } from "vitest";
import { tree } from "../src/pages/Brain";

describe("brain folder tree", () => {
  it("nests notes under their folders, folders first, with counts", () => {
    const root = tree(["README.md", "dms/work-instructions/b.md", "dms/a.md", "dms/work-instructions/a.md", "personal/x.md"]);
    expect(root.notes).toEqual(["README.md"]);
    expect(root.folders.map((f) => [f.name, f.count])).toEqual([
      ["dms", 3],
      ["personal", 1],
    ]);
    const dms = root.folders[0]!;
    expect(dms.notes).toEqual(["dms/a.md"]);
    expect(dms.folders[0]).toMatchObject({ name: "work-instructions", prefix: "dms/work-instructions/", notes: ["dms/work-instructions/a.md", "dms/work-instructions/b.md"] });
  });
});
