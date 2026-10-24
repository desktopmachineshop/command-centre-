import { MIME } from "./mime";
import type { SpeechToText, SynthesisResult, SynthesizeOptions, TextToSpeech, TranscribeOptions, TranscriptionResult } from "./types";

/** Returns queued transcripts (or a fixed one) and records every call. For tests. */
export class FakeSpeechToText implements SpeechToText {
  readonly provider = "fake";
  readonly model = "fake-stt";
  readonly calls: { bytes: number; mime: string; opts: TranscribeOptions }[] = [];
  private readonly queue: string[] = [];

  constructor(private readonly fallback = "hello") {}

  /** The next transcribe() returns `text`. */
  push(...texts: string[]) {
    this.queue.push(...texts);
    return this;
  }

  async transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    this.calls.push({ bytes: audio.byteLength, mime, opts });
    return { text: this.queue.shift() ?? this.fallback, language: opts.language };
  }
}

/** "Synthesizes" the UTF-8 text itself as the audio bytes, with evenly spaced word timings. For tests. */
export class FakeTextToSpeech implements TextToSpeech {
  readonly provider = "fake";
  readonly model = "fake-tts";
  readonly defaultVoice = "fake-voice";
  readonly calls: { text: string; opts: SynthesizeOptions }[] = [];

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    this.calls.push({ text, opts });
    const format = opts.format ?? "mp3";
    const audio = new TextEncoder().encode(`${opts.voice ?? this.defaultVoice}:${text}`);
    const words = opts.timings
      ? text
          .split(/\s+/)
          .filter(Boolean)
          .map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }))
      : undefined;
    return { audio, mime: MIME[format], words };
  }
}
