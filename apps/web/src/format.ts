export function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function usd(n: number | null | undefined): string {
  return n == null ? "–" : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/**
 * What Dave asked, for display. Voice-mode tasks from before the voice rules moved out of the
 * stored prompt carry them after a blank line ("VOICE MODE: ..."): those are for the agent only.
 */
export function askText(prompt: string): string {
  const i = prompt.indexOf("\n\nVOICE MODE:");
  return (i >= 0 ? prompt.slice(0, i) : prompt).trim();
}

/** An agent message without the voice-mode protocol line (`{"voice": {...}}`) it ends with: that is for the app, not for reading. */
export function withoutVoiceLine(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^`*(?:json\s*)?\{\s*"voice"\s*:.*\}`*$/i.test(line.trim()))
    .join("\n")
    .trim();
}
