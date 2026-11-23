import { useEffect, useRef, useState } from "react";
import type { Api, Narration, VoiceConfig, VoiceList } from "../api";

/**
 * The lesson narrator, chosen in Settings beside the device's own voice (pages/Settings.tsx): who
 * records each lesson on the server (learning-audio.ts).
 */
/** "kokoro:bf_emma" → "Emma (Kokoro)", for a voice the server doesn't list right now. Pure. */
export function prettyVoice(id: string): string {
  const [family = "", name = id] = id.includes(":") ? id.split(":") : ["", id];
  const bare = name.replace(/^[ab][fm]_/, "").replace(/_/g, " ");
  const cap = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());
  return family ? `${cap(bare)} (${cap(family)})` : cap(bare);
}

/**
 * Who records the lessons. The server's own voices are free and have no limits; "most natural"
 * ones (Kokoro) take a little longer to record, which doesn't matter for a lesson recorded at dawn.
 */
export function NarratorPicker({ api, narration, onChange }: { api: Api; narration: Narration | null; onChange: () => void }) {
  const [list, setList] = useState<VoiceList | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    api.voices().then(setList).catch(() => setList(null));
    api.voiceConfig().then(setConfig).catch(() => setConfig(null));
    return () => audio.current?.pause();
  }, [api]);
  if (!narration) return null;
  const voices = list?.voices ?? [];
  const keyed = config?.tts && config.tts.provider !== "local";
  const chosen = voices.find((v) => v.id === narration.narrator);
  const choose = async (id: string) => {
    setNote(null);
    try {
      await api.setNarrator(id);
      const v = voices.find((x) => x.id === id);
      if (v && v.status !== "ready" && v.tier !== "elevenlabs") void api.installVoice(id).then(setList).catch(() => {});
      setNote(
        v?.tier === "elevenlabs" || (!v && keyed)
          ? "New lessons will be recorded with this voice. It's a paid voice: a 30-minute lesson is about 27,000 characters of speech."
          : "New lessons will be recorded with this voice (free, on the server). To re-record a lesson, open it and choose Re-record.",
      );
      onChange();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const preview = async () => {
    audio.current?.pause();
    setPlaying(true);
    setNote(null);
    try {
      const blob = await api.speak("Welcome back. Today we're looking at how EtherCAT keeps a hundred axes in step, and why it matters on the factory floor.", narration.narrator || undefined, { fallback: false });
      const a = new Audio(URL.createObjectURL(blob));
      audio.current = a;
      a.onended = () => setPlaying(false);
      await a.play();
    } catch (e) {
      setPlaying(false);
      setNote((e as Error).message.includes("downloading") || (e as Error).message.includes("409") ? "That voice is still downloading. Try again in a minute." : (e as Error).message);
    }
  };
  const group = (tier: string) => voices.filter((v) => v.tier === tier);
  return (
    <div className="narrator">
      <p className="muted small">
        Each lesson is recorded once, before you need it: whole sentences with natural pauses, terms said the way{" "}
        <a href={`#/brain/${encodeURIComponent("learning/pronunciation.md")}`}>the pronunciation list</a> says, and every sentence checked by ear.
      </p>
      <div className="row wrap narrator-row">
        <select value={narration.narrator} onChange={(e) => void choose(e.target.value)} aria-label="Narrator">
          {keyed && <option value="">{`Server voice (${config!.tts!.provider}, paid)`}</option>}
          {group("natural").length > 0 && (
            <optgroup label="Most natural: free, on the server">
              {group("natural").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description.split(" · ")[0]}
                  {v.status === "ready" ? "" : v.status === "installing" ? " (downloading…)" : ` (downloads ${v.sizeMb} MB)`}
                </option>
              ))}
            </optgroup>
          )}
          {group("fast").length > 0 && (
            <optgroup label="Fast: free, less natural">
              {group("fast").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description.split(" · ")[0]}
                </option>
              ))}
            </optgroup>
          )}
          {group("elevenlabs").length > 0 && (
            <optgroup label="ElevenLabs (paid)">
              {group("elevenlabs").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          )}
          {!voices.some((v) => v.id === narration.narrator) && narration.narrator && <option value={narration.narrator}>{prettyVoice(narration.narrator)}</option>}
        </select>
        <button type="button" onClick={() => (playing ? (audio.current?.pause(), setPlaying(false)) : void preview())}>
          {playing ? "Stop" : "Preview"}
        </button>
      </div>
      {chosen && chosen.status !== "ready" && chosen.tier !== "elevenlabs" && <p className="muted small">{chosen.label} is downloading ({chosen.sizeMb} MB); recordings wait for it.</p>}
      {!narration.available && <p className="error small">Recording is off: {narration.reason}. Lessons are read live instead.</p>}
      {narration.current && (
        <p className="muted small" role="status">
          Recording {narration.current.total ? `${Math.round((narration.current.done / narration.current.total) * 100)}%` : "…"}
          {narration.queued.length ? `, ${narration.queued.length} more waiting` : ""}.
        </p>
      )}
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
