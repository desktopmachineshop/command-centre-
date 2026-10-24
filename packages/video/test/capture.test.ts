import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSpec, type CaptureScene } from "../src";
import { CaptureError, captureScene, ffprobeFor, probe } from "../src/node";
import { sampleSpec, serveSample } from "../sample/opend-walkthrough";
import { CHROMIUM, FFMPEG, HAS_FFMPEG, HAS_PLAYWRIGHT } from "./helpers";

describe.skipIf(!CHROMIUM || !HAS_PLAYWRIGHT)("capture runner (Chromium, local stand-in page)", () => {
  let site: Awaited<ReturnType<typeof serveSample>>;
  beforeAll(async () => {
    site = await serveSample();
  });
  afterAll(async () => {
    await site?.close();
  });

  it("plays the scripted steps and records a trimmed WebM", async () => {
    const spec = parseSpec(sampleSpec(site.url));
    const scene = spec.scenes.find((s) => s.id === "save-publish") as CaptureScene;
    const dir = mkdtempSync(join(tmpdir(), "cc-capture-"));
    const steps: string[] = [];
    const clip = await captureScene(scene, { dir, format: spec.format, brand: spec.brand, executablePath: CHROMIUM!, onStep: (_i, s) => steps.push(s.action) });

    expect(steps).toEqual(scene.steps.map((s) => s.action));
    expect(clip.file).toBe("save-publish.webm");
    expect(clip.bytes).toBeGreaterThan(10_000);
    expect(clip.trimStartSec).toBeGreaterThan(0);
    expect(clip.trimStartSec).toBeLessThan(5);
    // 3 clicks with cursor moves (~0.9s each) + highlights (2.4s) + settle
    expect(clip.durationSec).toBeGreaterThan(4);

    if (HAS_FFMPEG) {
      const info = await probe(ffprobeFor(FFMPEG), clip.path);
      expect(info.streams[0]).toMatchObject({ codecType: "video", codecName: "vp8", width: 1280, height: 720 });
      expect(info.durationSec).toBeGreaterThan(clip.durationSec - 0.5);
    }
  });

  it("fails clearly when an element is missing or a profile is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-capture-"));
    const spec = parseSpec(
      sampleSpec(site.url),
    );
    const scene = { ...(spec.scenes[1] as CaptureScene), steps: [{ action: "goto" as const, url: `${site.url}/index.html` }, { action: "click" as const, selector: "#does-not-exist" }] };
    await expect(captureScene(scene, { dir, format: "16:9", brand: spec.brand, executablePath: CHROMIUM!, stepTimeoutMs: 1000 })).rejects.toThrow(/capture of "open-topic" failed/);
    await expect(captureScene({ ...scene, authProfile: "opend-demo" }, { dir, format: "16:9", brand: spec.brand, executablePath: CHROMIUM! })).rejects.toThrow(CaptureError);
  });
});
