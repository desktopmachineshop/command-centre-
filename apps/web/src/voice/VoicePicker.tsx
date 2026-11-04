import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type VoiceConfig, type VoiceList, type VoiceOption } from "../api";
import { useVoiceChoice } from "./choice";
import { BrowserSpeaker, hasSynthesis, loadVoices, pickVoice, ServerSpeaker } from "./speech";

const SAMPLE = "Hi Dave. This is how I'll sound when I read your replies out.";

/** "Cori · British female · fast", with the download state when it isn't ready. Pure. */
export function voiceLabel(v: VoiceOption): string {
  const state = v.status === "ready" ? "" : v.status === "installing" ? " (downloading…)" : v.status === "failed" ? " (download failed)" : ` (downloads ${v.sizeMb} MB)`;
  return `${v.label} · ${v.description}${v.isDefault ? " · default" : ""}${state}`;
}

/**
 * Picks the voice this device speaks with (Drive mode and reading replies aloud): any of the
 * server's voices, grouped by speed, or the device's own. A voice that isn't downloaded starts
 * downloading when chosen (the default speaks meanwhile); Preview plays a sample.
 */
export function VoicePicker({ api, config }: { api: Pick<Api, "voices" | "installVoice" | "speak">; config: VoiceConfig | null }) {
  const [choice, setChoice] = useVoiceChoice();
  const [list, setList] = useState<VoiceList | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const speaker = useRef<ServerSpeaker | BrowserSpeaker | null>(null);

  const refresh = useCallback(() => api.voices().then(setList).catch(() => setList(null)), [api]);
  useEffect(() => {
    void refresh();
    return () => speaker.current?.cancel();
  }, [refresh]);
  // While anything downloads, follow its progress.
  const downloading = list?.voices.some((v) => v.status === "installing");
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [downloading, refresh]);

  const serverVoices = list?.voices ?? [];
  const chosen = serverVoices.find((v) => v.id === choice);
  const choose = (id: string) => {
    setNote(null);
    setChoice(id);
    const v = serverVoices.find((x) => x.id === id);
    if (v && v.status !== "ready") void api.installVoice(id).then(setList).catch((e: Error) => setNote(e.message));
  };

  const preview = async () => {
    speaker.current?.cancel();
    setNote(null);
    setPlaying(true);
    try {
      if (choice === "device" || !config?.tts) {
        if (!hasSynthesis()) throw new Error("This device has no voice of its own.");
        const voices = await loadVoices();
        const s = new BrowserSpeaker(pickVoice(voices, config?.language ?? "en-GB"), config?.language ?? "en-GB");
        speaker.current = s;
        await s.speak(SAMPLE);
      } else {
        const s = new ServerSpeaker((text) => api.speak(text, choice || undefined, { fallback: false }));
        speaker.current = s;
        s.unlock();
        await s.speakStream(
          (async function* () {
            yield SAMPLE;
          })(),
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNote(`${chosen?.label ?? "That voice"} is still downloading. Try again in a moment.`);
        void refresh();
      } else setNote((err as Error).message);
    } finally {
      setPlaying(false);
    }
  };

  const group = (tier: VoiceOption["tier"]) => serverVoices.filter((v) => v.tier === tier);
  return (
    <div className="voice-picker">
      <label className="row small">
        <span>Voice</span>
        <select value={choice} onChange={(e) => choose(e.target.value)} aria-label="Voice">
          {config?.tts && <option value="">Server default{list?.default ? ` (${serverVoices.find((v) => v.id === list.default)?.label ?? list.default})` : ""}</option>}
          {group("fast").length > 0 && (
            <optgroup label="Fast: start speaking almost at once">
              {group("fast").map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceLabel(v)}
                </option>
              ))}
            </optgroup>
          )}
          {group("natural").length > 0 && (
            <optgroup label="Most natural: a pause before each sentence">
              {group("natural").map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceLabel(v)}
                </option>
              ))}
            </optgroup>
          )}
          {hasSynthesis() && <option value="device">This device's own voice</option>}
        </select>
        <button type="button" onClick={() => (playing ? speaker.current?.cancel() : void preview())}>
          {playing ? "Stop" : "Preview"}
        </button>
      </label>
      {chosen && chosen.status !== "ready" && (
        <p className="muted small" role="status">
          {chosen.status === "failed" ? (
            <>
              {chosen.label} didn't download{chosen.error ? `: ${chosen.error}` : ""}.{" "}
              <button type="button" className="link" onClick={() => choose(chosen.id)}>
                Try again
              </button>
            </>
          ) : (
            `${chosen.label} is downloading (about ${chosen.sizeMb} MB); the default voice speaks until it's ready.`
          )}
        </p>
      )}
      {note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
