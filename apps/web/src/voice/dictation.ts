import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api, VoiceConfig } from "../api";
import { BrowserListener, hasBrowserRecognition, hasRecorder, isIosStandalone, type Listener, RecorderListener, VoicePermissionError } from "./speech";

/**
 * The best way to listen on this device: the browser's own recognition where it works,
 * else recording and the server's speech-to-text (when one is set up), else nothing.
 * Shared by Drive mode and the chat's dictation button.
 */
export function pickListener(api: Pick<Api, "transcribe">, config: VoiceConfig | null): Listener | null {
  const browser = hasBrowserRecognition();
  const server = Boolean(config?.stt) && hasRecorder();
  const transcribe = async (audio: Blob, seconds: number, language: string) => (await api.transcribe(audio, seconds, language)).text;
  // iOS home-screen apps expose SpeechRecognition without it working, so prefer the server there.
  if (browser && !(isIosStandalone() && server)) return new BrowserListener();
  if (server) return new RecorderListener(transcribe, Math.min(30, config?.maxSeconds ?? 30));
  return browser ? new BrowserListener() : null;
}

/** Longest dictation in one go; Stop ends it any time. */
export const DICTATION_MAX_MS = 5 * 60_000;

/** "draft" + "a reply" → "draft a reply"; keeps the typed text and adds the spoken words after it. */
export function joinDictation(typed: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return typed;
  if (!typed.trim()) return s;
  return /\s$/.test(typed) ? `${typed}${s}` : `${typed} ${s}`;
}

/**
 * Dictation into a text box, like the mic in Claude: start, talk (pauses are fine), stop, and the
 * words land after whatever was typed, ready to edit or send. Nothing is sent by itself.
 */
export function useDictation(api: Pick<Api, "voiceConfig" | "transcribe">) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);

  useEffect(() => {
    api.voiceConfig().then(setConfig).catch(() => setConfig(null));
  }, [api]);

  const listener = useMemo(() => pickListener(api, config), [api, config]);
  useEffect(() => () => listener?.stop(), [listener]);

  /**
   * Listens until `stop()`. `onText` gets the transcript so far while talking (where the
   * engine reports it) and the final one at the end; it resolves with the final transcript.
   */
  const start = useCallback(
    async (onText: (spoken: string, final: boolean) => void): Promise<string | null> => {
      if (!listener || active.current) return null;
      active.current = true;
      setError(null);
      setListening(true);
      try {
        const text = await listener.listen({
          lang: config?.language ?? "en-GB",
          timeoutMs: DICTATION_MAX_MS,
          maxTurnMs: DICTATION_MAX_MS,
          latched: true,
          onInterim: (t) => onText(t, false),
        });
        onText(text ?? "", true);
        return text;
      } catch (err) {
        setError(
          err instanceof VoicePermissionError
            ? "The microphone is blocked. Allow it for this site in the browser's address bar, then try again."
            : (err as Error).message,
        );
        onText("", true);
        return null;
      } finally {
        active.current = false;
        setListening(false);
      }
    },
    [listener, config],
  );

  const stop = useCallback(() => listener?.stop(), [listener]);
  return { available: listener !== null, listening, error, start, stop, clearError: () => setError(null) };
}
