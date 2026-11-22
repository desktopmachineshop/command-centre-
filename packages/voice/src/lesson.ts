import { speechPieces } from "./sentences";
import { speakable } from "./speakable";

/**
 * Lessons as speech (the Learning page, apps/server/src/learning-audio.ts): which parts are
 * spoken, how terms are pronounced (a lexicon kept in the brain), and the pauses that give a
 * recording its cadence. Pure and dependency-free, so the PWA imports it too (`@cc/voice/lesson`).
 */

/** One paragraph to speak, and the section it belongs to. `heading` marks a section or sub-heading. */
export type Part = { section: number; text: string; heading?: boolean };
export type Script = { sections: { title: string; first: number }[]; parts: Part[] };

/** Term → how to say it, e.g. "EtherCAT" → "Ether-cat". */
export type Lexicon = Map<string, string>;

/** Sections that are for reading, not listening: exercises with code and the source list. */
const UNSPOKEN = /^(try it|sources|references|further reading)\b/i;

/**
 * The pronunciation note's entries: `- Term: how to say it` lines (or `| Term | Say |` table
 * rows), anywhere except under a "To check" heading, which lists terms not yet settled. Pure.
 */
export function parseLexicon(body: string): Lexicon {
  const out: Lexicon = new Map();
  let skip = false;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      skip = /^to check\b/i.test(h[1]!.trim());
      continue;
    }
    if (skip) continue;
    const item = /^\s*[-*]\s+`?([^`:|]+?)`?\s*:\s+(.+?)\s*$/.exec(line);
    const row = /^\s*\|\s*`?([^`|]+?)`?\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    const [term, say] = item ? [item[1]!, item[2]!] : row ? [row[1]!, row[2]!] : [];
    if (!term || !say || /^-+$/.test(say) || /^(term|say|word)$/i.test(term)) continue;
    out.set(term.trim(), say.trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Says each lexicon term its way, whole words only (a plural "s" kept), longest terms first so
 * "TwinCAT 3" wins over "TwinCAT". A term with a capital matches its case exactly; an all
 * lower-case term matches any case. Pure.
 */
export function applyLexicon(text: string, lexicon: Lexicon | undefined): string {
  if (!lexicon?.size) return text;
  let out = text;
  for (const term of [...lexicon.keys()].sort((a, b) => b.length - a.length)) {
    const say = lexicon.get(term)!;
    const flags = /[A-Z]/.test(term) ? "g" : "gi";
    out = out.replace(new RegExp(`(?<![\\w-])${escape(term)}(s?)(?![\\w-])`, flags), (_m, s: string) => `${say}${s}`);
  }
  return out;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** "61" → "sixty-one", "08" → "oh eight". */
const pair = (d: string): string => {
  const n = Number(d);
  if (d.length === 2 && d[0] === "0") return `oh ${ONES[n]}`;
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ""}`;
};
/** "131" → "one thirty-one", "508" → "five oh eight". */
const triple = (d: string) => `${ONES[Number(d[0])]} ${pair(d.slice(1))}`;

/**
 * Standards' numbers the way engineers say them, not as amounts: "IEC 61131-3" is "I E C
 * sixty-one one thirty-one, part 3", not "sixty-one thousand one hundred and thirty-one".
 * Five-digit numbers after a standards body (IEC, ISO, EN, IEEE, DIN, BS, UL, ASTM, ANSI, VDI) or
 * joined to one ("ISO/IEC/IEEE 29148"). Pure.
 */
export function standardNumbers(text: string): string {
  return text.replace(/\b((?:IEC|ISO|EN|IEEE|DIN|BS|UL|ASTM|ANSI|VDI)(?:\/(?:IEC|ISO|EN|IEEE|DIN))*)[ -](\d{5})(?:-(\d{1,2}))?\b/g, (_m, body: string, n: string, part?: string) => {
    const said = `${pair(n.slice(0, 2))} ${triple(n.slice(2))}`;
    return `${body} ${said}${part ? `, part ${part}` : ""}`;
  });
}

/**
 * A lesson as a list of spoken paragraphs, by section. The title is the first part; "Try it" and
 * "Sources" are left out (they are for reading); lists are read as one paragraph per item; the
 * lexicon, then standards' numbers, are applied before anything else touches the words. Pure.
 */
export function lessonScript(body: string, title?: string, lexicon?: Lexicon): Script {
  const lines = body.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const sections: Script["sections"] = [];
  const parts: Part[] = [];
  let skip = false;
  let inFence = false;
  let para: string[] = [];
  const flush = (heading = false) => {
    const text = speakable(standardNumbers(applyLexicon(para.join("\n"), lexicon)), { maxChars: 6000 });
    para = [];
    if (!text || skip) return;
    if (sections.length === 0) sections.push({ title: title ?? "Introduction", first: parts.length });
    parts.push({ section: sections.length - 1, text, ...(heading ? { heading: true } : {}) });
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const heading = h[2]!.trim();
      if (h[1]!.length <= 2) {
        skip = h[1]!.length === 2 && UNSPOKEN.test(heading);
        if (!skip) {
          sections.push({ title: heading, first: parts.length });
          para = [`${heading}.`];
          flush(true);
        }
      } else if (!skip) {
        para = [`${heading}.`];
        flush(true);
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A list item or a quiz answer starts a paragraph of its own.
    if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(line) || /^\s*\*\*answer/i.test(line)) flush();
    para.push(line);
  }
  flush();
  return { sections, parts };
}

/** Rough minutes left from part `from` at the voices' pace (165 words a minute). Pure. */
export function minutesLeft(parts: Part[], from: number): number {
  const words = parts.slice(from).reduce((n, p) => n + p.text.split(/\s+/).length, 0);
  return Math.ceil(words / 165);
}

/** Seconds of silence after a piece: the cadence of a narrated lesson. */
export const PAUSES = { sentence: 0.3, paragraph: 0.75, heading: 0.9, section: 1.5 } as const;

/** One sentence of a recording: what to say, the silence after it, and its section. */
export type NarrationPiece = { section: number; text: string; pause: number };

/**
 * The recording's pieces: each paragraph split into sentences (never mid-sentence at a comma,
 * as live speech does to start sooner), with a short pause after a sentence, a longer one after a
 * paragraph or heading, and the longest before a new section. Pure.
 */
export function narrationPieces(script: Script): NarrationPiece[] {
  const out: NarrationPiece[] = [];
  script.parts.forEach((part, i) => {
    const next = script.parts[i + 1];
    const sentences = speechPieces(part.text, { firstMinChars: 100_000, maxChars: 400 });
    sentences.forEach((text, j) => {
      const last = j === sentences.length - 1;
      const pause = !last
        ? PAUSES.sentence
        : next && next.section !== part.section
          ? PAUSES.section
          : part.heading
            ? PAUSES.heading
            : PAUSES.paragraph;
      out.push({ section: part.section, text, pause });
    });
  });
  return out;
}
