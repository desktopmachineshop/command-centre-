import { useState } from "react";

/**
 * Drive mode's per-device preferences, set in Settings (not while driving) and read by Drive
 * when it opens. Storage can be missing (private mode), so every access is guarded.
 */
export const DRIVE_PREFS = { mode: "cc.drive.mode", followUp: "cc.drive.followUp", talkTo: "cc.drive.talkTo", viz: "cc.drive.viz" };

/** What the talk button shows: the orb, the live trace, or both (the default). */
export type Viz = "both" | "orb" | "trace";

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted; still applies for this session
  }
}

export function readViz(): Viz {
  const v = readPref(DRIVE_PREFS.viz);
  return v === "orb" || v === "trace" ? v : "both";
}

/** Settings → Converse: what used to be Drive mode's Options, set before setting off. */
export function DriveSettings() {
  const [followUp, setFollowUp] = useState(() => readPref(DRIVE_PREFS.followUp) === "1");
  const [viz, setViz] = useState<Viz>(readViz);
  return (
    <div className="drive-settings stack">
      <label className="row small">
        <input
          type="checkbox"
          checked={followUp}
          onChange={(e) => {
            writePref(DRIVE_PREFS.followUp, e.target.checked ? "1" : "0");
            setFollowUp(e.target.checked);
          }}
        />
        Listen for a follow-up after each answer (conversation mode)
      </label>
      <label className="row small">
        Show
        <select
          value={viz}
          onChange={(e) => {
            const v = e.target.value as Viz;
            writePref(DRIVE_PREFS.viz, v);
            setViz(v);
          }}
        >
          <option value="both">Orb and live trace</option>
          <option value="orb">Orb only</option>
          <option value="trace">Live trace only</option>
        </select>
      </label>
      <p className="muted small" data-help-pane="converse.commands">
        Say "what's new", "read approvals", "approve", "next", "repeat", "stop", or a request like "shop: has order 1042 shipped?". Say "talk
        to the shop lead" to talk to one role ("back to chief of staff" for the default, who hands things on and reports back), "who am I
        talking to?", or ask one role once: "ask customer support whether order 1042 shipped". In Converse you can also type any of
        these in the chat box.
      </p>
    </div>
  );
}
