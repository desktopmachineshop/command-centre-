/**
 * Provider-neutral speech contracts.
 *
 * `TextToSpeech.synthesize(text, opts) → {audio, mime, words?}` is the shape
 * other packages (e.g. `@cc/video` voiceovers) should depend on, so one set of
 * provider clients serves Drive mode, voiceovers and anything else that talks.
 */

/** A word and where it falls in the audio, in seconds from the start. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** Container/codec of synthesized audio. Providers map these to their own names. */
export type AudioFormat = "mp3" | "opus" | "aac" | "wav" | "pcm";

export interface SynthesizeOptions {
  /** Provider voice id (OpenAI voice name, ElevenLabs voice id). Defaults to the client's configured voice. */
  voice?: string;
  /** Default "mp3", which every browser plays. */
  format?: AudioFormat;
  /** Ask for word timings (captions, karaoke-style highlighting). Ignored by providers that can't. */
  timings?: boolean;
  /** Speaking-style hint for models that take one (OpenAI gpt-4o-mini-tts `instructions`). */
  instructions?: string;
  /** 0.25–4, where supported. */
  speed?: number;
  /** BCP-47 or ISO-639-1 hint, where supported. */
  language?: string;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  audio: Uint8Array;
  mime: string;
  /** Word timings, when the provider returns them and `timings` was asked for. */
  words?: WordTiming[];
}

export interface TextToSpeech {
  /** e.g. "openai", "elevenlabs", "fake". */
  readonly provider: string;
  readonly model: string;
  readonly defaultVoice: string;
  synthesize(text: string, opts?: SynthesizeOptions): Promise<SynthesisResult>;
}

export interface TranscribeOptions {
  /** ISO-639-1 ("en") hint; providers auto-detect without it. */
  language?: string;
  /** Vocabulary hint, e.g. product names. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  words?: WordTiming[];
}

export interface SpeechToText {
  readonly provider: string;
  readonly model: string;
  transcribe(audio: Uint8Array, mime: string, opts?: TranscribeOptions): Promise<TranscriptionResult>;
}

/** `fetch`, injected so tests never reach a real provider. */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
