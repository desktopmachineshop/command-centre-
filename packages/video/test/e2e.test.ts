import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatch, buildEditTimeline, editFiles, fileUrl, FRAME, parseSpec, planRevision, relinkFcpxml, silentProvider, type TextToSpeech, toFcpxml, type VideoSpec } from "../src";
import { type CaptureResult, captureScenes, ffmpegHas, ffprobeFor, fliteProvider, probe, renderVideo, type VoiceFile } from "../src/node";
import { sampleSpec, serveSample } from "../sample/opend-walkthrough";
import { CHROMIUM, FFMPEG, HAS_FFMPEG, HAS_PLAYWRIGHT } from "./helpers";

/**
 * The whole local pipeline on the sample spec: capture the stand-in page,
 * voice it (flite when this ffmpeg has it, else silence), caption it and
 * render an MP4, then check the file with ffprobe. Then a revision of it (re-using the
 * recordings and narration) and its export as an editable timeline. No paid API, no network.
 */
describe.skipIf(!HAS_FFMPEG || !CHROMIUM || !HAS_PLAYWRIGHT)("end-to-end sample render", () => {
  let site: Awaited<ReturnType<typeof serveSample>>;
  let spec: VideoSpec;
  let dir: string;
  let clips: Record<string, CaptureResult>;
  let tts: TextToSpeech;
  let said: string[];
  let first: Awaited<ReturnType<typeof renderVideo>>;
  const visuals = () => Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, { kind: "video" as const, file: c.file, trimStartSec: c.trimStartSec, durationSec: c.durationSec }]));

  beforeAll(async () => {
    site = await serveSample();
    spec = parseSpec(sampleSpec(site.url));
    dir = mkdtempSync(join(tmpdir(), "cc-e2e-"));
    const flite = await ffmpegHas(FFMPEG, "filters", "flite");
    const voice = flite ? fliteProvider({ ffmpegBin: FFMPEG, dir: join(dir, "tts") }) : silentProvider();
    said = [];
    tts = { ...voice, synthesize: (text, o) => (said.push(text), voice.synthesize(text, o)) };
    clips = await captureScenes(
      spec.scenes.filter((s) => s.kind === "capture"),
      { dir, format: spec.format, brand: spec.brand, executablePath: CHROMIUM! },
    );
  }, 120_000);
  afterAll(async () => {
    await site?.close();
  });

  it("renders the OpenD walkthrough to a 1080p MP4 with voice and burned-in captions", async () => {
    expect(Object.keys(clips)).toEqual(["open-topic", "edit", "preview", "save-publish"]);

    const progress: number[] = [];
    const out = await renderVideo({ spec, dir, ffmpegBin: FFMPEG, tts, visuals: visuals(), preset: "ultrafast", stems: true, onProgress: (f) => progress.push(f) });
    first = out;

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

    // The mix never clips: the limiter holds the peak under full scale.
    const meter = spawnSync(FFMPEG, ["-hide_banner", "-i", out.outputPath, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    expect(Number(/max_volume: (-?[\d.]+) dB/.exec(meter)?.[1])).toBeLessThanOrEqual(-1);
  }, 180_000);

  it("exports the render as an editable timeline whose clips exist and add up", async () => {
    const stems = first.stems!;
    expect(Object.keys(stems)).toEqual(spec.scenes.map((s) => s.id));
    for (const [i, scene] of spec.scenes.entries()) {
      const info = await probe(ffprobeFor(FFMPEG), stems[scene.id]!.path);
      // Picture only, the frame size of the video, as long as its place in the timeline.
      expect(info.streams.map((s) => s.codecType), scene.id).toEqual(["video"]);
      expect(info.streams[0]).toMatchObject({ codecName: "h264", width: 1920, height: 1080 });
      expect(Math.abs(info.durationSec - first.timeline.scenes[i]!.duration), scene.id).toBeLessThan(0.05);
    }
    const edit = buildEditTimeline(spec, FRAME[spec.format], first.timeline, {
      scenes: Object.fromEntries(Object.entries(stems).map(([id, s]) => [id, s.file])),
      voices: Object.fromEntries(Object.entries(first.voices).map(([id, v]) => [id, { file: v.file, durationSec: v.durationSec }])),
      srt: "captions.srt",
    });
    const doc = relinkFcpxml(toFcpxml(edit), (file) => fileUrl(join(dir, file)));
    for (const file of editFiles(edit)) expect(existsSync(join(dir, file)), file).toBe(true);
    expect(doc.match(/src="file:\/\//g)).toHaveLength(editFiles(edit).length);
    // The spine is as long as the render, to the frame.
    const frames = [...doc.matchAll(/^ {12}<asset-clip [^>]*duration="(\d+)\/30s" tcFormat/gm)].reduce((n, m) => n + Number(m[1]), 0);
    expect(frames).toBe(Math.round(first.timeline.total * 30));
    expect(doc).toContain(`<sequence format="r1" duration="${frames}/30s"`);
    // Narration sits under its scene: one dialogue clip per narrated scene.
    expect(doc.match(/audioRole="dialogue"/g)).toHaveLength(spec.scenes.filter((s) => s.narration).length);
  }, 60_000);

  it("renders a revision from the stored recordings and narration, voicing only what changed", async () => {
    // What the first render left behind is the project's pool.
    const made = planRevision({ spec, pool: [] });
    const pool = Object.values(made.assets).flatMap((k) => [k.voice, k.capture].filter((x): x is string => !!x));
    const next = applyPatch(spec, {
      set: { captions: { style: "plain", background: "box" }, transition: { style: "cut" } },
      scenes: [
        { op: "update", id: spec.scenes[0]!.id, set: { narration: "Found a typo in your docs?" } },
        { op: "update", id: "edit", set: { clip: { startSec: 0.5, endSec: 2.5 } } },
        { op: "move", id: "preview", before: "edit" },
      ],
    });
    const plan = planRevision({ spec: next, pool, renderedComposeKey: made.composeKey });
    expect(plan.voice.make).toEqual([next.scenes[0]!.id]);
    expect(plan.capture.make).toEqual([]);

    // Re-use by key: every narration the pool has, by the scene that now carries it.
    const byKey = new Map(spec.scenes.filter((s) => made.assets[s.id]!.voice).map((s) => [made.assets[s.id]!.voice!, first.voices[s.id]!]));
    const voices: Record<string, VoiceFile> = {};
    for (const s of next.scenes) {
      const kept = byKey.get(plan.assets[s.id]?.voice ?? "");
      if (kept) voices[s.id] = kept;
    }
    said.length = 0;
    const out = await renderVideo({ spec: next, dir, ffmpegBin: FFMPEG, tts, voices, visuals: visuals(), preset: "ultrafast", outputName: "revision.mp4" });
    expect(said).toEqual(["Found a typo in your docs?"]);
    expect(out.timeline.scenes.map((s) => s.id).slice(1, 4)).toEqual(["open-topic", "preview", "edit"]);
    // Only 2 seconds of the recording play (its last frame is held while the narration finishes).
    expect(out.timeline.scenes.find((s) => s.id === "edit")!.duration).toBeLessThanOrEqual(first.timeline.scenes.find((s) => s.id === "edit")!.duration);
    expect(out.plan.args.join(" ")).toContain(`-t 2 -i ${clips.edit!.file}`);
    const info = await probe(ffprobeFor(FFMPEG), out.outputPath);
    expect(Math.abs(info.durationSec - out.timeline.total)).toBeLessThan(0.15);
    expect(readFileSync(out.captionsPath!, "utf8")).toMatch(/Style: Caption,.*,3,\d+,0,2,/); // the box style
  }, 180_000);

  it("renders a vertical short with a still (Ken Burns), a logo and ducked music, at broadcast loudness", async () => {
    const short = mkdtempSync(join(tmpdir(), "cc-e2e-short-"));
    execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1600x900:d=1", "-frames:v", "1", join(short, "still.png")]);
    execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "color=c=white:s=400x120:d=1", "-frames:v", "1", join(short, "logo.png")]);
    execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-af", "volume=0.9", join(short, "music.wav")]);
    const vertical = parseSpec({
      ...sampleSpec(site.url),
      id: "short",
      type: "short",
      format: "9:16",
      music: { url: "https://example.com/music.wav", volumeDb: -18, credit: "test tone" },
      scenes: [
        { id: "sting", kind: "logo" },
        { id: "hook", kind: "title", heading: "Docs that ship", narration: "Fix your docs in under a minute." },
        { id: "shot", kind: "image", url: "https://example.com/still.png", alt: "The editor", narration: "Edit the page, preview it, and publish." },
        { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it free", url: "opend.app" },
      ],
    });
    const out = await renderVideo({ spec: vertical, dir: short, ffmpegBin: FFMPEG, tts, visuals: { shot: { kind: "image", file: "still.png" } }, logoFile: "logo.png", musicFile: "music.wav", preset: "ultrafast" });
    const info = await probe(ffprobeFor(FFMPEG), out.outputPath);
    expect(info.streams.find((s) => s.codecType === "video")).toMatchObject({ width: 1080, height: 1920 });
    expect(out.timeline.scenes[0]).toMatchObject({ id: "sting", kind: "logo", duration: 1.5 });
    expect(out.plan.filterGraph).toContain("overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,0,1.5)'");
    // The end card is held long enough to read.
    expect(out.timeline.scenes.at(-1)!.duration).toBeGreaterThanOrEqual(4);
    const meter = spawnSync(FFMPEG, ["-hide_banner", "-i", out.outputPath, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const summary = meter.slice(meter.lastIndexOf("Summary:"));
    const loudness = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    expect(loudness).toBeGreaterThan(-17);
    expect(loudness).toBeLessThan(-12);
    expect(peak).toBeLessThanOrEqual(-0.9);
  }, 180_000);
});
