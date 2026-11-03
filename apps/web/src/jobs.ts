import type { Capability, Job, WorkerNode } from "@cc/core";

/** What to do on the PC to get a missing capability. */
const HOW_TO_GET: Record<Capability, string> = {
  browser: "press Install under Media production for that PC below (or install Chrome or Edge on it)",
  ffmpeg: "press Install under Media production for that PC below",
  gpu: "use a PC with a graphics card",
  davinci: "install DaVinci Resolve on the PC",
  "claude-local": "press Install under Local Claude Code for that PC below",
};

/**
 * Why a queued job hasn't started, from the computers that are online now: none online, none
 * with everything it needs (and which capabilities are missing), or the capable ones are busy.
 * Null for jobs that aren't queued.
 */
export function waitingReason(
  job: Pick<Job, "status" | "requires"> & Pick<Partial<Job>, "targetNodeId">,
  nodes: (Pick<WorkerNode, "name" | "online" | "capabilities"> & Partial<Pick<WorkerNode, "id">>)[],
): string | null {
  if (job.status !== "queued") return null;
  if (job.targetNodeId) {
    // For one computer only (installing software on it).
    const target = nodes.find((n) => n.id === job.targetNodeId);
    if (!target) return "Waiting for a computer that is no longer listed. Cancel it.";
    return target.online ? `Waiting for ${target.name} to finish its current job.` : `Waiting for ${target.name} to come online. Open the desktop app on it.`;
  }
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
