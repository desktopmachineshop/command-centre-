import { speakable } from "@cc/voice/speakable";
import { useCallback, useEffect, useRef, useState } from "react";
import { withoutVoiceLine } from "../format";
import { Icon } from "../icons";
import type { Api, VoiceConfig } from "../api";
import { readVoiceChoice, speakerFor } from "./choice";
import { BrowserSpeaker, hasSynthesis, loadVoices, pickVoice, ServerSpeaker, type Speaker, sharedAudioContext } from "./speech";

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
 * off); `stop()` cuts the voice mid-reply and drops what is queued. Speaks with the voice chosen
 * for this device (voice/choice.ts, the same as Drive mode): the server's when there is one,
 * else the browser's. `available` is false where neither can speak.
 */
export function useReadAloud(api?: Pick<Api, "speak" | "voiceConfig">) {
  const [enabled, setEnabled] = useState(readReadAloud);
  const [speaking, setSpeaking] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const speaker = useRef<Speaker | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  useEffect(() => {
    api?.voiceConfig().then(setConfig).catch(() => setConfig(null));
  }, [api]);
  const configRef = useRef(config);
  configRef.current = config;
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const epoch = useRef(0);
  const available = hasSynthesis() || Boolean(config?.tts);
  const availableRef = useRef(available);
  availableRef.current = available;

  /** A speaker for the current choice (rebuilt per reply, so a change of voice applies at once). */
  const ensureSpeaker = useCallback(async () => {
    const lang = configRef.current?.language ?? (navigator.language || "en-GB");
    const browser = hasSynthesis() ? new BrowserSpeaker(pickVoice(await loadVoices(), lang), lang) : null;
    const s = api ? speakerFor(api, configRef.current, readVoiceChoice(), browser) : browser;
    if (!s) throw new Error("no voice");
    if (s instanceof ServerSpeaker) s.unlock();
    speaker.current = s;
    return s;
  }, [api]);

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
      if (!enabledRef.current || !availableRef.current) return;
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
      // Called from the switch's tap: unlock audio now, as iOS requires, for replies that arrive later.
      if (on && configRef.current?.tts) sharedAudioContext();
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

/** The same switch as a toggle button, for the chat composer's toolbar: Stop takes its place while speaking. */
export function ReadAloudToggle({ readAloud }: { readAloud: ReturnType<typeof useReadAloud> }) {
  if (!readAloud.available) return null;
  if (readAloud.speaking) {
    return (
      <button type="button" className="tool is-on" onClick={readAloud.stop} aria-label="Stop reading aloud" title="Stop reading aloud">
        <Icon name="stop" size={16} />
        <span>Stop</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`tool ${readAloud.enabled ? "is-on" : ""}`}
      aria-pressed={readAloud.enabled}
      onClick={() => readAloud.set(!readAloud.enabled)}
      title="Speak each reply as it arrives"
    >
      <Icon name="narrate" size={16} />
      <span>Read aloud</span>
    </button>
  );
}
