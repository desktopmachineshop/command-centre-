import type { WordTiming } from "../timeline";

/**
 * Same shape as `TextToSpeech` in packages/voice on main
 * (`synthesize(text, opts) → { audio, mime, words? }`), so the two can merge:
 * a packages/voice provider can be used here as-is, with `durationSec`
 * measured from the audio when it doesn't report it.
 */
export interface SynthesizeOptions {
  voiceId?: string;
  /** 0.7–1.3. */
  speed?: number;
  signal?: AbortSignal;
}

export interface SpeechResult {
  audio: Uint8Array;
  /** audio/wav or audio/mpeg. */
  mime: string;
  /** Word timings when the provider gives them (ElevenLabs) or when estimated (silent, flite, OpenAI). */
  words?: WordTiming[];
  /** Length of `audio`, in seconds. */
  durationSec: number;
  /** Whether `words` came from the provider (true) or were estimated from the text (false). */
  alignedWords?: boolean;
}

/**
 * One text-to-speech service. Cloud providers get an injected `fetch` and
 * their key from server config; tests use the silent provider.
 */
export interface TextToSpeech {
  readonly id: string;
  /** True when synthesis needs no network or key (it can run on the worker). */
  readonly local: boolean;
  /** Rough list price per minute of audio, for cost estimates. */
  readonly usdPerMinute: number;
  synthesize(text: string, options?: SynthesizeOptions): Promise<SpeechResult>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TtsError extends Error {}

/** File extension for a speech MIME type. */
export function speechExt(mime: string): "wav" | "mp3" {
  return /mpeg|mp3/i.test(mime) ? "mp3" : "wav";
}
