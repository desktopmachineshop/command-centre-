import { call } from "./errors";
import { extensionFor, MIME } from "./mime";
import type {
  AudioFormat,
  Fetch,
  SpeechToText,
  SynthesisResult,
  SynthesizeOptions,
  TextToSpeech,
  TranscribeOptions,
  TranscriptionResult,
  WordTiming,
} from "./types";

export interface ElevenLabsOptions {
  apiKey: string;
  fetch?: Fetch;
  /** Default https://api.elevenlabs.io (or a regional host). */
  baseUrl?: string;
}

const BASE = "https://api.elevenlabs.io";

/** "George", a British voice from the default library. */
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

const OUTPUT_FORMATS: Record<AudioFormat, string> = {
  mp3: "mp3_44100_128",
  opus: "opus_48000_64",
  aac: "mp3_44100_128", // no AAC output; fall back to MP3
  wav: "wav_44100",
  pcm: "pcm_24000",
};

type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/**
 * ElevenLabs text to speech. Default model eleven_flash_v2_5 (lowest latency,
 * about $0.04 per 1,000 characters). With `timings`, it calls the
 * `/with-timestamps` variant and turns the per-character alignment into words.
 */
export class ElevenLabsTextToSpeech implements TextToSpeech {
  readonly provider = "elevenlabs";
  readonly model: string;
  readonly defaultVoice: string;
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(private readonly options: ElevenLabsOptions & { model?: string; voice?: string }) {
    this.model = options.model ?? "eleven_flash_v2_5";
    this.defaultVoice = options.voice ?? ELEVENLABS_DEFAULT_VOICE;
    this.fetch = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const requested = opts.format ?? "mp3";
    const format: AudioFormat = requested === "aac" ? "mp3" : requested;
    const voice = encodeURIComponent(opts.voice ?? this.defaultVoice);
    const path = `/v1/text-to-speech/${voice}${opts.timings ? "/with-timestamps" : ""}`;
    const url = `${this.base}${path}?output_format=${OUTPUT_FORMATS[format]}`;
    const body: Record<string, unknown> = { text, model_id: this.model };
    if (opts.language) body.language_code = opts.language.slice(0, 2).toLowerCase();
    if (opts.speed) body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, opts.speed)) };
    const res = await call(this.provider, [this.options.apiKey], () =>
      this.fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.options.apiKey,
          "content-type": "application/json",
          accept: opts.timings ? "application/json" : MIME[format],
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      }),
    );
    if (!opts.timings) return { audio: new Uint8Array(await res.arrayBuffer()), mime: MIME[format] };
    const json = (await res.json()) as { audio_base64: string; alignment?: Alignment | null };
    const audio = new Uint8Array(Buffer.from(json.audio_base64, "base64"));
    return { audio, mime: MIME[format], words: json.alignment ? wordsFromAlignment(json.alignment) : undefined };
  }
}

/** Groups per-character timings into words (split on whitespace). */
export function wordsFromAlignment(a: Alignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current: WordTiming | null = null;
  a.characters.forEach((ch, i) => {
    const start = a.character_start_times_seconds[i] ?? 0;
    const end = a.character_end_times_seconds[i] ?? start;
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    if (!current) current = { word: ch, start, end };
    else {
      current.word += ch;
      current.end = end;
    }
  });
  if (current) words.push(current);
  return words;
}

/** ElevenLabs Scribe speech to text (POST /v1/speech-to-text). Default model scribe_v2 (about $0.22 per hour). */
export class ElevenLabsSpeechToText implements SpeechToText {
  readonly provider = "elevenlabs";
  readonly model: string;
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(private readonly options: ElevenLabsOptions & { model?: string }) {
    this.model = options.model ?? "scribe_v2";
    this.fetch = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  async transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const form = new FormData();
    const type = mime.split(";")[0]!.trim();
    form.append("model_id", this.model);
    form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type }), `audio.${extensionFor(type)}`);
    if (opts.language) form.append("language_code", opts.language.slice(0, 2).toLowerCase());
    form.append("tag_audio_events", "false");
    const res = await call(this.provider, [this.options.apiKey], () =>
      this.fetch(`${this.base}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.options.apiKey },
        body: form,
        signal: opts.signal,
      }),
    );
    const body = (await res.json()) as {
      text?: string;
      language_code?: string;
      words?: { text: string; type?: string; start?: number; end?: number }[];
    };
    const words = body.words
      ?.filter((w) => (w.type ?? "word") === "word")
      .map((w) => ({ word: w.text, start: w.start ?? 0, end: w.end ?? w.start ?? 0 }));
    return { text: (body.text ?? "").trim(), language: body.language_code, words, durationSeconds: words?.at(-1)?.end };
  }
}
