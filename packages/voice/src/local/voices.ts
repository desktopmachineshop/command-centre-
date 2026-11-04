import { KOKORO_VOICES, LOCAL_MODELS, type LocalModel, modelPath, piperModel } from "./models";

/**
 * The self-hosted voices to choose from. A voice is a model to download (once) plus which
 * speaker in it, and an engine that says how sherpa-onnx loads that model. To add a voice, add an
 * entry; to add a kind of model sherpa-onnx supports (Matcha, Kitten, ...), add it to
 * `ttsModelConfig` too.
 */
export type TtsEngine = "vits" | "kokoro" | "kitten" | "matcha";

export interface VoiceSpec {
  /** Stable id, "<family>:<name>", e.g. "piper:cori". Saved by the app as the chosen voice. */
  id: string;
  label: string;
  /** e.g. "British female · fast". */
  description: string;
  /** "fast" voices start speaking almost at once; "natural" ones sound better but are slower on CPU. */
  tier: "fast" | "natural";
  engine: TtsEngine;
  model: LocalModel;
  /** Speaker id in a multi-speaker model (default 0). */
  speaker?: number;
}

const piper = (name: Parameters<typeof piperModel>[0], label: string, description: string): VoiceSpec => ({
  id: `piper:${name}`,
  label,
  description: `${description} · fast`,
  tier: "fast",
  engine: "vits",
  model: piperModel(name),
});

const kokoro = (name: keyof typeof KOKORO_VOICES, label: string, description: string): VoiceSpec => ({
  id: `kokoro:${name}`,
  label,
  description: `${description} · most natural, slower`,
  tier: "natural",
  engine: "kokoro",
  model: LOCAL_MODELS.tts,
  speaker: KOKORO_VOICES[name],
});

export const VOICES: VoiceSpec[] = [
  piper("cori", "Cori", "British female"),
  piper("jenny_dioco", "Jenny", "British female"),
  piper("southern_english_female", "Southern English", "British female"),
  piper("alba", "Alba", "Scottish female"),
  piper("alan", "Alan", "British male"),
  piper("northern_english_male", "Northern English", "British male"),
  kokoro("bf_emma", "Emma", "British female"),
  kokoro("bf_isabella", "Isabella", "British female"),
  kokoro("bm_george", "George", "British male"),
  kokoro("bm_lewis", "Lewis", "British male"),
];

export const DEFAULT_VOICE_ID = "piper:cori";

/**
 * The voice an id names. Also takes the older settings: a bare Piper or Kokoro voice name
 * (VOICE_LOCAL_VOICE=jenny_dioco or bf_emma), with `engine` saying which family a bare name means.
 */
export function findVoice(id: string | null | undefined, engine?: "piper" | "kokoro"): VoiceSpec | undefined {
  if (!id) return undefined;
  const exact = VOICES.find((v) => v.id === id);
  if (exact) return exact;
  const families = engine ? [engine, engine === "piper" ? "kokoro" : "piper"] : ["piper", "kokoro"];
  for (const family of families) {
    const v = VOICES.find((x) => x.id === `${family}:${id}`);
    if (v) return v;
  }
  return undefined;
}

/** The sherpa-onnx OfflineTts `model` entry that loads `voice` from `root`. */
export function ttsModelConfig(voice: VoiceSpec, root: string): Record<string, unknown> {
  const m = voice.model;
  const p = (file: string) => modelPath(root, m, file);
  switch (voice.engine) {
    case "vits":
      return { vits: { model: p(m.files[0]!), tokens: p("tokens.txt"), dataDir: p("espeak-ng-data") } };
    case "kokoro":
      return { kokoro: { model: p("model.onnx"), voices: p("voices.bin"), tokens: p("tokens.txt"), dataDir: p("espeak-ng-data") } };
    case "kitten":
      return { kitten: { model: p(m.files[0]!), voices: p("voices.bin"), tokens: p("tokens.txt"), dataDir: p("espeak-ng-data") } };
    case "matcha":
      return { matcha: { acousticModel: p(m.files[0]!), vocoder: p(m.files[1]!), tokens: p("tokens.txt"), dataDir: p("espeak-ng-data") } };
  }
}
