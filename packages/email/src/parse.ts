import { type AddressObject, simpleParser } from "mailparser";

export const MAX_BODY_CHARS = 20_000;

export interface Address {
  name: string;
  address: string;
}

/** The compact, JSON-safe form of an email that becomes an event payload. */
export interface EmailPayload {
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Plain-text body with quoted history removed where it was easy to spot. */
  text: string;
  quotedHistoryStripped: boolean;
  truncated: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
}

const addresses = (v: AddressObject | AddressObject[] | undefined): Address[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .flatMap((o) => o.value)
    .flatMap((a) => (a.group ? a.group : [a]))
    .filter((a) => a.address)
    .map((a) => ({ name: a.name ?? "", address: a.address!.toLowerCase() }));

/** Parses a raw RFC 822 message into an `EmailPayload`. */
export async function parseEmail(source: Buffer | string): Promise<EmailPayload> {
  const mail = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const raw = (mail.text ?? "").replace(/\r\n/g, "\n");
  const { text: stripped, stripped: quotedHistoryStripped } = stripQuotedHistory(raw);
  const truncated = stripped.length > MAX_BODY_CHARS;
  const refs = mail.references;
  return {
    from: addresses(mail.from)[0] ?? null,
    replyTo: addresses(mail.replyTo),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject?.trim() ?? "",
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : null,
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: (Array.isArray(refs) ? refs : refs ? refs.split(/\s+/) : []).filter(Boolean),
    text: truncated ? `${stripped.slice(0, MAX_BODY_CHARS)}\n[... truncated]` : stripped,
    quotedHistoryStripped,
    truncated,
    attachments: mail.attachments
      .filter((a) => a.contentDisposition !== "inline" || a.filename)
      .map((a) => ({ filename: a.filename ?? "(unnamed)", contentType: a.contentType, size: a.size })),
  };
}

/** Reply-header lines that start the quoted part of a reply. */
const QUOTE_HEADERS: ((lines: string[], i: number) => boolean)[] = [
  // "On Mon, 1 Jan 2026 at 10:00, Jane <jane@x.com> wrote:" (clients often wrap it over 2-3 lines)
  (lines, i) => /^On\s/.test(lines[i]!) && [1, 2, 3].some((n) => /wrote:\s*$/.test(lines.slice(i, i + n).join(" "))),
  (lines, i) => /^-{2,}\s*Original Message\s*-{2,}/i.test(lines[i]!),
  // Outlook: "From: ..." followed shortly by "Sent:" or "Date:"
  (lines, i) =>
    /^\*?From:\*?\s/.test(lines[i]!) && lines.slice(i + 1, i + 5).some((l) => /^\*?(Sent|Date):\*?\s/.test(l)),
];

/**
 * Removes the quoted history of a reply: everything from the first reply header
 * ("On ... wrote:", Outlook's "From:/Sent:" block), and a trailing block of
 * ">" lines. Keeps the text untouched if nothing would be left.
 */
export function stripQuotedHistory(input: string): { text: string; stripped: boolean } {
  const lines = input.split("\n").map((l) => l.trimEnd());
  let end = lines.length;
  let found = false;
  for (let i = 0; i < lines.length && !found; i++) {
    if (QUOTE_HEADERS.some((test) => test(lines, i))) [end, found] = [i, true];
  }
  // Drop a trailing run of quoted (">") and blank lines.
  let tail = end;
  while (tail > 0 && (lines[tail - 1]!.startsWith(">") || lines[tail - 1]!.trim() === "")) tail--;
  if (lines.slice(tail, end).some((l) => l.startsWith(">"))) [end, found] = [tail, true];
  if (!found) return { text: tidy(input), stripped: false };
  // Outlook web puts a rule of underscores above its header block.
  while (end > 0 && /^(_{8,}|\s*)$/.test(lines[end - 1]!)) end--;

  const kept = tidy(lines.slice(0, end).join("\n"));
  return kept ? { text: kept, stripped: true } : { text: tidy(input), stripped: false };
}

const tidy = (s: string) => s.replace(/\n{3,}/g, "\n\n").trim();

export const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);
