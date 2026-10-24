import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSpec, silentProvider } from "../src";
import { captureScenes, ffmpegHas, ffprobeFor, fliteProvider, probe, renderVideo } from "../src/node";
import { sampleSpec, serveSample } from "../sample/opend-walkthrough";
import { CHROMIUM, FFMPEG, HAS_FFMPEG, HAS_PLAYWRIGHT } from "./helpers";

/**
 * The whole local pipeline on the sample spec: capture the stand-in page,
 * voice it (flite when this ffmpeg has it, else silence), caption it and
 * render an MP4, then check the file with ffprobe. No paid API, no network.
 */
describe.skipIf(!HAS_FFMPEG || !CHROMIUM || !HAS_PLAYWRIGHT)("end-to-end sample render", () => {
  let site: Awaited<ReturnType<typeof serveSample>>;
  beforeAll(async () => {
    site = await serveSample();
  });
  afterAll(async () => {
    await site?.close();
  });

  it("renders the OpenD walkthrough to a 1080p MP4 with voice and burned-in captions", async () => {
    const spec = parseSpec(sampleSpec(site.url));
    const dir = mkdtempSync(join(tmpdir(), "cc-e2e-"));
    const flite = await ffmpegHas(FFMPEG, "filters", "flite");
    const tts = flite ? fliteProvider({ ffmpegBin: FFMPEG, dir: join(dir, "tts") }) : silentProvider();

    const clips = await captureScenes(
      spec.scenes.filter((s) => s.kind === "capture"),
      { dir, format: spec.format, brand: spec.brand, executablePath: CHROMIUM! },
    );
    expect(Object.keys(clips)).toEqual(["open-topic", "edit", "preview", "save-publish"]);

    const progress: number[] = [];
    const out = await renderVideo({
      spec,
      dir,
      ffmpegBin: FFMPEG,
      tts,
      visuals: Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, { kind: "video" as const, file: c.file, trimStartSec: c.trimStartSec, durationSec: c.durationSec }])),
      preset: "ultrafast",
      onProgress: (f) => progress.push(f),
    });

    // Each capture scene lasts at least as long as its recording.
    for (const [id, clip] of Object.entries(clips)) {
      expect(out.timeline.scenes.find((s) => s.id === id)!.duration).toBeGreaterThanOrEqual(clip.durationSec - 0.001);
    }
    expect(progress.at(-1)).toBeGreaterThan(0.9);
    expect(existsSync(out.srtPath!)).toBe(true);
    expect(readFileSync(out.srtPath!, "utf8")).toContain("Spotted a mistake in your docs?");

    const info = await probe(ffprobeFor(FFMPEG), out.outputPath);
    const video = info.streams.find((s) => s.codecType === "video");
    const audio = info.streams.find((s) => s.codecType === "audio");
    expect(video).toMatchObject({ codecName: "h264", width: 1920, height: 1080 });
    expect(audio).toMatchObject({ codecName: "aac", sampleRate: 48000, channels: 2 });
    expect(Math.abs(info.durationSec - out.timeline.total)).toBeLessThan(0.15);
    expect(out.timeline.total).toBeGreaterThan(25);
    expect(out.timeline.total).toBeLessThan(90);
  });
});
