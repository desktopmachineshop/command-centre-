import type { Scene, VideoSpec } from "./spec";

/** One spoken word, in seconds from the start of its audio clip (or of the video, once placed). */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** The narration audio for one scene. */
export interface SceneVoice {
  durationSec: number;
  words: WordTiming[];
}

export interface TimelineScene {
  id: string;
  kind: Scene["kind"];
  /** Seconds from the start of the video. */
  start: number;
  duration: number;
  /** When this scene's narration starts, from the start of the video (null when silent). */
  voiceStart: number | null;
}

export interface Timeline {
  fps: number;
  total: number;
  scenes: TimelineScene[];
  /** Every narrated word, placed on the video's clock. Captions are built from these. */
  words: WordTiming[];
}

/** Default floor for a scene's length when its narration is short or missing. */
const MIN_DURATION: Record<Scene["kind"], number> = { title: 2.5, capture: 3, slide: 3, image: 3, outro: 4, logo: 1.5 };

/**
 * How much of a recording a capture scene uses once its `clip` is applied: where to start in
 * the file (after the blank lead trimmed at capture) and how long it then runs.
 */
export function clipWindow(scene: Scene, recording: { trimStartSec?: number; durationSec?: number }): { startSec: number; durationSec: number | undefined } {
  const clip = scene.kind === "capture" ? scene.clip : undefined;
  const from = clip?.startSec ?? 0;
  const full = recording.durationSec;
  const end = clip?.endSec !== undefined ? (full !== undefined ? Math.min(clip.endSec, full) : clip.endSec) : full;
  return { startSec: round3((recording.trimStartSec ?? 0) + from), durationSec: end === undefined ? undefined : round3(Math.max(0.1, end - from)) };
}

const toFrame = (seconds: number, fps: number) => Math.ceil(seconds * fps - 1e-6) / fps;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Lays scenes end to end. A scene lasts as long as the longest of: its
 * narration with lead-in and tail, its screen recording (so the action is not
 * cut off), and its minimum. Lengths are rounded up to whole frames so the
 * audio and the concatenated video stay in step.
 */
export function planTimeline(
  spec: Pick<VideoSpec, "fps" | "scenes">,
  voices: Record<string, SceneVoice | undefined>,
  clipDurations: Record<string, number | undefined> = {},
): Timeline {
  let cursor = 0;
  const scenes: TimelineScene[] = [];
  const words: WordTiming[] = [];
  for (const scene of spec.scenes) {
    const voice = scene.narration ? voices[scene.id] : undefined;
    const spoken = voice ? scene.leadInSec + voice.durationSec + scene.tailSec : 0;
    const duration = toFrame(Math.max(scene.minDurationSec ?? MIN_DURATION[scene.kind], spoken, clipDurations[scene.id] ?? 0), spec.fps);
    const voiceStart = voice ? round3(cursor + scene.leadInSec) : null;
    if (voice && voiceStart !== null) {
      for (const w of voice.words) words.push({ word: w.word, start: round3(voiceStart + w.start), end: round3(voiceStart + w.end) });
    }
    scenes.push({ id: scene.id, kind: scene.kind, start: round3(cursor), duration: round3(duration), voiceStart });
    cursor += duration;
  }
  return { fps: spec.fps, total: round3(cursor), scenes, words };
}

/**
 * Spreads words over a clip of known length when the TTS provider gives no
 * timings: each word gets time in proportion to its length, and punctuation
 * adds a pause. Good enough for captions; providers with real timings win.
 */
export function estimateWordTimings(text: string, durationSec: number): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || durationSec <= 0) return [];
  const weight = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "").length + 2 + (/[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
  const weights = tokens.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return tokens.map((word, i) => {
    const span = (durationSec * weights[i]!) / total;
    const pause = /[.!?]$/.test(word) ? 4 : /[,;:]$/.test(word) ? 2 : 0;
    const spoken = (span * (weights[i]! - pause)) / weights[i]!;
    const timing = { word, start: round3(t), end: round3(t + spoken) };
    t += span;
    return timing;
  });
}
