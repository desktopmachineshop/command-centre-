import { speakable } from "@cc/voice/speakable";

/** One paragraph to speak, and the section it belongs to. */
export type Part = { section: number; text: string };
export type Script = { sections: { title: string; first: number }[]; parts: Part[] };

/** Sections that are for reading, not listening: exercises with code and the source list. */
const UNSPOKEN = /^(try it|sources|references|further reading)\b/i;

/**
 * A lesson as a list of spoken paragraphs, by section. The title is the first part; "Try it" and
 * "Sources" are left out (they are for reading); lists are read as one paragraph per item. Pure.
 */
export function lessonScript(body: string, title?: string): Script {
  const lines = body.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const sections: Script["sections"] = [];
  const parts: Part[] = [];
  let skip = false;
  let inFence = false;
  let para: string[] = [];
  const flush = () => {
    const text = speakable(para.join("\n"), { maxChars: 6000 });
    para = [];
    if (!text || skip) return;
    if (sections.length === 0) sections.push({ title: title ?? "Introduction", first: parts.length });
    parts.push({ section: sections.length - 1, text });
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
          flush();
        }
      } else if (!skip) {
        para = [`${heading}.`];
        flush();
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

/** Rough minutes left from part `from` at the voices' pace (150 words a minute). Pure. */
export function minutesLeft(parts: Part[], from: number): number {
  const words = parts.slice(from).reduce((n, p) => n + p.text.split(/\s+/).length, 0);
  return Math.ceil(words / 150);
}
