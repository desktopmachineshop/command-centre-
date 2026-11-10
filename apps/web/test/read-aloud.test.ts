import { describe, expect, it } from "vitest";
import { forgetReadAloud, spokenText } from "../src/voice/readAloud";
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

describe("forgetReadAloud", () => {
  it("clears a choice kept by an earlier version, and copes without storage", () => {
    expect(() => forgetReadAloud()).not.toThrow();
    const store = new Map([["cc.readAloud", "1"]]);
    (globalThis as { localStorage?: unknown }).localStorage = { removeItem: (k: string) => store.delete(k) };
    forgetReadAloud();
    expect(store.has("cc.readAloud")).toBe(false);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe("barsFor", () => {
  it("pads a short history on the left and keeps the newest bars", () => {
    expect(barsFor([0.5], 3)).toEqual([0, 0, 0.5]);
    expect(barsFor([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });
});
