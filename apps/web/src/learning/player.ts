import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, VoiceConfig } from "../api";
import { readLearningVoice, speakerFor } from "../voice/choice";
import { BrowserSpeaker, hasSynthesis, loadVoices, pickVoice, ScreenWakeLock, ServerSpeaker, type Speaker, silentWav } from "../voice/speech";
import type { Part } from "./script";

const POS = (path: string) => `cc.lesson.pos:${path}`;
const readPos = (path: string) => {
  try {
    return Number(localStorage.getItem(POS(path)) ?? 0) || 0;
  } catch {
    return 0;
  }
};
const writePos = (path: string, i: number) => {
  try {
    localStorage.setItem(POS(path), String(i));
  } catch {
    // not remembered
  }
};

/**
 * Reads a lesson aloud, a paragraph at a time, with the Learning page's voice (a free one unless
 * Dave picks another). Pause, skip back and forward by paragraph or section; the place is kept per
 * lesson on this device. Headset, car and lock-screen buttons play, pause and skip (Media Session),
 * and the screen stays on while it plays.
 */
export function useLessonPlayer(api: Pick<Api, "speak">, config: VoiceConfig | null, path: string, parts: Part[], title: string) {
  const [index, setIndex] = useState(() => Math.min(readPos(path), Math.max(0, parts.length - 1)));
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Milliseconds spent listening, for the minutes credited when it's marked done. */
  const listened = useRef(0);
  const startedAt = useRef<number | null>(null);
  const epoch = useRef(0);
  const speaker = useRef<Speaker | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const wake = useRef<ScreenWakeLock | null>(null);
  const keepAlive = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setIndex(Math.min(readPos(path), Math.max(0, parts.length - 1)));
    setFinished(false);
  }, [path, parts.length]);
  useEffect(() => writePos(path, index), [path, index]);

  const tally = () => {
    if (startedAt.current !== null) listened.current += Date.now() - startedAt.current;
    startedAt.current = null;
  };

  const stop = useCallback(() => {
    epoch.current++;
    speaker.current?.cancel();
    tally();
    setPlaying(false);
    void wake.current?.release();
    keepAlive.current?.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }, []);

  const makeSpeaker = useCallback(async () => {
    const lang = config?.language ?? "en-GB";
    const browser = hasSynthesis() ? new BrowserSpeaker(pickVoice(await loadVoices(), lang), lang) : null;
    const s = speakerFor(api, config, readLearningVoice() ?? "device", browser);
    if (!s) throw new Error("This device can't speak, and the server has no voice.");
    if (s instanceof ServerSpeaker) s.unlock();
    return s;
  }, [api, config]);

  const play = useCallback(
    async (from = indexRef.current) => {
      stop();
      const mine = ++epoch.current;
      setError(null);
      setFinished(false);
      setPlaying(true);
      startedAt.current = Date.now();
      wake.current ??= new ScreenWakeLock();
      void wake.current.acquire();
      // A silent loop keeps the page "playing", so headset and lock-screen buttons reach it.
      if (!keepAlive.current) {
        keepAlive.current = new Audio(URL.createObjectURL(silentWav()));
        keepAlive.current.loop = true;
      }
      void keepAlive.current.play().catch(() => {});
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      try {
        const s = (speaker.current = await makeSpeaker());
        for (let i = from; i < partsRef.current.length; i++) {
          if (mine !== epoch.current) return;
          setIndex(i);
          await s.speak(partsRef.current[i]!.text);
        }
        if (mine !== epoch.current) return;
        setFinished(true);
        setIndex(Math.max(0, partsRef.current.length - 1));
        stop();
      } catch (err) {
        if (mine !== epoch.current) return;
        setError((err as Error).message);
        stop();
      }
    },
    [makeSpeaker, stop],
  );

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const jump = useCallback(
    (to: number) => {
      const i = Math.max(0, Math.min(partsRef.current.length - 1, to));
      if (playingRef.current) void play(i);
      else setIndex(i);
    },
    [play],
  );
  const toggle = useCallback(() => (playingRef.current ? stop() : void play()), [play, stop]);

  // Headset, steering-wheel and lock-screen controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title, artist: "Command Centre · Learning" });
    } catch {
      // MediaMetadata missing
    }
    const handlers: [MediaSessionAction, () => void][] = [
      ["play", () => void play()],
      ["pause", stop],
      ["stop", stop],
      ["nexttrack", () => jump(indexRef.current + 1)],
      ["previoustrack", () => jump(indexRef.current - 1)],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // not supported here
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [title, play, stop, jump]);

  // Leaving the page stops the voice.
  useEffect(() => () => stop(), [stop]);

  const minutesListened = () => Math.round((listened.current + (startedAt.current ? Date.now() - startedAt.current : 0)) / 60_000);
  return { index, playing, finished, error, play, stop, toggle, jump, minutesListened };
}
