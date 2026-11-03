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
