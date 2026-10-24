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
} from "./types";

export interface OpenAIOptions {
  apiKey: string;
  fetch?: Fetch;
  /** Default https://api.openai.com/v1 (or a compatible proxy). */
  baseUrl?: string;
}

const BASE = "https://api.openai.com/v1";

/**
 * OpenAI transcription (POST /audio/transcriptions, multipart).
 * Default model gpt-4o-mini-transcribe (about $0.003 per minute).
 */
export class OpenAISpeechToText implements SpeechToText {
  readonly provider = "openai";
  readonly model: string;
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(private readonly options: OpenAIOptions & { model?: string }) {
    this.model = options.model ?? "gpt-4o-mini-transcribe";
    this.fetch = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  async transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const form = new FormData();
    const type = mime.split(";")[0]!.trim();
    form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type }), `audio.${extensionFor(type)}`);
    form.append("model", this.model);
    form.append("response_format", "json");
    if (opts.language) form.append("language", opts.language.slice(0, 2).toLowerCase());
    if (opts.prompt) form.append("prompt", opts.prompt);
    const res = await call(this.provider, [this.options.apiKey], () =>
      this.fetch(`${this.base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: opts.signal,
      }),
    );
    const body = (await res.json()) as { text?: string; language?: string; duration?: number };
    return { text: (body.text ?? "").trim(), language: body.language, durationSeconds: body.duration };
  }
}

const OPENAI_FORMATS: Record<AudioFormat, string> = { mp3: "mp3", opus: "opus", aac: "aac", wav: "wav", pcm: "pcm" };

/**
 * OpenAI speech (POST /audio/speech). Default model gpt-4o-mini-tts, voice "fable"
 * (a British-sounding voice). No word timings: OpenAI's speech endpoint doesn't return them.
 */
export class OpenAITextToSpeech implements TextToSpeech {
  readonly provider = "openai";
  readonly model: string;
  readonly defaultVoice: string;
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(private readonly options: OpenAIOptions & { model?: string; voice?: string; instructions?: string }) {
    this.model = options.model ?? "gpt-4o-mini-tts";
    this.defaultVoice = options.voice ?? "fable";
    this.fetch = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const format = opts.format ?? "mp3";
    const instructions = opts.instructions ?? this.options.instructions;
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: opts.voice ?? this.defaultVoice,
      response_format: OPENAI_FORMATS[format],
    };
    // tts-1 / tts-1-hd reject `instructions`.
    if (instructions && !this.model.startsWith("tts-1")) body.instructions = instructions;
    if (opts.speed) body.speed = opts.speed;
    const res = await call(this.provider, [this.options.apiKey], () =>
      this.fetch(`${this.base}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      }),
    );
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: MIME[format] };
  }
}
