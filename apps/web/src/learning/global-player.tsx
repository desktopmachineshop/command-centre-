import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Api, LessonAudio } from "../api";
import { Icon } from "../icons";
import { go } from "../router";
import { ScreenWakeLock } from "../voice/speech";
import { chapterAt, clock, previousChapterStart } from "./recording";

/** A recorded lesson loaded in the player, with where each spoken part starts (for the text sync). */
export interface LoadedLesson {
  path: string;
  title: string;
  audio: LessonAudio;
  marks: number[];
}

export interface LessonPlayer {
  loaded: LoadedLesson | null;
  time: number;
  duration: number;
  playing: boolean;
  finished: boolean;
  error: string | null;
  speed: number;
  chapter: number;
  /** Loads a lesson (if it isn't the one loaded), at `at` seconds. Doesn't start it. */
  load(lesson: LoadedLesson, at?: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  skip(by: number): void;
  prevChapter(): void;
  nextChapter(): void;
  setSpeed(s: number): void;
  /** Stops and unloads (the mini player's ×). */
  close(): void;
  /** Whether the lesson page's full player is on screen (the mini player stands in when it isn't). */
  fullPlayerVisible: boolean;
  setFullPlayerVisible(visible: boolean): void;
  minutesListened(): number;
}

const Ctx = createContext<LessonPlayer | null>(null);

/** The app's one lesson player, so a lesson keeps playing while Dave uses the rest of the app. */
export function useLessonAudio(): LessonPlayer {
  const p = useContext(Ctx);
  if (!p) throw new Error("useLessonAudio outside LessonPlayerProvider");
  return p;
}

const local = {
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
      // not kept
    }
  },
};
export const localPlaceKey = (path: string) => `cc.lesson.t:${path}`;

/** How often the listening place goes to the server while playing (and always on pause). */
const SAVE_EVERY_MS = 15_000;

/**
 * Holds the lesson audio for the whole app: one audio element that survives page changes, the
 * lock-screen and car controls, the screen wake lock, and the listening place (on this device at
 * once, on the server every 15 s and on pause, so another device picks up from it).
 */
export function LessonPlayerProvider({ api, children }: { api: Pick<Api, "saveProgress">; children: ReactNode }) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [loaded, setLoaded] = useState<LoadedLesson | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeedState] = useState(() => Number(local.get("cc.lesson.speed")) || 1);
  const [fullPlayerVisible, setFullPlayerVisible] = useState(false);
  const listened = useRef(0);
  const last = useRef<number | null>(null);
  const lastSaved = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const wake = useRef<ScreenWakeLock | null>(null);

  const save = useCallback(
    (force = false) => {
      const a = el.current;
      const l = loadedRef.current;
      if (!a || !l || !Number.isFinite(a.currentTime)) return;
      local.set(localPlaceKey(l.path), JSON.stringify({ t: a.currentTime, at: Date.now() }));
      if (!force && Date.now() - lastSaved.current < SAVE_EVERY_MS) return;
      lastSaved.current = Date.now();
      void api.saveProgress(l.path, { audioSeconds: Math.round(a.currentTime * 10) / 10 }, { keepalive: true }).catch(() => {});
    },
    [api],
  );

  // One audio element for the app's lifetime.
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    el.current = a;
    const onMeta = () => {
      if (Number.isFinite(a.duration)) setDuration(a.duration);
      if (pendingSeek.current !== null) {
        const t = pendingSeek.current;
        pendingSeek.current = null;
        if (t > 0 && t < a.duration - 3) a.currentTime = t;
      }
    };
    const onTime = () => {
      setTime(a.currentTime);
      if (last.current !== null && !a.paused) {
        const step = a.currentTime - last.current;
        if (step > 0 && step < 2) listened.current += step / a.playbackRate;
      }
      last.current = a.currentTime;
      if (!a.paused) save();
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
      save(true);
      void wake.current?.release();
    };
    const onEnded = () => setFinished(true);
    const onError = () => {
      if (a.getAttribute("src")) setError("The recording couldn't be played. Try again, or read it instead.");
    };
    const onHide = () => save(true);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      a.pause();
      a.removeAttribute("src");
      el.current = null;
    };
  }, [save]);

  const load = useCallback((lesson: LoadedLesson, at = 0) => {
    const a = el.current;
    if (!a) return;
    if (loadedRef.current?.path === lesson.path && loadedRef.current.audio.url === lesson.audio.url) {
      // Same lesson: just keep its marks up to date.
      setLoaded(lesson);
      return;
    }
    if (loadedRef.current) save(true);
    a.pause();
    setLoaded(lesson);
    loadedRef.current = lesson;
    setError(null);
    setFinished(false);
    setTime(at);
    setDuration(lesson.audio.seconds);
    listened.current = 0;
    last.current = null;
    pendingSeek.current = at;
    a.src = lesson.audio.url;
    a.playbackRate = Number(local.get("cc.lesson.speed")) || 1;
    a.load();
  }, [save]);

  const seek = useCallback((t: number) => {
    const a = el.current;
    if (!a) return;
    const end = Number.isFinite(a.duration) ? a.duration : (loadedRef.current?.audio.seconds ?? 0);
    const to = Math.max(0, Math.min(t, Math.max(0, end - 0.5)));
    if (a.readyState < 1) pendingSeek.current = to;
    else a.currentTime = to;
    setTime(to);
    setFinished(false);
    save(true);
  }, [save]);
  const play = useCallback(() => {
    el.current?.play().catch((e: Error) => setError(e.message));
  }, []);
  const pause = useCallback(() => el.current?.pause(), []);
  const toggle = useCallback(() => (el.current?.paused ? play() : pause()), [play, pause]);
  const skip = useCallback((by: number) => el.current && seek(el.current.currentTime + by), [seek]);
  const prevChapter = useCallback(() => {
    const l = loadedRef.current;
    if (el.current && l) seek(previousChapterStart(l.audio.chapters, el.current.currentTime));
  }, [seek]);
  const nextChapter = useCallback(() => {
    const l = loadedRef.current;
    if (!el.current || !l) return;
    const next = l.audio.chapters[chapterAt(l.audio.chapters, el.current.currentTime) + 1];
    if (next) seek(next.at);
  }, [seek]);
  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    local.set("cc.lesson.speed", String(s));
    if (el.current) el.current.playbackRate = s;
  }, []);
  const close = useCallback(() => {
    const a = el.current;
    if (a) {
      save(true);
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setLoaded(null);
    loadedRef.current = null;
    setPlaying(false);
  }, [save]);

  // Lock screen, headset and car controls.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !loaded) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title: loaded.title, artist: "Learning", album: "Command Centre" });
    } catch {
      // MediaMetadata missing
    }
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", play],
      ["pause", pause],
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
  }, [loaded?.path, loaded?.title, play, pause, skip, prevChapter, nextChapter, seek]);

  const value = useMemo<LessonPlayer>(
    () => ({
      loaded,
      time,
      duration,
      playing,
      finished,
      error,
      speed,
      chapter: loaded ? chapterAt(loaded.audio.chapters, time) : 0,
      load,
      play,
      pause,
      toggle,
      seek,
      skip,
      prevChapter,
      nextChapter,
      setSpeed,
      close,
      fullPlayerVisible,
      setFullPlayerVisible,
      minutesListened: () => Math.round(listened.current / 60),
    }),
    [loaded, time, duration, playing, finished, error, speed, fullPlayerVisible, load, play, pause, toggle, seek, skip, prevChapter, nextChapter, setSpeed, close],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The lesson keeps playing while Dave uses the rest of the app: a small bar above the tab bar
 * (phone) or at the foot of the window (PC). On the lesson's own page it shows only once the full
 * player has scrolled out of view, so the text has the screen.
 */
export function MiniPlayer({ hidden }: { hidden: boolean }) {
  const p = useLessonAudio();
  if (!p.loaded || hidden) return null;
  const chapter = p.loaded.audio.chapters[p.chapter];
  const pct = p.duration ? Math.min(100, (p.time / p.duration) * 100) : 0;
  return (
    <div className="mini-player" role="region" aria-label="Lesson playing">
      <span className="mini-progress" style={{ width: `${pct}%` }} aria-hidden="true" />
      <button type="button" className="mini-title ghost" onClick={() => go(`learning/${encodeURIComponent(p.loaded!.path)}`)} title="Open the lesson">
        <Icon name="learn" size={16} />
        <span className="mini-text">
          <span className="clip">{p.loaded.title}</span>
          <span className="small muted clip">
            {chapter?.title ? `${chapter.title} · ` : ""}
            {clock(p.time)} / {clock(p.duration)}
          </span>
        </span>
      </button>
      <button type="button" className="ghost icon-btn" aria-label="Back 15 seconds" onClick={() => p.skip(-15)}>
        −15
      </button>
      <button type="button" className="primary icon-btn mini-play" aria-label={p.playing ? "Pause" : "Play"} onClick={p.toggle}>
        <Icon name={p.playing ? "pause" : "play"} size={18} />
      </button>
      <button type="button" className="ghost icon-btn" aria-label="Forward 30 seconds" onClick={() => p.skip(30)}>
        +30
      </button>
      <button type="button" className="ghost icon-btn" aria-label="Close the lesson player" onClick={p.close}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
