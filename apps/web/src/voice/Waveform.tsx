import { type ReactNode, useEffect, useRef } from "react";
import type { LevelSource } from "./level";

/** Calls `frame` on every animation frame while mounted. */
function useFrames(frame: (now: number) => void) {
  const ref = useRef(frame);
  ref.current = frame;
  useEffect(() => {
    let id = 0;
    const loop = (now: number) => {
      ref.current(now);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

const BAR_MS = 55;

/** Heights to draw for a bar history, newest last, fitted to `count` bars. Pure. */
export function barsFor(history: number[], count: number): number[] {
  const out = new Array<number>(count).fill(0);
  const recent = history.slice(-count);
  out.splice(count - recent.length, recent.length, ...recent);
  return out;
}

/**
 * Claude-style recording waveform: a bar per moment of the live microphone level, scrolling
 * left as you talk. Drawn on a canvas in the element's text colour.
 */
export function Waveform({ source, className = "" }: { source: () => LevelSource | null; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<number[]>([]);
  const peak = useRef(0);
  const lastBar = useRef(0);

  useFrames((now) => {
    const el = canvas.current;
    if (!el) return;
    peak.current = Math.max(peak.current, source()?.read() ?? 0);
    if (now - lastBar.current < BAR_MS) return;
    lastBar.current = now;
    history.current.push(peak.current);
    if (history.current.length > 400) history.current.splice(0, history.current.length - 400);
    peak.current = 0;

    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(el).color;
    const barW = 3;
    const gap = 2;
    const count = Math.max(1, Math.floor((w + gap) / (barW + gap)));
    const bars = barsFor(history.current, count);
    const minH = 2;
    bars.forEach((level, i) => {
      const bh = Math.max(minH, level * (h - 2));
      const x = w - (count - i) * (barW + gap) + gap;
      const y = (h - bh) / 2;
      ctx.globalAlpha = level > 0.02 ? 1 : 0.35;
      ctx.beginPath();
      ctx.roundRect?.(x, y, barW, bh, barW / 2) ?? ctx.rect(x, y, barW, bh);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  });

  return <canvas ref={canvas} className={`waveform ${className}`.trim()} aria-hidden="true" />;
}

/** Slots in one lap of the orb trace: at BAR_MS a slot, a lap takes about five seconds. */
export const RING_SLOTS = 90;
/** The share of a lap, at the old end, over which the trace fades out ahead of the head. */
const RING_FADE = 0.45;
const RING_FLOOR = 0.06;

/**
 * Opacity of an orb-trace slot by age: 0 is the slot just written, `slots - 1` the oldest, which
 * the head overwrites next. Fresh trace is solid; the last stretch before the head fades away. Pure.
 */
export function ringFade(age: number, slots: number): number {
  const fadeFrom = slots * (1 - RING_FADE);
  if (age < fadeFrom) return 1;
  const t = Math.min(1, (age - fadeFrom) / (slots - 1 - fadeFrom || 1));
  // Ease out so most of the tail stays readable and only the end closest to the head vanishes.
  return Math.max(RING_FLOOR, 1 - t * t);
}

/**
 * Drive mode's live trace, wrapped around the orb: a sweep that goes round clockwise from the
 * top, one radial bar per moment of the level, writing over the previous lap as it gets there.
 * The old lap fades out just ahead of the head. Drawn on a canvas in the element's text colour.
 * The bars fill the outer band of the canvas, `--trace-band` px deep (CSS; 15% of the diameter
 * if unset), starting `gap` px out from the band's inner edge, where the orb ends.
 */
export function OrbTrace({ source, className = "", gap = 4 }: { source: () => LevelSource | null; className?: string; gap?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const slots = useRef<number[]>(new Array<number>(RING_SLOTS).fill(-1));
  const head = useRef(0);
  const peak = useRef(0);
  const lastBar = useRef(0);

  useFrames((now) => {
    const el = canvas.current;
    if (!el) return;
    peak.current = Math.max(peak.current, source()?.read() ?? 0);
    if (now - lastBar.current < BAR_MS) return;
    lastBar.current = now;
    slots.current[head.current] = peak.current;
    head.current = (head.current + 1) % RING_SLOTS;
    peak.current = 0;

    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(el);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2;
    const band = Number.parseFloat(style.getPropertyValue("--trace-band")) || radius * 0.3;
    const outer = radius - 2;
    const inner = Math.min(outer - 8, radius - band + gap);
    const span = Math.max(4, outer - inner);
    ctx.strokeStyle = style.color;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, ((2 * Math.PI * inner) / RING_SLOTS) * 0.5);
    for (let i = 0; i < RING_SLOTS; i++) {
      const level = slots.current[i] ?? -1;
      if (level < 0) continue;
      const age = (head.current - 1 - i + RING_SLOTS) % RING_SLOTS;
      const a = (i / RING_SLOTS) * 2 * Math.PI - Math.PI / 2;
      const len = Math.max(1, level * span);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.globalAlpha = ringFade(age, RING_SLOTS) * (level > 0.02 ? 1 : 0.35);
      ctx.beginPath();
      ctx.moveTo(cx + cos * inner, cy + sin * inner);
      ctx.lineTo(cx + cos * (inner + len), cy + sin * (inner + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });

  return <canvas ref={canvas} className={`orb-trace ${className}`.trim()} aria-hidden="true" />;
}

/**
 * Drive mode's orb: swells and glows with the microphone while listening, with the voice while
 * speaking, and breathes slowly while thinking. The level is passed to CSS as `--level`.
 */
export function VoiceOrb({ source, mode, children }: { source: () => LevelSource | null; mode: string; children?: ReactNode }) {
  const el = useRef<HTMLSpanElement>(null);
  useFrames(() => {
    const level = source()?.read() ?? 0;
    el.current?.style.setProperty("--level", level.toFixed(3));
  });
  return (
    <span ref={el} className={`voice-orb is-${mode}`} aria-hidden="true">
      <span className="voice-orb-ring" />
      <span className="voice-orb-ring two" />
      <span className="voice-orb-core">{children}</span>
    </span>
  );
}
