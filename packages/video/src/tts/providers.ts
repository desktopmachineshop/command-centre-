import { countWords, WORDS_PER_SECOND } from "../spec";
import { estimateWordTimings, type WordTiming } from "../timeline";
import { type FetchLike, type SpeechResult, type SynthesizeOptions, type TextToSpeech, TtsError } from "./types";
import { silentWav, wavDuration } from "./wav";

/**
 * Silence as long as the text would take to say, with estimated word timings.
 * Deterministic and free: tests and dry-run renders use it.
 */
export function silentProvider(options: { wordsPerSecond?: number } = {}): TextToSpeech {
  const wps = options.wordsPerSecond ?? WORDS_PER_SECOND;
  return {
    id: "silent",
    local: true,
    usdPerMinute: 0,
    async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SpeechResult> {
      const durationSec = Math.round((Math.max(1, countWords(text)) / (wps * (opts.speed ?? 1))) * 1000) / 1000;
      return { audio: silentWav(durationSec), mime: "audio/wav", durationSec, words: estimateWordTimings(text, durationSec), alignedWords: false };
    },
  };
}

/** Turns per-character timings (ElevenLabs `alignment`) into word timings. */
export function charactersToWords(alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): WordTiming[] {
  const words: WordTiming[] = [];
  let word = "";
  let start = 0;
  let end = 0;
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (word) words.push({ word, start, end });
      word = "";
      return;
    }
    if (!word) start = alignment.character_start_times_seconds[i] ?? end;
    word += ch;
    end = alignment.character_end_times_seconds[i] ?? start;
  });
  if (word) words.push({ word, start, end });
  return words.map((w) => ({ word: w.word, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 }));
}

export interface ElevenLabsOptions {
  apiKey: string;
  fetch?: FetchLike;
  /** Default voice when the spec names none. */
  voiceId: string;
  /** eleven_multilingual_v2 (quality) or eleven_flash_v2_5 (half price). */
  modelId?: string;
  baseUrl?: string;
}

/**
 * ElevenLabs `POST /v1/text-to-speech/{voice}/with-timestamps`: MP3 plus
 * per-character timings, so captions line up with the voice exactly.
 * Billed per character (about $0.10 per 1k on multilingual v2, $0.05 on flash).
 */
export function elevenLabsProvider(options: ElevenLabsOptions): TextToSpeech {
  const http = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
  const modelId = options.modelId ?? "eleven_multilingual_v2";
  return {
    id: "elevenlabs",
    local: false,
    usdPerMinute: modelId.includes("flash") || modelId.includes("turbo") ? 0.05 : 0.1,
    async synthesize(text, req = {}) {
      const voice = encodeURIComponent(req.voiceId ?? options.voiceId);
      const res = await http(`${base}/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": options.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ text, model_id: modelId, ...(req.speed && req.speed !== 1 ? { voice_settings: { speed: req.speed } } : {}) }),
        signal: req.signal,
      });
      if (!res.ok) throw new TtsError(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        audio_base64?: string;
        alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
      };
      if (!body.audio_base64) throw new TtsError("ElevenLabs returned no audio");
      const audio = Uint8Array.from(Buffer.from(body.audio_base64, "base64"));
      const words = body.alignment ? charactersToWords(body.alignment) : [];
      const durationSec = words.at(-1)?.end ?? body.alignment?.character_end_times_seconds.at(-1) ?? 0;
      if (!durationSec) throw new TtsError("ElevenLabs returned no timings");
      return { audio, mime: "audio/mpeg", durationSec, words, alignedWords: words.length > 0 };
    },
  };
}

export interface OpenAiTtsOptions {
  apiKey: string;
  fetch?: FetchLike;
  /** gpt-4o-mini-tts (about $0.015/min) or tts-1-hd. */
  model?: string;
  voice?: string;
  /** Style instructions (gpt-4o-mini-tts only), e.g. "friendly product demo, upbeat". */
  instructions?: string;
  baseUrl?: string;
}

/**
 * OpenAI `POST /v1/audio/speech` as WAV. It returns no timings, so words are
 * estimated over the measured length (or aligned later with Whisper).
 */
export function openAiProvider(options: OpenAiTtsOptions): TextToSpeech {
  const http = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  return {
    id: "openai",
    local: false,
    usdPerMinute: 0.015,
    async synthesize(text, req = {}) {
      const res = await http(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model ?? "gpt-4o-mini-tts",
          voice: req.voiceId ?? options.voice ?? "alloy",
          input: text,
          response_format: "wav",
          ...(req.speed ? { speed: req.speed } : {}),
          ...(options.instructions ? { instructions: options.instructions } : {}),
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new TtsError(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const audio = new Uint8Array(await res.arrayBuffer());
      const durationSec = Math.round(wavDuration(audio) * 1000) / 1000;
      return { audio, mime: "audio/wav", durationSec, words: estimateWordTimings(text, durationSec), alignedWords: false };
    },
  };
}

/** Provider ids that run on the worker without keys (flite needs ffmpeg built with libflite). */
export const LOCAL_PROVIDERS = new Set(["silent", "flite"]);

/** Server-side config for the cloud providers; a provider is available only once its key is set. */
export interface TtsKeys {
  elevenlabs?: { apiKey: string; voiceId: string; modelId?: string };
  openai?: { apiKey: string; model?: string; voice?: string; instructions?: string };
}

export function cloudProvider(id: string, keys: TtsKeys, fetchImpl?: FetchLike): TextToSpeech | null {
  if (id === "elevenlabs" && keys.elevenlabs) return elevenLabsProvider({ ...keys.elevenlabs, fetch: fetchImpl });
  if (id === "openai" && keys.openai) return openAiProvider({ ...keys.openai, fetch: fetchImpl });
  return null;
}
