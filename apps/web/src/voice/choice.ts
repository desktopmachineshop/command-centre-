import { useCallback, useEffect, useState } from "react";
import type { Api, VoiceConfig } from "../api";
import { type BrowserSpeaker, ServerSpeaker, type Speaker } from "./speech";

/**
 * Which voice this device speaks with, everywhere the app talks (Drive mode, reading replies
 * aloud): "" (the server's default voice), "device" (the browser's own voice), or a server voice
 * id such as "piper:jenny_dioco". Kept per device.
 */
export type VoiceChoice = string;

const KEY = "cc.voice";
/** Drive mode's older "Use the server voice" switch, read once if no choice is saved yet. */
const OLD_KEY = "cc.drive.serverVoice";
const EVENT = "cc-voice-choice";

export function readVoiceChoice(): VoiceChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return saved;
    return localStorage.getItem(OLD_KEY) === "0" ? "device" : "";
  } catch {
    return "";
  }
}

export function writeVoiceChoice(choice: VoiceChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // not persisted; still applies until reload
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: choice }));
}

/**
 * The Learning page's voice, kept apart from the rest so lessons can use a free voice (the
 * server's self-hosted one, or the device's) while Drive mode keeps its own. null until chosen.
 */
const LEARNING_KEY = "cc.voice.learning";
export function readLearningVoice(): VoiceChoice | null {
  try {
    return localStorage.getItem(LEARNING_KEY);
  } catch {
    return null;
  }
}
export function writeLearningVoice(choice: VoiceChoice) {
  try {
    localStorage.setItem(LEARNING_KEY, choice);
  } catch {
    // not persisted
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: choice }));
}

/**
 * The free default for lessons when none is chosen: the server's own (self-hosted, no limits)
 * voice that is ready, its default first, else the device's voice. Pure.
 */
export function freeVoiceDefault(voices: { id: string; tier: string; status: string; isDefault: boolean }[]): VoiceChoice {
  const local = voices.filter((v) => v.tier !== "elevenlabs" && v.status === "ready");
  return (local.find((v) => v.isDefault) ?? local.find((v) => v.tier === "fast") ?? local[0])?.id ?? "device";
}

/** The choice, kept in step across pages and tabs. `learning` reads and writes the Learning page's own. */
export function useVoiceChoice(learning = false): [VoiceChoice, (choice: VoiceChoice) => void] {
  const read = () => (learning ? (readLearningVoice() ?? "") : readVoiceChoice());
  const [choice, setChoice] = useState(read);
  useEffect(() => {
    const sync = () => setChoice(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((c: VoiceChoice) => {
    if (learning) writeLearningVoice(c);
    else writeVoiceChoice(c);
    setChoice(c);
  }, [learning]);
  return [choice, set];
}

/**
 * The speaker for a choice: the server's voice (the chosen one) with the browser's voice
 * covering any sentence the server can't, or the browser's voice alone. Pure apart from the
 * objects it builds.
 */
export function speakerFor(
  api: Pick<Api, "speak">,
  config: VoiceConfig | null,
  choice: VoiceChoice,
  browser: BrowserSpeaker | null,
): Speaker | null {
  const server = config?.tts ? new ServerSpeaker((text) => api.speak(text, choice && choice !== "device" ? choice : undefined), browser) : null;
  if (server && choice !== "device") return server;
  return browser ?? server;
}

