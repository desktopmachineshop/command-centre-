import type { NotificationInput } from "@cc/core";

/** The tag a task's progress updates and its final notification share, so each replaces the last. */
export const taskTag = (taskId: string): string => `progress-${taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22)}`;

/**
 * An agent's answer as a few plain lines for a notification: without card blocks, code, the
 * voice-mode line and markdown marks, cut to `max` characters at a word.
 */
export function answerPreview(result: string | null | undefined, max = 280): string {
  if (!result) return "";
  const text = result
    .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1\s*$/gm, "") // fenced blocks (cards, code)
    .split(/\r?\n/)
    .filter((line) => !/^`*(?:json\s*)?\{\s*"voice"\s*:.*\}`*$/i.test(line.trim()))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trimEnd()}…`;
}

/** An answer this soon after the question isn't held for quiet hours. */
export const FRESH_MS = 10 * 60_000;

/**
 * What Dave is told when something he asked for ends while he isn't looking at the app: the
 * answer's first lines, or why it didn't finish. It opens the task, and replaces the task's
 * progress updates. Null when there is nothing to say.
 */
export function outcomeNotification(o: {
  taskId: string;
  vertical: string;
  /** What he asked, e.g. the chat message. */
  ask: string;
  status: "done" | "failed";
  result?: string | null;
  /** Why it failed (the task's note). */
  note?: string | null;
  /** When he asked. An answer within FRESH_MS of that is pushed even in quiet hours: he is still up. */
  askedAt?: Date | null;
  now?: Date;
}): NotificationInput | null {
  const ask = (o.ask.trim().split("\n")[0] ?? "").slice(0, 90) || "Your request";
  const fresh = !!o.askedAt && (o.now ?? new Date()).getTime() - o.askedAt.getTime() < FRESH_MS;
  const base = { ...(fresh ? { breaksQuiet: true } : {}), url: `/task/${o.taskId}`, category: "agent" as const, vertical: o.vertical, tag: taskTag(o.taskId), replaces: true, renotify: true, data: { taskId: o.taskId, outcome: o.status } };
  if (o.status === "failed") {
    return { ...base, title: `Didn't finish: ${ask}`, body: (o.note ?? "").replace(/^Run failed:\s*/, "").slice(0, 300) || "The agent stopped without saying why. Open it to retry.", priority: "high" };
  }
  const body = answerPreview(o.result);
  return body ? { ...base, title: ask, body, priority: "normal" } : null;
}

/** Tools that change Dave's own lists, reminders and calendar: small things he asked for by name. */
const ROUTINE_TOOLS = /^mcp__pa__(add|update|cancel|complete)_/;
/** Action types of the same kind, and the brain's own notes. */
const ROUTINE_ACTIONS = /^(pa\.|brain\.)/;

/**
 * Whether a run was a routine confirmation: it did a small thing Dave asked for (set a reminder,
 * added to a list, wrote a note), everything it proposed ran, and its answer only says so. That it
 * is on the list is the confirmation: nothing is pushed and no card is made for it; it shows in
 * Activity. An answer that asks him something, or is long enough to be telling him something, isn't routine.
 */
export function isRoutine(run: { tools: Iterable<string>; proposals: { actionType: string; status: string }[]; result: string | null }): boolean {
  const did = [...run.tools].some((t) => ROUTINE_TOOLS.test(t)) || run.proposals.some((p) => ROUTINE_ACTIONS.test(p.actionType));
  if (!did) return false;
  if (run.proposals.some((p) => p.status !== "executed" || !ROUTINE_ACTIONS.test(p.actionType))) return false;
  const answer = answerPreview(run.result, 2000);
  return answer.length <= 400 && !answer.includes("?");
}
