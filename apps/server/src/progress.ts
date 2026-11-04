import type { AgentMessage } from "@cc/core";
import type { Notifier } from "./push";

/** A short, human line for what the agent is doing, from its latest message. */
export function describeActivity(message: AgentMessage): string | null {
  if (message.type === "tool_use") return `Working: ${message.name.replace(/^mcp__/, "").replace(/__/g, " ")}`;
  if (message.type === "text") {
    const line = message.text.trim().split("\n")[0] ?? "";
    return line ? (line.length > 140 ? `${line.slice(0, 137)}...` : line) : null;
  }
  return null;
}

/**
 * Progressive updates for a long run: once the run has lasted `intervalMs`, and then every
 * `intervalMs`, pushes one low-priority "agent" notification with the latest activity. Each
 * update uses the same tag so it replaces the previous one instead of stacking. Short runs
 * never notify. Call `note()` for every message and `stop()` when the run ends.
 */
export function startProgressUpdates(opts: {
  notifier?: Notifier;
  intervalMs: number;
  title: string;
  url: string;
  vertical: string;
  tag: string;
}): { note(message: AgentMessage): void; stop(): void } {
  const { notifier, intervalMs } = opts;
  if (!notifier || !(intervalMs > 0)) return { note() {}, stop() {} };
  const startedAt = Date.now();
  let latest: string | null = null;
  let lastSent: string | null = null;
  const timer = setInterval(() => {
    const body = latest ?? "Still working";
    if (body === lastSent) return; // nothing new since the last update
    lastSent = body;
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    void notifier
      .notify({ title: `${opts.title} (${minutes} min)`, body, url: opts.url, category: "agent", priority: "low", vertical: opts.vertical, tag: opts.tag })
      .catch((err) => console.error("[pipeline] progress push failed:", (err as Error).message));
  }, intervalMs);
  timer.unref?.();
  return {
    note(message) {
      latest = describeActivity(message) ?? latest;
    },
    stop: () => clearInterval(timer),
  };
}
