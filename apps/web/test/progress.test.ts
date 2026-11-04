import { describe, expect, it } from "vitest";
import { describeActivity, describeCommand, latestCommand, ProgressNarrator } from "../src/progress";

const tool = (name: string, input: unknown = {}) => ({ type: "tool_use" as const, name, input });

describe("progress lines", () => {
  it("puts tools in plain words and ignores everything else", () => {
    expect(describeActivity(tool("Bash"))).toBe("Running a command");
    expect(describeActivity(tool("mcp__brain__search"))).toBe("Checking my notes");
    expect(describeActivity(tool("Mystery"))).toBe("Working on it");
    expect(describeActivity({ type: "text", text: "hi" })).toBeNull();
  });

  it("shows the command line form with a short hint", () => {
    expect(describeCommand(tool("Bash", { command: "pnpm  test" }))).toBe("Bash  pnpm test");
    expect(describeCommand(tool("Agent"))).toBe("Agent");
    expect(latestCommand([tool("Read", { file_path: "a.ts" }), { type: "text", text: "x" }])).toBe("Read  a.ts");
  });
});

describe("the spoken narrator", () => {
  it("waits, then speaks at most one new line per interval", () => {
    const n = new ProgressNarrator(25_000, 10_000);
    n.start(0);
    expect(n.next(tool("Read"), 5_000)).toBeNull();
    expect(n.next(tool("Read"), 11_000)).toBe("Reading files.");
    expect(n.next(tool("Bash"), 20_000)).toBeNull();
    expect(n.next(tool("Bash"), 37_000)).toBe("Running a command.");
    expect(n.next(tool("Bash"), 90_000)).toBeNull();
  });

  it("stays quiet after a canned line was spoken", () => {
    const n = new ProgressNarrator(25_000, 10_000);
    n.start(0);
    n.spoke(30_000);
    expect(n.next(tool("Grep"), 40_000)).toBeNull();
    expect(n.next(tool("Grep"), 56_000)).toBe("Searching the code.");
  });
});
