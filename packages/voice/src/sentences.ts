/**
 * Turns streamed text into speakable pieces as soon as each is complete, so speech can start on
 * the first sentence while the rest is still being written. The first piece may end at a comma
 * (once it is long enough) so the first words come out sooner. Pure.
 */
export class SentenceAssembler {
  private buffer = "";
  private emitted = 0;

  constructor(
    private readonly options: { firstMinChars?: number; maxChars?: number } = {},
  ) {}

  /** Adds streamed text; returns the pieces it completed. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const piece = this.take();
      if (!piece) break;
      out.push(piece);
    }
    return out;
  }

  /** The rest, at the end of the stream. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }

  private take(): string | null {
    const max = this.options.maxChars ?? 220;
    // A sentence end: . ! ? (with closing quotes/brackets) followed by whitespace.
    const end = /[.!?]+["')\]]*\s/g;
    let m: RegExpExecArray | null;
    let at = -1;
    while ((m = end.exec(this.buffer))) {
      const candidate = m.index + m[0].length;
      // Skip "e.g. ", "Mr. ", single initials and decimals-looking splits.
      const before = this.buffer.slice(0, m.index + 1);
      if (/\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|st|vs|no)\.$/i.test(before) || /\b[A-Z]\.$/.test(before)) continue;
      at = candidate;
      break;
    }
    if (this.emitted === 0) {
      // First piece: a clause is enough once it is long enough to sound natural, so the
      // voice can start on it while the rest is synthesised.
      const min = this.options.firstMinChars ?? 24;
      const comma = this.buffer.search(/[,;:—–]\s/);
      if (comma >= min && (at < 0 || at - comma > 16)) at = comma + 2;
    }
    if (at < 0 && this.buffer.length > max) {
      const head = this.buffer.slice(0, max);
      const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(" "));
      at = cut > 0 ? cut + 1 : max;
    }
    if (at < 0) return null;
    const piece = this.buffer.slice(0, at).trim();
    this.buffer = this.buffer.slice(at);
    if (!piece) return null;
    this.emitted++;
    return piece;
  }
}

/** All the pieces of a finished text, split the same way. Pure. */
export function speechPieces(text: string, options?: { firstMinChars?: number; maxChars?: number }): string[] {
  const a = new SentenceAssembler(options);
  return [...a.push(text.endsWith(" ") ? text : `${text} `), ...a.flush()];
}
