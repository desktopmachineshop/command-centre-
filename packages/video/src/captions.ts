import { type Brand, FRAME, type Format, type VideoSpec } from "./spec";
import type { Timeline, WordTiming } from "./timeline";

/** One caption on screen: a short run of words. */
export interface Cue {
  start: number;
  end: number;
  words: WordTiming[];
}

export interface CueOptions {
  /** Characters per cue (spaces included). */
  maxChars: number;
  /** Longest a cue stays up, in seconds. */
  maxDuration: number;
  /** A silence at least this long starts a new cue. */
  gapSec: number;
}

/** Narrow lines for vertical video, where captions sit over the middle of the frame. */
export const DEFAULT_MAX_CHARS: Record<Format, number> = { "9:16": 18, "1:1": 26, "16:9": 42 };

/**
 * Groups words into cues. A cue ends at sentence punctuation, at a pause, or
 * when it would get too long to read, and its end is clamped so it never
 * overlaps the next one.
 */
export function buildCues(words: WordTiming[], options: Partial<CueOptions> = {}): Cue[] {
  const { maxChars = 32, maxDuration = 3, gapSec = 0.6 } = options;
  const cues: Cue[] = [];
  let current: WordTiming[] = [];
  const flush = () => {
    if (current.length) cues.push({ start: current[0]!.start, end: current.at(-1)!.end, words: current });
    current = [];
  };
  for (const word of words) {
    const prev = current.at(-1);
    if (prev) {
      const length = current.map((w) => w.word).join(" ").length + 1 + word.word.length;
      // A sentence's last word may run up to 30% over, rather than sit alone on the next cue.
      const limit = /[.!?]["')\]]?$/.test(word.word) ? maxChars * 1.3 : maxChars;
      if (length > limit || word.end - current[0]!.start > maxDuration || word.start - prev.end >= gapSec) flush();
    }
    current.push(word);
    if (/[.!?]["')\]]?$/.test(word.word)) flush();
  }
  flush();
  // Hold each cue until the next starts (up to half a second) so captions don't flicker.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const cue = cues[i]!;
    cue.end = Math.round(Math.min(cue.end + 0.5, next ? next.start : cue.end + 0.5) * 1000) / 1000;
  }
  return cues;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `HH:MM:SS,mmm` */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** `H:MM:SS.cc` (ASS uses centiseconds). */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.words.map((w) => w.word).join(" ")}\n`).join("\n");
}

/** Text safe inside an ASS Dialogue line: no override blocks, escapes or line breaks. */
export function assEscape(text: string): string {
  return text.replace(/[\0-\x1f\x7f]/g, " ").replace(/\\/g, "⧵").replace(/\{/g, "(").replace(/\}/g, ")");
}

/** `#rrggbb` → ASS `&HAABBGGRR` (alpha 00 = opaque). */
export function assColour(hex: string, alpha = 0): string {
  const h = hex.replace("#", "");
  return `&H${alpha.toString(16).padStart(2, "0")}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

interface AssStyle {
  name: string;
  font: string;
  size: number;
  colour: string;
  outline: string;
  bold: boolean;
  /** Numpad alignment: 2 bottom-centre, 5 middle-centre, 8 top-centre. */
  align: number;
  marginV: number;
  borderStyle?: 1 | 3;
  outlineSize?: number;
  shadow?: number;
  spacing?: number;
  /** Left and right margin: the title-safe area text wraps inside. */
  marginH?: number;
}

function styleLine(s: AssStyle): string {
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic,
  // Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return `Style: ${s.name},${s.font},${s.size},${s.colour},${s.colour},${s.outline},&H96000000,${s.bold ? -1 : 0},0,0,0,100,100,${s.spacing ?? 0},0,${s.borderStyle ?? 1},${s.outlineSize ?? 0},${s.shadow ?? 0},${s.align},${s.marginH ?? 60},${s.marginH ?? 60},${s.marginV},1`;
}

/** Caption block placement: vertical video keeps captions above the platform UI at the bottom. */
function captionPlacement(format: Format, height: number) {
  if (format === "9:16") return { align: 2, marginV: Math.round(height * 0.3), size: Math.round(height * 0.04) };
  if (format === "1:1") return { align: 2, marginV: Math.round(height * 0.1), size: Math.round(height * 0.05) };
  return { align: 2, marginV: Math.round(height * 0.07), size: Math.round(height * 0.05) };
}

/** Card text (title, slide and outro scenes) drawn by libass over a brand-coloured background. */
export interface CardEvent {
  start: number;
  end: number;
  style: "Heading" | "Sub" | "Bullet" | "Cta";
  text: string;
  /** Explicit position (\pos), in output pixels. */
  pos?: [number, number];
}

export interface AssOptions {
  format: Format;
  brand: Brand;
  /** "word" colours the word being spoken in the accent colour. */
  style: "word" | "plain";
  /** "box" puts captions on a dark box (legible over busy footage); default a dark outline. */
  background?: "outline" | "box";
}

/**
 * Builds one ASS script holding the card text and the captions, so a single
 * `subtitles` filter draws both. Fonts come from the brand kit.
 */
export function toAss(cues: Cue[], cards: CardEvent[], options: AssOptions): string {
  const { width, height } = FRAME[options.format];
  const { brand } = options;
  const text = assColour(brand.colours.text);
  const accent = assColour(brand.colours.accent);
  const cap = captionPlacement(options.format, height);
  const unit = Math.min(width, height);
  // Title-safe side margins: wider on vertical video, where platform buttons sit on the right edge.
  const marginH = Math.round(width * (options.format === "9:16" ? 0.09 : 0.06));
  const box = options.background === "box";
  const styles: AssStyle[] = [
    // The box is opaque: libass draws one per coloured run, and see-through boxes would show where they overlap.
    box
      ? { name: "Caption", font: brand.fonts.body, size: cap.size, colour: text, outline: assColour("#0b0b0f"), bold: true, align: cap.align, marginV: cap.marginV, borderStyle: 3, outlineSize: Math.round(cap.size / 5), shadow: 0, spacing: 1, marginH }
      : { name: "Caption", font: brand.fonts.body, size: cap.size, colour: text, outline: assColour("#000000"), bold: true, align: cap.align, marginV: cap.marginV, outlineSize: Math.max(2, Math.round(cap.size / 16)), shadow: 2, spacing: 1, marginH },
    { name: "Heading", font: brand.fonts.heading, size: Math.round(unit * 0.085), colour: text, outline: assColour("#000000"), bold: true, align: 5, marginV: 0 },
    // Secondary text is a size up on vertical and square video, which is watched on a phone.
    { name: "Sub", font: brand.fonts.body, size: Math.round(unit * (options.format === "16:9" ? 0.042 : 0.05)), colour: accent, outline: assColour("#000000"), bold: false, align: 5, marginV: 0 },
    { name: "Bullet", font: brand.fonts.body, size: Math.round(unit * (options.format === "16:9" ? 0.045 : 0.055)), colour: text, outline: assColour("#000000"), bold: false, align: 4, marginV: 0 },
    { name: "Cta", font: brand.fonts.heading, size: Math.round(unit * 0.05), colour: accent, outline: assColour("#000000"), bold: true, align: 5, marginV: 0 },
  ];

  const events: string[] = [];
  for (const card of cards) {
    const pos = card.pos ? `{\\pos(${card.pos[0]},${card.pos[1]})\\fad(200,150)}` : "{\\fad(200,150)}";
    events.push(`Dialogue: 1,${assTime(card.start)},${assTime(card.end)},${card.style},,0,0,0,,${pos}${assEscape(card.text)}`);
  }
  for (const cue of cues) {
    if (options.style === "plain") {
      events.push(`Dialogue: 2,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,${assEscape(cue.words.map((w) => w.word).join(" "))}`);
      continue;
    }
    // One event per word: the whole line, with the word being spoken in the accent colour.
    cue.words.forEach((word, i) => {
      const from = i === 0 ? cue.start : word.start;
      const to = i + 1 < cue.words.length ? cue.words[i + 1]!.start : cue.end;
      if (to <= from) return;
      const line = cue.words
        .map((w, j) => (j === i ? `{\\c${accent}}${assEscape(w.word)}{\\c${text}}` : assEscape(w.word)))
        .join(" ");
      events.push(`Dialogue: 2,${assTime(from)},${assTime(to)},Caption,,0,0,0,,${line}`);
    });
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles.map(styleLine),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Card text events for the title, slide and outro scenes on the timeline. */
export function cardEvents(spec: Pick<VideoSpec, "scenes" | "format">, timeline: Timeline): CardEvent[] {
  const { width, height } = FRAME[spec.format];
  const events: CardEvent[] = [];
  spec.scenes.forEach((scene, i) => {
    const slot = timeline.scenes[i]!;
    const start = slot.start;
    const end = slot.start + slot.duration;
    const cx = Math.round(width / 2);
    if (scene.kind === "title") {
      events.push({ start, end, style: "Heading", text: scene.heading, pos: [cx, Math.round(height * 0.42)] });
      if (scene.subheading) events.push({ start, end, style: "Sub", text: scene.subheading, pos: [cx, Math.round(height * 0.52)] });
    } else if (scene.kind === "outro") {
      events.push({ start, end, style: "Heading", text: scene.heading, pos: [cx, Math.round(height * 0.4)] });
      events.push({ start, end, style: "Cta", text: scene.cta, pos: [cx, Math.round(height * 0.5)] });
      if (scene.url) events.push({ start, end, style: "Sub", text: scene.url, pos: [cx, Math.round(height * 0.57)] });
    } else if (scene.kind === "slide") {
      if (scene.heading) events.push({ start, end, style: "Heading", text: scene.heading, pos: [cx, Math.round(height * 0.22)] });
      const left = Math.round(width * 0.12);
      scene.bullets.forEach((bullet, b) => {
        // Bullets appear one after another over the first half of the scene.
        const appear = start + ((end - start) * 0.5 * b) / Math.max(1, scene.bullets.length);
        events.push({ start: appear, end, style: "Bullet", text: `• ${bullet}`, pos: [left, Math.round(height * (0.34 + b * 0.075))] });
      });
    }
  });
  return events;
}
