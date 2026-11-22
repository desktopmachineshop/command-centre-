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

/** The choice, kept in step across pages and tabs. */
export function useVoiceChoice(): [VoiceChoice, (choice: VoiceChoice) => void] {
  const [choice, setChoice] = useState(readVoiceChoice);
  useEffect(() => {
    const sync = () => setChoice(readVoiceChoice());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((c: VoiceChoice) => {
    writeVoiceChoice(c);
    setChoice(c);
  }, []);
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

