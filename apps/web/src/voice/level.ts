/**
 * Live audio level for the recording waveform and Drive mode's orb: read once per animation
 * frame, 0 (silence) to 1 (loud speech).
 */
export interface LevelSource {
  read(): number;
}

/** RMS of a frame of samples. Pure. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * RMS → 0..1 on a decibel scale: room noise (below about -55 dB) reads as 0, normal speech
 * near the microphone (about -20 dB) reads about 0.8, and only loud speech (-10 dB and up) fills
 * the bar, so the waveform keeps some headroom instead of sitting at the top. Pure.
 */
export function rmsToLevel(value: number, floorDb = -55, ceilDb = -10): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  return Math.min(1, Math.max(0, (db - floorDb) / (ceilDb - floorDb)));
}

/** Fast attack, slow release, so bars jump with a syllable and fall back gently. Pure. */
export function smooth(previous: number, next: number, attack = 0.6, release = 0.12): number {
  return previous + (next - previous) * (next > previous ? attack : release);
}

/** A level read from an AnalyserNode (a microphone stream or the voice being played). */
export class AnalyserLevel implements LevelSource {
  private readonly buffer: Float32Array<ArrayBuffer>;
  private value = 0;

  constructor(private readonly analyser: AnalyserNode) {
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(analyser.fftSize);
  }

  read(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    this.value = smooth(this.value, rmsToLevel(rms(this.buffer)));
    return this.value;
  }
}

/**
 * A level nudged by events, for audio the page can't hear (browser speech synthesis, or browser
 * recognition where a second microphone capture would break it): each `pulse()` lifts it, and it
 * wobbles a little while `active`, decaying otherwise.
 */
export class PulseLevel implements LevelSource {
  private value = 0;
  private target = 0;
  active = false;

  pulse(strength = 0.8) {
    this.target = Math.max(this.target, strength);
  }

  read(): number {
    const t = performance.now() / 1000;
    const wobble = this.active ? 0.35 + 0.25 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1) : 0;
    this.target *= 0.9;
    this.value = smooth(this.value, Math.max(this.target, wobble));
    return Math.max(0, Math.min(1, this.value));
  }
}

/** Always silent. */
export const SILENT: LevelSource = { read: () => 0 };

/** Level a frame must beat to count as speech: well above the room's own noise, never below 0.02. Pure. */
export function speechThreshold(noiseFloor: number, minimum = 0.02, factor = 3): number {
  return Math.max(minimum, noiseFloor * factor);
}

/**
 * Slow-moving estimate of steady background noise. Frames judged quiet move it quickly; frames
 * judged speech move it slowly, so noise that starts out louder than the threshold (an engine) is
 * still learnt within a few seconds, while speech itself barely lifts it. Pure.
 */
export function updateNoiseFloor(floor: number, rms: number, speech = false, rate = 0.05, speechRate = 0.01): number {
  return floor + (rms - floor) * (speech ? speechRate : rate);
}
