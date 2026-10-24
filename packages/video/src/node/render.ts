import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCues, cardEvents, DEFAULT_MAX_CHARS, toAss, toSrt } from "../captions";
import { buildComposePlan, type ComposePlan, type VideoEncoder, type VisualAsset } from "../compose";
import { FRAME, type VideoSpec } from "../spec";
import { estimateWordTimings, planTimeline, type SceneVoice, type Timeline, type WordTiming } from "../timeline";
import { speechExt, type TextToSpeech } from "../tts/types";
import { runFfmpeg } from "./ffmpeg";

/** Narration already on disk (synthesised by the server or an earlier step). */
export interface VoiceFile extends SceneVoice {
  file: string;
}

export interface RenderOptions {
  spec: VideoSpec;
  /** Render directory: every input file is inside it, and the output is written there. */
  dir: string;
  ffmpegBin: string;
  /** Recordings and images per scene id (files in `dir`); `durationSec` keeps a recording from being cut short. */
  visuals: Record<string, VisualAsset & { durationSec?: number }>;
  /** Narration per scene id, if already made. */
  voices?: Record<string, VoiceFile>;
  /** Voices any narrated scene that has no entry in `voices`. */
  tts?: TextToSpeech;
  logoFile?: string;
  musicFile?: string;
  fontsDir?: string;
  encoder?: VideoEncoder;
  preset?: string;
  /** CRF (x264) or CQ (NVENC); lower is better and bigger. */
  quality?: number;
  outputName?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface RenderOutput {
  outputPath: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
  encoder: VideoEncoder;
  timeline: Timeline;
  captionsPath: string | null;
  srtPath: string | null;
  plan: ComposePlan;
}

/**
 * Voice → captions → compose: synthesises missing narration, lays out the
 * timeline, writes the ASS/SRT files and runs the compositor's ffmpeg command.
 */
export async function renderVideo(options: RenderOptions): Promise<RenderOutput> {
  const { spec, dir } = options;
  await mkdir(dir, { recursive: true });
  const progress = options.onProgress ?? (() => {});

  // --- voice ---
  const voices: Record<string, VoiceFile> = { ...options.voices };
  const narrated = spec.scenes.filter((s) => s.narration && !voices[s.id]);
  for (const [i, scene] of narrated.entries()) {
    if (!options.tts) throw new Error(`scene "${scene.id}" has narration but no voice and no TTS provider`);
    progress((0.15 * i) / narrated.length, `voicing ${scene.id}`);
    const result = await options.tts.synthesize(scene.narration!, { voiceId: spec.voice.voiceId, speed: spec.voice.speed, signal: options.signal });
    const file = `voice-${scene.id}.${speechExt(result.mime)}`;
    await writeFile(join(dir, file), result.audio);
    voices[scene.id] = { file, durationSec: result.durationSec, words: result.words ?? estimateWordTimings(scene.narration!, result.durationSec) };
  }

  // --- timeline and captions ---
  const clipDurations = Object.fromEntries(Object.entries(options.visuals).map(([id, v]) => [id, v.durationSec]));
  const timeline = planTimeline(spec, voices, clipDurations);
  const cues = spec.captions.enabled ? buildCues(timeline.words as WordTiming[], { maxChars: spec.captions.maxChars ?? DEFAULT_MAX_CHARS[spec.format] }) : [];
  const ass = toAss(cues, cardEvents(spec, timeline), { format: spec.format, brand: spec.brand, style: spec.captions.style });
  const assFile = "captions.ass";
  await writeFile(join(dir, assFile), ass);
  let srtPath: string | null = null;
  if (cues.length) {
    srtPath = join(dir, "captions.srt");
    await writeFile(srtPath, toSrt(cues)); // uploaded next to the video for YouTube's own captions
  }

  // --- compose ---
  const encoder = options.encoder ?? "libx264";
  const outputName = options.outputName ?? `${spec.id}.mp4`;
  const plan = buildComposePlan({
    spec,
    timeline,
    visuals: options.visuals,
    narration: Object.fromEntries(Object.entries(voices).map(([id, v]) => [id, v.file])),
    subtitles: assFile,
    fontsDir: options.fontsDir,
    logo: options.logoFile,
    music: options.musicFile,
    encoder,
    preset: options.preset,
    quality: options.quality,
    output: outputName,
  });
  progress(0.2, "rendering");
  await runFfmpeg(options.ffmpegBin, plan.args, {
    cwd: dir,
    signal: options.signal,
    durationSec: timeline.total,
    onProgress: (f, s) => progress(0.2 + 0.79 * f, `rendered ${s.toFixed(1)}s of ${timeline.total.toFixed(1)}s`),
  });
  const outputPath = join(dir, outputName);
  const { width, height } = FRAME[spec.format];
  return {
    outputPath,
    bytes: (await stat(outputPath)).size,
    durationSec: timeline.total,
    width,
    height,
    encoder,
    timeline,
    captionsPath: join(dir, assFile),
    srtPath,
    plan,
  };
}
