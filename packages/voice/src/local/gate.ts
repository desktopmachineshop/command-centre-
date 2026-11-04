/**
 * Passes speech to the recogniser and silence in place of everything else, so rustling, bumps and
 * background chatter never turn into stray words, while the recogniser's own pause detection
 * still counts the quiet. A little audio from just before speech is detected (the preroll) goes
 * in with it, so the first syllable isn't clipped; a short hangover keeps the ends of words.
 *
 * Kept as plain JavaScript source: the recognition worker (engine.ts) evaluates it as is, and a
 * bundler can't add helpers to it. `SpeechGate` below is the same code, for the server and tests.
 */
export const SPEECH_GATE_SOURCE = `class SpeechGate {
  constructor(prerollSamples = 8000, hangoverSamples = 6400) {
    this.prerollSamples = prerollSamples;
    this.hangoverSamples = hangoverSamples;
    this.preroll = new Float32Array(0);
    this.open = false;
    this.quiet = 0;
  }
  push(samples, speaking) {
    if (speaking) {
      this.quiet = 0;
      if (this.open) return samples;
      this.open = true;
      const out = new Float32Array(this.preroll.length + samples.length);
      out.set(this.preroll);
      out.set(samples, this.preroll.length);
      this.preroll = new Float32Array(0);
      return out;
    }
    if (this.open) {
      this.quiet += samples.length;
      if (this.quiet <= this.hangoverSamples) return samples;
      this.open = false;
    }
    const joined = new Float32Array(this.preroll.length + samples.length);
    joined.set(this.preroll);
    joined.set(samples, this.preroll.length);
    this.preroll = joined.slice(Math.max(0, joined.length - this.prerollSamples));
    return new Float32Array(samples.length);
  }
}`;

export interface SpeechGate {
  /** True while speech (or its hangover) is passing through. */
  readonly open: boolean;
  /** `samples`: the cleaned audio; `speaking`: the voice detector hears speech now. Returns what the recogniser gets. */
  push(samples: Float32Array, speaking: boolean): Float32Array;
}

export const SpeechGate = new Function(`${SPEECH_GATE_SOURCE}; return SpeechGate;`)() as new (prerollSamples?: number, hangoverSamples?: number) => SpeechGate;
