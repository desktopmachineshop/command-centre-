export function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** The heading a list groups a day's items under: "Today", "Yesterday", or "Mon 16 Nov". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function usd(n: number | null | undefined): string {
  return n == null ? "–" : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/**
 * What Dave asked, for display. Voice-mode tasks from before the voice rules moved out of the
 * stored prompt carry them after a blank line ("VOICE MODE: ..."): those are for the agent only.
 */
export function askText(prompt: string): string {
  // The voice-mode rules and the text of attached files (server chat-files.ts) are for the agent, not for reading here.
  const cuts = ["\n\nVOICE MODE:", "\n\nDave attached "].map((m) => prompt.indexOf(m)).filter((i) => i >= 0);
  return (cuts.length ? prompt.slice(0, Math.min(...cuts)) : prompt).trim();
}

/** An agent message without the voice-mode protocol line (`{"voice": {...}}`) it ends with: that is for the app, not for reading. */
export function withoutVoiceLine(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^`*(?:json\s*)?\{\s*"voice"\s*:.*\}`*$/i.test(line.trim()))
    .join("\n")
    .trim();
}

/** Where a tool comes from, in words: the MCP server names agents are given (apps/server agent-context). */
const TOOL_SOURCES: Record<string, string> = {
  odoo: "Odoo",
  brain: "Brain",
  actions: "Actions",
  pa: "Calendar and lists",
  mail: "Mail",
  sendcloud: "Parcels",
  video: "Video",
  reddit: "Reddit",
  research: "Research",
  ops: "App health",
  help: "Help",
  github: "GitHub",
  opengym: "Gym",
};
/** Tools whose name says little: what they are for. */
const TOOL_NAMES: Record<string, string> = {
  ToolSearch: "Finding the right tools",
  Skill: "Reading a skill",
  mcp__actions__propose_action: "Proposing an action",
  mcp__actions__propose_batch: "Proposing a batch of actions",
  mcp__actions__update_handover: "Saving its notes on this task",
  mcp__actions__handoff_to_role: "Handing work to a specialist",
  mcp__actions__list_pending: "Checking what is waiting for approval",
};

/** A tool's name for reading: "mcp__odoo__search_products" → "Odoo: search products". */
export function toolLabel(name: string): string {
  if (TOOL_NAMES[name]) return TOOL_NAMES[name];
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!mcp) return name;
  const source = TOOL_SOURCES[mcp[1]!] ?? mcp[1]!.charAt(0).toUpperCase() + mcp[1]!.slice(1);
  return `${source}: ${mcp[2]!.replace(/_/g, " ")}`;
}

/** Where a tool comes from ("Odoo"), or null for one that isn't an integration's. */
function toolSource(name: string): string | null {
  if (TOOL_NAMES[name] && !name.startsWith("mcp__actions__propose")) return null;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return mcp ? (TOOL_SOURCES[mcp[1]!] ?? mcp[1]!) : null;
}

/**
 * One line for a run of tool calls: "4 steps: Odoo, Brain" (and "1 problem" when a call failed),
 * or, while the run is still going, what it is doing now.
 */
export function stepsSummary(steps: { type: string; name?: string; isError?: boolean }[], working = false): string {
  const calls = steps.filter((s) => s.type === "tool_use");
  const problems = steps.filter((s) => s.type === "tool_result" && s.isError).length;
  if (working) {
    const last = calls[calls.length - 1];
    return last?.name ? `Working: ${toolLabel(last.name)}…` : "Working on it…";
  }
  const sources = [...new Set(calls.map((c) => (c.name ? toolSource(c.name) : null)).filter((s): s is string => !!s))];
  const n = calls.length || 1;
  const head = `${n} step${n === 1 ? "" : "s"}`;
  return `${head}${sources.length ? `: ${sources.join(", ")}` : ""}${problems ? ` · ${problems} problem${problems === 1 ? "" : "s"}` : ""}`;
}

/** An email task's prompt, split into what Dave reads: the title line, the email itself, and whether a machine sent it. */
export interface EmailAsk {
  title: string;
  from: string;
  date: string;
  subject: string;
  attachments: string;
  body: string;
  /** Why it looks machine-sent, or null for mail a person wrote. */
  automated: string | null;
}

const NO_REPLY = /\b(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|notifications?)(?:[-_.+][^@\s]*)?@/i;
const SAYS_AUTOMATED = /\b(?:this is an automated (?:message|email)|automatically generated (?:message|email)|please do not reply to (?:this|it)|do not reply to this (?:message|email))\b/i;

/**
 * Reads an email task's prompt (@cc/email emailPrompt). Null for any other prompt.
 * Everything outside BEGIN/END EMAIL is instructions for the agent, so it is dropped.
 */
export function emailAsk(prompt: string): EmailAsk | null {
  const begin = prompt.indexOf("----- BEGIN EMAIL -----\n");
  const end = prompt.lastIndexOf("\n----- END EMAIL -----");
  if (!prompt.startsWith("Email from ") || begin < 0 || end < begin) return null;
  const inner = prompt.slice(begin + "----- BEGIN EMAIL -----\n".length, end);
  const split = inner.indexOf("\n\n");
  const headLines = (split >= 0 ? inner.slice(0, split) : inner).split("\n");
  const header = (name: string) => headLines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";
  const body = split >= 0 ? inner.slice(split + 2) : "";
  const marked = /^Automated email \((.*)\): /m.exec(prompt.slice(0, begin));
  const from = header("From");
  const automated = marked ? marked[1]! : NO_REPLY.test(from) ? "no-reply sender" : SAYS_AUTOMATED.test(body) ? "says it is automated" : null;
  return { title: prompt.split("\n")[0]!, from, date: header("Date"), subject: header("Subject"), attachments: header("Attachments"), body, automated };
}

/**
 * An email body for reading: tracking links shortened to their site, image
 * placeholders dropped, and runs of blank lines squeezed.
 */
export function readableEmailBody(body: string): string {
  return body
    .replace(/\[https?:\/\/[^\]\s]+\.(?:png|jpe?g|gif|svg|webp)\]/gi, "")
    .replace(/\[?(https?:\/\/[^\s\]]+)\]?/g, (whole, url: string) => {
      if (url.length <= 60) return whole;
      try {
        return `[link: ${new URL(url).hostname}]`;
      } catch {
        return "[link]";
      }
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A file size for a chip: 820 B, 340 KB, 2.1 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
