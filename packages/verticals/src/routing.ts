import { type Event, findRole, ROOT_ROLE_ID, type TriageResult } from "@cc/core";
import type { VerticalRegistry } from "./index";

export interface RoleRoute {
  vertical: string;
  role: string;
  /** Why this role: a specialist Dave named, one a schedule or handoff assigned, or the assistant, which takes everything else. */
  reason: "explicit" | "assigned" | "assistant";
}

/** Sources whose `payload.role` is set by Dave or the server itself, so it is honoured. */
const ASSIGNING_SOURCES = new Set(["chat", "cron", "system"]);

/**
 * "support: ...", "dms/support: ..." or "dms support: ..." at the start of a
 * chat. Returns the role name and the vertical hint, if any; null when the
 * text has no short prefix before a colon.
 */
export function parseRolePrefix(text: string, verticalIds: readonly string[]): { vertical?: string; role: string } | null {
  const m = /^\s*([a-z0-9][a-z0-9 &/_-]{0,48}?)\s*:(?!\/)/i.exec(text);
  if (!m) return null;
  const prefix = m[1]!.trim().toLowerCase();
  const slash = prefix.indexOf("/");
  if (slash > 0) return { vertical: prefix.slice(0, slash).trim(), role: prefix.slice(slash + 1).trim() };
  const [first, ...rest] = prefix.split(/\s+/);
  if (rest.length && verticalIds.includes(first!)) return { vertical: first, role: rest.join(" ") };
  return { role: prefix };
}

/**
 * Picks the role for a new task, after triage. Everything goes to the assistant (the root role)
 * in the triaged business, except:
 * 1. a specialist assigned in the payload by a trusted source (a schedule, a handoff, the chat API);
 * 2. a specialist named at the start of a chat ("video: ...", "3dpandme/blog: ...").
 * Either may move the task to the specialist's business (only Dave and the server set them).
 * A name several businesses share goes to the triaged business's specialist, else is ignored.
 */
export function routeRole(
  registry: VerticalRegistry,
  event: Pick<Event, "source" | "payload"> & { vertical?: string | null },
  triage: Pick<TriageResult, "vertical" | "intent">,
): RoleRoute {
  const vertical = registry.require(triage.vertical);
  const assistant: RoleRoute = { vertical: vertical.id, role: ROOT_ROLE_ID, reason: "assistant" };
  const named = (name: string, hint?: string, reason: RoleRoute["reason"] = "explicit"): RoleRoute | null => {
    const root = registry.root;
    const key = name.trim().toLowerCase();
    if (key === ROOT_ROLE_ID || root.aliases.includes(key) || root.title.toLowerCase() === key) return assistant;
    if (hint) {
      const v = registry.get(hint);
      const role = v && findRole(v, name);
      return v && role ? { vertical: v.id, role: role.id, reason } : null;
    }
    const own = findRole(vertical, name);
    if (own) return { vertical: vertical.id, role: own.id, reason };
    const matches = registry.all().flatMap((v) => {
      const role = findRole(v, name);
      return role ? [{ vertical: v.id, role: role.id, reason }] : [];
    });
    return matches.length === 1 ? matches[0]! : null;
  };

  const payload = event.payload ?? {};
  if (ASSIGNING_SOURCES.has(event.source) && typeof payload.role === "string" && payload.role) {
    const assigned = named(payload.role, undefined, event.source === "chat" ? "explicit" : "assigned");
    if (assigned) return assigned;
  }
  if (event.source === "chat" && typeof payload.text === "string") {
    const prefix = parseRolePrefix(payload.text, registry.all().map((v) => v.id));
    const chosen = prefix && named(prefix.role, prefix.vertical);
    if (chosen) return chosen;
  }
  return assistant;
}
