import { describe, expect, it } from "vitest";
import { readReadAloud, spokenText } from "../src/voice/readAloud";
import { barsFor } from "../src/voice/Waveform";

describe("spokenText", () => {
  it("drops markdown and code, keeps the words", () => {
    expect(spokenText("**Done.** See `x`.\n\n```\nrm -rf\n```\nAll good.")).not.toMatch(/\*\*|`|rm -rf/);
    expect(spokenText("**Done.** All good.")).toContain("Done");
  });
  it("says nothing for an empty message", () => {
    expect(spokenText("")).toBe("");
  });
});

describe("readReadAloud", () => {
  it("is off by default, and when storage is missing", () => {
    expect(readReadAloud()).toBe(false);
  });
});

describe("barsFor", () => {
  it("pads a short history on the left and keeps the newest bars", () => {
    expect(barsFor([0.5], 3)).toEqual([0, 0, 0.5]);
    expect(barsFor([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });
});
