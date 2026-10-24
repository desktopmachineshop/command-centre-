#!/usr/bin/env tsx
/**
 * Renders the sample OpenD walkthrough end to end, locally and for free:
 * stand-in page → Playwright capture → flite (or silent) voice → captions → ffmpeg.
 *
 *   pnpm --filter @cc/video render:sample [--out file.mp4] [--voice flite|silent] [--preset veryfast] [--quality 20]
 *
 * Env: CC_CHROMIUM_BIN (default /opt/pw-browsers/chromium if present, else Playwright's own),
 *      CC_FFMPEG_BIN (default ffmpeg).
 */
import { copyFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lintSpec, parseSpec, silentProvider } from "../src";
import { captureScenes, ffmpegHas, ffprobeFor, fliteProvider, probe, renderVideo } from "../src/node";
import { sampleSpec, serveSample } from "../sample/opend-walkthrough";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv, // `pnpm run x -- --flag` passes the "--" through
  options: { out: { type: "string" }, voice: { type: "string" }, preset: { type: "string" }, quality: { type: "string" }, dir: { type: "string" } },
});
const ffmpeg = process.env.CC_FFMPEG_BIN ?? "ffmpeg";
const chromium = process.env.CC_CHROMIUM_BIN ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const site = await serveSample();
try {
  const spec = parseSpec(sampleSpec(site.url));
  for (const w of lintSpec(spec)) console.log(`[lint] ${w}`);
  const dir = values.dir ? resolve(values.dir) : await mkdtemp(join(tmpdir(), "cc-video-sample-"));
  const wantFlite = (values.voice ?? spec.voice.provider) === "flite";
  const flite = wantFlite && (await ffmpegHas(ffmpeg, "filters", "flite"));
  if (wantFlite && !flite) console.log("[voice] this ffmpeg has no flite filter; using silent narration");
  const tts = flite ? fliteProvider({ ffmpegBin: ffmpeg, dir: join(dir, "tts") }) : silentProvider();

  console.log(`[capture] ${dir}`);
  const scenes = spec.scenes.filter((s) => s.kind === "capture");
  const clips = await captureScenes(scenes, { dir, format: spec.format, brand: spec.brand, executablePath: chromium });
  for (const [id, c] of Object.entries(clips)) console.log(`[capture] ${id}: ${c.durationSec.toFixed(1)}s (trim ${c.trimStartSec.toFixed(2)}s)`);

  const started = Date.now();
  const out = await renderVideo({
    spec,
    dir,
    ffmpegBin: ffmpeg,
    tts,
    visuals: Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, { kind: "video", file: c.file, trimStartSec: c.trimStartSec, durationSec: c.durationSec }])),
    preset: values.preset ?? "veryfast",
    quality: values.quality ? Number(values.quality) : undefined,
    onProgress: (() => {
      let last = -1;
      return (f: number, m: string) => {
        const pct = Math.floor(f * 10);
        if (pct !== last) console.log(`[render] ${Math.round(f * 100)}% ${m}`);
        last = pct;
      };
    })(),
  });
  console.log(`[render] ${out.outputPath} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${(out.bytes / 1e6).toFixed(2)} MB`);

  const info = await probe(ffprobeFor(ffmpeg), out.outputPath);
  const v = info.streams.find((s) => s.codecType === "video");
  const a = info.streams.find((s) => s.codecType === "audio");
  console.log(`[ffprobe] duration ${info.durationSec.toFixed(2)}s, video ${v?.codecName} ${v?.width}x${v?.height}, audio ${a?.codecName ?? "none"} ${a?.sampleRate ?? ""}Hz ${a?.channels ?? ""}ch`);
  if (values.out) {
    await copyFile(out.outputPath, resolve(values.out));
    console.log(`[out] ${resolve(values.out)}`);
  }
} finally {
  await site.close();
}
