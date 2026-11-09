import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRANDS, Brand, lintSpec, PRODUCTS, parseSpec, VideoRenderPayload, VideoSpec } from "../src";
import { sampleSpec } from "../sample/opend-walkthrough";
import { minimalSpec } from "./helpers";

describe("VideoSpec", () => {
  it("fills defaults", () => {
    const spec = parseSpec(minimalSpec());
    expect(spec).toMatchObject({ version: 1, fps: 30, voice: { provider: "auto", speed: 1 }, captions: { enabled: true, style: "word", background: "outline" }, transition: { style: "fade", durationSec: 0.2 }, sources: [] });
    expect(spec.scenes[1]).toMatchObject({ kind: "capture", fit: "contain", cursor: true, leadInSec: 0.3, tailSec: 0.4 });
  });

  it("keeps each brand's guidelines in skills/video-reel/brands with the same brand kit as the code", () => {
    expect(Object.keys(BRANDS).sort()).toEqual([...PRODUCTS].sort());
    for (const product of PRODUCTS) {
      const md = readFileSync(fileURLToPath(new URL(`../../../skills/video-reel/brands/${product}.md`, import.meta.url)), "utf8");
      const kit = md.match(/## Brand kit[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];
      expect(kit, product).toBeDefined();
      expect(Brand.parse(JSON.parse(kit!)), product).toEqual(BRANDS[product]);
      expect(() => parseSpec({ ...minimalSpec(), product, brand: BRANDS[product] }), product).not.toThrow();
    }
  });

  it("accepts the sample walkthrough", () => {
    expect(() => parseSpec(sampleSpec("http://127.0.0.1:1234"))).not.toThrow();
  });

  it("rejects duplicate scene ids, captures that don't start with goto, and bad formats", () => {
    const dup = VideoSpec.safeParse(minimalSpec({ scenes: [{ id: "a", kind: "title", heading: "x" }, { id: "a", kind: "title", heading: "y" }] }));
    expect(dup.success).toBe(false);
    expect(JSON.stringify(dup.error?.issues)).toMatch(/duplicate scene id/);

    const noGoto = VideoSpec.safeParse(minimalSpec({ scenes: [{ id: "a", kind: "capture", steps: [{ action: "click", selector: "#x" }] }] }));
    expect(JSON.stringify(noGoto.error?.issues)).toMatch(/must start with a goto/);

    expect(VideoSpec.safeParse({ ...minimalSpec(), format: "4:3" }).success).toBe(false);
  });

  it("only allows http(s) pages, plain font names and single-line screen text", () => {
    const bad = (scene: unknown) => VideoSpec.safeParse(minimalSpec({ scenes: [scene as never] })).success;
    expect(bad({ id: "a", kind: "capture", steps: [{ action: "goto", url: "file:///etc/passwd" }] })).toBe(false);
    expect(bad({ id: "a", kind: "capture", steps: [{ action: "goto", url: "javascript:alert(1)" }] })).toBe(false);
    expect(bad({ id: "a", kind: "title", heading: "two\nlines" })).toBe(false);
    expect(bad({ id: "Bad_Id", kind: "title", heading: "x" })).toBe(false);
    const font = VideoSpec.safeParse({ ...minimalSpec(), brand: { ...minimalSpec().brand!, fonts: { heading: "Inter:fontsdir=/", body: "Inter" } } });
    expect(font.success).toBe(false);
  });

  it("lints length, hook, CTA and sources", () => {
    const long = parseSpec(minimalSpec({ scenes: [{ id: "a", kind: "title", heading: "x", narration: "word ".repeat(200) }] }));
    const warnings = lintSpec(long);
    expect(warnings.join("\n")).toMatch(/over the 60s target/);
    expect(warnings.join("\n")).toMatch(/hook/);
    expect(warnings.join("\n")).toMatch(/no outro/);
    expect(warnings.join("\n")).toMatch(/no sources/);
    // The sample is a keyless draft: only the quality warnings a draft earns.
    expect(lintSpec(parseSpec(sampleSpec("http://x.test")))).toEqual([expect.stringMatching(/flite voice is robotic/), expect.stringMatching(/no brand logo/)]);
  });

  it("validates render payloads", () => {
    const spec = minimalSpec();
    expect(VideoRenderPayload.parse({ spec }).encoder).toBe("auto");
    expect(VideoRenderPayload.safeParse({ spec, outputName: "../evil.mp4" }).success).toBe(false);
    expect(VideoRenderPayload.safeParse({ spec, outputName: "out.exe" }).success).toBe(false);
    expect(VideoRenderPayload.safeParse({ spec, assets: { demo: { url: "file:///c/x.webm" } } }).success).toBe(false);
  });
});
