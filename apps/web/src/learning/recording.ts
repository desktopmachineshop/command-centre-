import { useCallback, useEffect, useRef, useState } from "react";
import type { LessonAudio } from "../api";
import { ScreenWakeLock } from "../voice/speech";

/** The chapter playing at `t` seconds (index into `chapters`). Pure. */
export function chapterAt(chapters: { at: number }[], t: number): number {
  let i = 0;
  for (let j = 0; j < chapters.length; j++) if (chapters[j]!.at <= t + 0.05) i = j;
  return i;
}

/** "4:05", "1:02:09". Pure. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/**
 * Where "previous chapter" goes: the start of this chapter if more than 3 s in, else the one
 * before. Pure.
 */
export function previousChapterStart(chapters: { at: number }[], t: number): number {
  const i = chapterAt(chapters, t);
  if (t - (chapters[i]?.at ?? 0) > 3 || i === 0) return chapters[i]?.at ?? 0;
  return chapters[i - 1]!.at;
}

export const SPEEDS = [0.9, 1, 1.1, 1.25, 1.5] as const;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not remembered
    }
  },
};

/**
 * Plays a lesson's recording: a real audio file, so it keeps playing with the screen off and the
 * phone's lock screen, headset and car controls work (play, pause, skip 15 s back and 30 s on,
 * previous and next chapter). The place and the speed are kept on this device.
 */
export function useRecordingPlayer(audio: LessonAudio, path: string, title: string) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(audio.seconds);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeedState] = useState(() => Number(store.get("cc.lesson.speed")) || 1);
  const listened = useRef(0);
  const last = useRef<number | null>(null);
  const wake = useRef<ScreenWakeLock | null>(null);
  const posKey = `cc.lesson.t:${path}`;

  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    a.src = audio.url;
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    a.playbackRate = speed;
    el.current = a;
    const saved = Number(store.get(posKey)) || 0;
    const onMeta = () => {
      if (Number.isFinite(a.duration)) setDuration(a.duration);
      if (saved > 0 && saved < a.duration - 5) a.currentTime = saved;
    };
    const onTime = () => {
      setTime(a.currentTime);
      if (last.current !== null && !a.paused) {
        const step = a.currentTime - last.current;
        if (step > 0 && step < 2) listened.current += step / a.playbackRate;
      }
      last.current = a.currentTime;
      if (Math.floor(a.currentTime) % 5 === 0) store.set(posKey, String(a.currentTime));
      if ("mediaSession" in navigator && Number.isFinite(a.duration)) {
        try {
          navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate });
        } catch {
          // not supported
        }
      }
    };
    const onPlay = () => {
      setPlaying(true);
      setFinished(false);
      wake.current ??= new ScreenWakeLock();
      void wake.current.acquire();
    };
    const onPause = () => {
      setPlaying(false);
      last.current = null;
      store.set(posKey, String(a.currentTime));
      void wake.current?.release();
    };
    const onEnded = () => {
      setFinished(true);
      store.set(posKey, "0");
    };
    const onError = () => setError("The recording couldn't be played. Try again, or use the live voice below.");
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    return () => {
      store.set(posKey, String(a.currentTime));
      a.pause();
      a.removeAttribute("src");
      a.load();
      void wake.current?.release();
      el.current = null;
    };
  }, [audio.url, posKey]);

  const seek = useCallback((t: number) => {
    const a = el.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(t, (Number.isFinite(a.duration) ? a.duration : audio.seconds) - 0.5));
    setTime(a.currentTime);
  }, [audio.seconds]);
  const toggle = useCallback(() => {
    const a = el.current;
    if (!a) return;
    if (a.paused) a.play().catch((e: Error) => setError(e.message));
    else a.pause();
  }, []);
  const skip = useCallback((by: number) => el.current && seek(el.current.currentTime + by), [seek]);
  const prevChapter = useCallback(() => el.current && seek(previousChapterStart(audio.chapters, el.current.currentTime)), [audio.chapters, seek]);
  const nextChapter = useCallback(() => {
    const a = el.current;
    if (!a) return;
    const next = audio.chapters[chapterAt(audio.chapters, a.currentTime) + 1];
    if (next) seek(next.at);
  }, [audio.chapters, seek]);
  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    store.set("cc.lesson.speed", String(s));
    if (el.current) el.current.playbackRate = s;
  }, []);

  // Lock screen, headset and car controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title, artist: "Learning", album: "Command Centre" });
    } catch {
      // MediaMetadata missing
    }
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void el.current?.play()],
      ["pause", () => el.current?.pause()],
      ["seekbackward", (d) => skip(-(d.seekOffset ?? 15))],
      ["seekforward", (d) => skip(d.seekOffset ?? 30)],
      ["previoustrack", prevChapter],
      ["nexttrack", nextChapter],
      ["seekto", (d) => d.seekTime !== undefined && seek(d.seekTime)],
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
  }, [title, skip, prevChapter, nextChapter, seek]);

  const chapter = chapterAt(audio.chapters, time);
  return {
    time,
    duration,
    playing,
    finished,
    error,
    speed,
    chapter,
    toggle,
    seek,
    skip,
    prevChapter,
    nextChapter,
    setSpeed,
    stop: () => el.current?.pause(),
    minutesListened: () => Math.round(listened.current / 60),
  };
}
