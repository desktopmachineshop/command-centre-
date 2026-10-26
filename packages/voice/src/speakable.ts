/**
 * Turns agent or UI text into something a speech engine reads well: no
 * markdown, tables, code or URLs, short. Pure and dependency-free, so the PWA
 * imports it too (`@cc/voice/speakable`).
 */

export interface SpeakableOptions {
  /** Cut at a sentence boundary near this length (default 4000 characters, about four minutes: read everything but a runaway answer). */
  maxChars?: number;
  /** Appended when the text was cut. */
  more?: string;
}

const DEFAULT_MORE = "There's more on screen when you're parked.";

export function speakable(input: string | null | undefined, options: SpeakableOptions = {}): string {
  if (!input) return "";
  const max = options.maxChars ?? 4000;
  let t = input.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?```/g, " "); // code blocks
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1"); // links keep their text
  t = t.replace(/<https?:\/\/[^>]+>/g, "a link");
  t = t.replace(/\bhttps?:\/\/\S+/g, "a link");
  t = t.replace(/\bwww\.\S+/g, "a link");
  // Tables: drop separator rows, turn cells into a comma list.
  t = t
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line))
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
            .join(", ") + "."
        : line,
    )
    .join("\n");
  t = t.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1."); // headings
  t = t.replace(/^\s*>\s?/gm, ""); // quotes
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, ""); // list markers
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2"); // emphasis
  t = t.replace(/~~(.*?)~~/g, "$1");
  t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");
  t = t.replace(/[|*#_~^<>{}[\]\\]/g, " ");
  // A line break ends a sentence when nothing else does.
  t = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`))
    .join(" ");
  t = t.replace(/\s+([.,!?;:])/g, "$1").replace(/([.!?]){2,}/g, "$1").replace(/\s{2,}/g, " ").trim();
  t = spokenNumbers(t);
  return truncate(t, max, options.more ?? DEFAULT_MORE);
}

/** Money and a few symbols that engines misread. */
export function spokenNumbers(t: string): string {
  return t
    .replace(/([$£€])\s?(\d[\d,]*)(?:\.(\d{1,2}))?\b/g, (_m, sym: string, whole: string, frac?: string) => money(sym, Number(whole.replace(/,/g, "")), frac))
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/\s&\s/g, " and ")
    .replace(/(\d)\s?[x×]\s?(\d)/g, "$1 by $2");
}

const UNITS: Record<string, [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"],
};

function money(sym: string, whole: number, frac?: string): string {
  const [one, many, minorOne, minorMany] = UNITS[sym]!;
  const minor = frac ? Number(frac.padEnd(2, "0")) : 0;
  if (whole === 0 && minor > 0) return `${minor} ${minor === 1 ? minorOne : minorMany}`;
  const major = `${whole.toLocaleString("en-GB")} ${whole === 1 ? one : many}`;
  return minor > 0 ? `${major} ${minor}` : major;
}

/** Spoken amount for a cost in US dollars, e.g. 0.42 → "42 cents", 3.2 → "3 dollars 20". */
export function spokenUsd(amount: number): string {
  const cents = Math.round(amount * 100);
  if (cents === 0) return amount > 0 ? "less than a cent" : "nothing";
  return money("$", Math.floor(cents / 100), String(cents % 100).padStart(2, "0"));
}

/** Cuts at the last sentence end before `max`, or the last word. */
export function truncate(text: string, max: number, more = DEFAULT_MORE): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  const cut = sentence > max * 0.4 ? head.slice(0, sentence + 1) : `${head.slice(0, head.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
  return more ? `${cut} ${more}` : cut;
}

/** "Approval", "2 approvals". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n === 0 ? "no" : n} ${n === 1 ? one : many}`;
}
