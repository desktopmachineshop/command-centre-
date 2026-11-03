import type { Capability, Job, WorkerNode } from "@cc/core";

/** What to do on the PC to get a missing capability. */
const HOW_TO_GET: Record<Capability, string> = {
  browser: "update the desktop app (it brings screen capture) and make sure Chrome or Edge is installed",
  ffmpeg: "install ffmpeg on the PC and restart the desktop app",
  gpu: "use a PC with a graphics card",
  davinci: "install DaVinci Resolve on the PC",
  "claude-local": "install Claude Code on the PC",
};

/**
 * Why a queued job hasn't started, from the computers that are online now: none online, none
 * with everything it needs (and which capabilities are missing), or the capable ones are busy.
 * Null for jobs that aren't queued.
 */
export function waitingReason(job: Pick<Job, "status" | "requires">, nodes: Pick<WorkerNode, "name" | "online" | "capabilities">[]): string | null {
  if (job.status !== "queued") return null;
  const online = nodes.filter((n) => n.online);
  if (online.length === 0) return "Waiting: no computer is online. Open the desktop app on your PC.";
  const missingOn = (n: (typeof online)[number]) => job.requires.filter((c) => !n.capabilities.includes(c));
  if (online.some((n) => missingOn(n).length === 0)) return "Waiting for a computer that can run it to finish its current job.";
  // The online computer missing the least, so the hint is about the closest one.
  const best = online.reduce((a, b) => (missingOn(b).length < missingOn(a).length ? b : a));
  const missing = missingOn(best);
  const how = missing.map((c) => HOW_TO_GET[c]).join("; ");
  return `Waiting: no online computer has ${missing.join(" and ")} (${best.name} is missing ${missing.length > 1 ? "them" : "it"}). To run it, ${how}. Or cancel it.`;
}
