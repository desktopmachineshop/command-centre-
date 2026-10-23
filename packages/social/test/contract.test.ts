import { describe, expect, it } from "vitest";
import { adapters, Platform, validateAgainstCapabilities } from "../src";

describe("social contract", () => {
  it("has one adapter per platform", () => {
    for (const p of Platform.options) expect(adapters[p].platform).toBe(p);
  });

  it("validates content against capabilities", () => {
    const caps = { publish: true, reply: true, dm: false, inbound: true, media: ["image" as const], maxTextLength: 10, requiresMedia: true, requiresTitle: true };
    expect(validateAgainstCapabilities(caps, { text: "x".repeat(11), media: [{ url: "u", type: "video" }] })).toEqual([
      "text is longer than 10 characters",
      "video media is not supported",
      "a title is required",
    ]);
    expect(validateAgainstCapabilities(caps, { text: "hi", title: "t" })).toEqual(["at least one image or video is required"]);
  });
});
