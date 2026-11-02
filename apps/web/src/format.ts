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
