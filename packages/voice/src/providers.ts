import { ElevenLabsSpeechToText, ElevenLabsTextToSpeech } from "./elevenlabs";
import { OpenAISpeechToText, OpenAITextToSpeech } from "./openai";
import type { Fetch, SpeechToText, TextToSpeech } from "./types";

export type SttProviderName = "openai" | "elevenlabs";
export type TtsProviderName = "openai" | "elevenlabs";

/** Provider choice; "auto" picks the first one with a key, "off" disables server-side speech. */
export interface VoiceProviderConfig {
  stt: SttProviderName | "auto" | "off";
  tts: TtsProviderName | "auto" | "off";
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  openaiSttModel?: string;
  openaiTtsModel?: string;
  openaiVoice?: string;
  elevenlabsSttModel?: string;
  elevenlabsTtsModel?: string;
  elevenlabsVoice?: string;
  /** ElevenLabs voices offered in the voice picker, beside the server's own. */
  elevenlabsVoices?: ElevenLabsVoiceChoice[];
}

/** An ElevenLabs voice Dave added on the Accounts page. */
export interface ElevenLabsVoiceChoice {
  id: string;
  label: string;
}

/**
 * Parses the Accounts page's "ElevenLabs voices" lines: "Name = voice id", "Name: voice id" or a
 * bare voice id. Blank lines and duplicate ids are dropped. Pure.
 */
export function parseElevenLabsVoices(lines: readonly string[]): ElevenLabsVoiceChoice[] {
  const out: ElevenLabsVoiceChoice[] = [];
  for (const raw of lines.flatMap((l) => l.split(/[\n,]/))) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.*?)\s*[=:]\s*([A-Za-z0-9]{10,40})$/.exec(line);
    const id = m ? m[2]! : line.split(/\s+/).pop()!;
    if (!/^[A-Za-z0-9]{10,40}$/.test(id) || out.some((v) => v.id === id)) continue;
    out.push({ id, label: m?.[1]?.trim() || id });
  }
  return out;
}

/**
 * Builds the configured clients. With nothing set both are undefined and the
 * PWA uses the browser's own speech APIs. "auto" prefers OpenAI for STT (cheap,
 * good accuracy) and ElevenLabs for TTS (most natural, lowest latency), falling
 * back to whichever key exists. Naming a provider without its key is an error.
 */
export function createVoiceProviders(config: VoiceProviderConfig, fetch?: Fetch): { stt?: SpeechToText; tts?: TextToSpeech; elevenlabs?: TextToSpeech } {
  const { openaiApiKey: openai, elevenlabsApiKey: eleven } = config;
  const need = (name: string, key: string | undefined, variable: string) => {
    if (!key) throw new Error(`${name} needs ${variable}`);
    return key;
  };

  const sttName: SttProviderName | undefined =
    config.stt === "off" ? undefined : config.stt === "auto" ? (openai ? "openai" : eleven ? "elevenlabs" : undefined) : config.stt;
  const ttsName: TtsProviderName | undefined =
    config.tts === "off" ? undefined : config.tts === "auto" ? (eleven ? "elevenlabs" : openai ? "openai" : undefined) : config.tts;

  const stt =
    sttName === "openai"
      ? new OpenAISpeechToText({ apiKey: need("VOICE_STT_PROVIDER=openai", openai, "OPENAI_API_KEY"), model: config.openaiSttModel, fetch })
      : sttName === "elevenlabs"
        ? new ElevenLabsSpeechToText({
            apiKey: need("VOICE_STT_PROVIDER=elevenlabs", eleven, "ELEVENLABS_API_KEY"),
            model: config.elevenlabsSttModel,
            fetch,
          })
        : undefined;
  const tts =
    ttsName === "openai"
      ? new OpenAITextToSpeech({
          apiKey: need("VOICE_TTS_PROVIDER=openai", openai, "OPENAI_API_KEY"),
          model: config.openaiTtsModel,
          voice: config.openaiVoice,
          instructions: "Speak in a calm, clear British English voice, at a steady pace suitable for listening while driving.",
          fetch,
        })
      : ttsName === "elevenlabs"
        ? new ElevenLabsTextToSpeech({
            apiKey: need("VOICE_TTS_PROVIDER=elevenlabs", eleven, "ELEVENLABS_API_KEY"),
            model: config.elevenlabsTtsModel,
            voice: config.elevenlabsVoice,
            fetch,
          })
        : undefined;
  // ElevenLabs for the voices picked by name, whichever provider is the default (none with TTS off).
  const elevenlabs =
    tts?.provider === "elevenlabs"
      ? tts
      : eleven && config.tts !== "off"
        ? new ElevenLabsTextToSpeech({ apiKey: eleven, model: config.elevenlabsTtsModel, voice: config.elevenlabsVoice, fetch })
        : undefined;
  return { stt, tts, elevenlabs };
}
