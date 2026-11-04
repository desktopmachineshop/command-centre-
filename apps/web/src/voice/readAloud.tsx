import { speakable } from "@cc/voice/speakable";
import { useCallback, useEffect, useRef, useState } from "react";
import { withoutVoiceLine } from "../format";
import { BrowserSpeaker, hasSynthesis, loadVoices, pickVoice } from "./speech";

const KEY = "cc.readAloud";

/** Whether replies are read aloud on this device. Off unless switched on. */
export function readReadAloud(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writeReadAloud(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // not persisted; still applies for this visit
  }
}

/** What to say for an agent's text message: no markdown, no voice line, nothing for code. Pure. */
export function spokenText(text: string): string {
  return speakable(withoutVoiceLine(text));
}

/**
 * Read agent replies aloud in Chat and Task view. `offer(text)` queues a reply (ignored while
 * off); `stop()` cuts the voice mid-reply and drops what is queued. Uses the browser's voice, so
 * it needs no server setup; `available` is false where the browser has none.
 */
export function useReadAloud() {
  const [enabled, setEnabled] = useState(readReadAloud);
  const [speaking, setSpeaking] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const speaker = useRef<BrowserSpeaker | null>(null);
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const epoch = useRef(0);
  const available = hasSynthesis();

  const ensureSpeaker = useCallback(async () => {
    if (!speaker.current) {
      const voices = await loadVoices();
      const lang = navigator.language || "en-GB";
      speaker.current ??= new BrowserSpeaker(pickVoice(voices, lang), lang);
    }
    return speaker.current;
  }, []);

  const stop = useCallback(() => {
    epoch.current++;
    queue.current = [];
    speaker.current?.cancel();
    running.current = false;
    setSpeaking(false);
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const mine = epoch.current;
    setSpeaking(true);
    try {
      const s = await ensureSpeaker();
      while (queue.current.length && mine === epoch.current) await s.speak(queue.current.shift()!);
    } finally {
      if (mine === epoch.current) {
        running.current = false;
        setSpeaking(false);
      }
    }
  }, [ensureSpeaker]);

  const offer = useCallback(
    (text: string) => {
      if (!enabledRef.current || !hasSynthesis()) return;
      const say = spokenText(text);
      if (!say) return;
      queue.current.push(say);
      void drain();
    },
    [drain],
  );

  const set = useCallback(
    (on: boolean) => {
      writeReadAloud(on);
      setEnabled(on);
      enabledRef.current = on;
      if (!on) stop();
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { enabled, set, speaking, offer, stop, available };
}

/** The on/off switch and the Stop button, for a page header. */
export function ReadAloudControl({ readAloud }: { readAloud: ReturnType<typeof useReadAloud> }) {
  if (!readAloud.available) return null;
  return (
    <span className="read-aloud row small">
      <label className="row" title="Speak each reply as it arrives">
        <input type="checkbox" checked={readAloud.enabled} onChange={(e) => readAloud.set(e.target.checked)} />
        Read replies aloud
      </label>
      {readAloud.speaking && (
        <button type="button" onClick={readAloud.stop} aria-label="Stop reading aloud">
          Stop
        </button>
      )}
    </span>
  );
}
