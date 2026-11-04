import { describe, expect, it } from "vitest";
import { fieldsOf, labelOf, readable, specFacts, stepText, videoSpecOf } from "../src/payload";

describe("readable proposal details", () => {
  it("labels keys in plain words", () => {
    expect(labelOf("accountId")).toBe("Account id");
    expect(labelOf("scheduled_at")).toBe("Scheduled at");
    expect(labelOf("cta")).toBe("Call to action");
  });

  it("turns values into text, links, images, colours and lists, dropping empties", () => {
    expect(readable("Hello")).toEqual({ kind: "text", text: "Hello" });
    expect(readable("#d9822b")).toEqual({ kind: "colour", hex: "#d9822b" });
    expect(readable("https://x.test/a.png")).toEqual({ kind: "image", url: "https://x.test/a.png" });
    expect(readable("https://x.test/page")).toEqual({ kind: "link", url: "https://x.test/page" });
    expect(readable(true)).toEqual({ kind: "text", text: "Yes" });
    expect(readable(["a", "", null])).toEqual({ kind: "list", items: [{ kind: "text", text: "a" }] });
    expect(readable({})).toBeNull();
    expect(readable("  ")).toBeNull();
  });

  it("orders fields addressing first, long text last, and hides server keys", () => {
    const keys = fieldsOf({ body: "Hi", policyDowngrade: "x", priority: 2, to: "a@b.c", subject: "S" }).map((f) => f.key);
    expect(keys).toEqual(["to", "subject", "priority", "body"]);
  });

  it("reads a video spec as a storyboard", () => {
    const spec = { title: "DMS reel", type: "short", format: "9:16", voice: { provider: "silent" }, scenes: [{ id: "hook", kind: "title", heading: "Hi" }] };
    expect(videoSpecOf(spec)).toBe(spec);
    expect(videoSpecOf({ scenes: [] })).toBeNull();
    expect(specFacts(spec)).toEqual([
      ["Title", "DMS reel"],
      ["Kind", "Short"],
      ["Format", "9:16 (portrait)"],
      ["Voiceover", "None (captions only)"],
    ]);
    expect(stepText({ action: "goto", url: "https://dms.test" })).toBe("Open https://dms.test");
    expect(stepText({ action: "type", selector: "#q", text: "milo" })).toBe("Type “milo” into #q");
    expect(stepText({ action: "wait", ms: 1500 })).toBe("Pause 1.5 s");
  });
});
