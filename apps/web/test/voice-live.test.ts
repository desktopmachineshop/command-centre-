import { describe, expect, it } from "vitest";
import type { VoiceTurnEvent } from "../src/api";
import { rms, rmsToLevel, smooth } from "../src/voice/level";
import { ReplyStream } from "../src/voice/reply";
import { Downsampler, pauseAfter } from "../src/voice/speech";
import { barsFor, RING_SLOTS, ringFade } from "../src/voice/Waveform";

describe("audio level", () => {
  it("maps RMS to 0..1 on a decibel scale, silent below the noise floor", () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(0.0005)).toBe(0); // about -66 dB: room noise
    expect(rmsToLevel(0.4)).toBe(1); // loud speech, about -8 dB
    const speech = rmsToLevel(0.1); // -20 dB: normal speech near the mic, with headroom left
    expect(speech).toBeGreaterThan(0.7);
    expect(speech).toBeLessThan(0.85);
    const mid = rmsToLevel(0.01); // -40 dB
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.5);
    expect(rms(new Float32Array([0.5, -0.5]))).toBe(0.5);
  });

  it("rises fast and falls slowly", () => {
    expect(smooth(0, 1)).toBeCloseTo(0.6);
    expect(smooth(1, 0)).toBeCloseTo(0.88);
  });

  it("fits the bar history to the width, newest on the right", () => {
    expect(barsFor([0.1, 0.2, 0.3], 5)).toEqual([0, 0, 0.1, 0.2, 0.3]);
    expect(barsFor([0.1, 0.2, 0.3], 2)).toEqual([0.2, 0.3]);
  });

  it("keeps the fresh part of the orb trace solid and fades the old lap out ahead of the head", () => {
    expect(ringFade(0, RING_SLOTS)).toBe(1);
    expect(ringFade(RING_SLOTS / 2 - 1, RING_SLOTS)).toBe(1);
    const tail = [0.6, 0.75, 0.9, 0.99].map((f) => ringFade(Math.round(f * (RING_SLOTS - 1)), RING_SLOTS));
    for (let i = 1; i < tail.length; i++) expect(tail[i]).toBeLessThan(tail[i - 1]!);
    expect(ringFade(RING_SLOTS - 1, RING_SLOTS)).toBeLessThan(0.1);
    expect(ringFade(RING_SLOTS - 1, RING_SLOTS)).toBeGreaterThan(0);
  });
});

describe("Downsampler", () => {
  const tone = (hz: number, rate: number, seconds: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (x: Int16Array) => Math.sqrt(x.reduce((s, v) => s + (v / 0x8000) ** 2, 0) / x.length);
  /** Pushes `x` in 128-sample frames (an AudioWorklet's) and returns everything out, joined. */
  const run = (rate: number, x: Float32Array) => {
    const d = new Downsampler(rate);
    const parts: Int16Array[] = [];
    for (let i = 0; i < x.length; i += 128) parts.push(d.push(x.subarray(i, i + 128)));
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let k = 0;
    for (const p of parts) out.set(p, (k += p.length) - p.length);
    return out;
  };

  it("turns 48 kHz float audio into 16 kHz 16-bit PCM, seamlessly across frames, keeping steady levels", () => {
    const out = run(48000, new Float32Array(4800).fill(0.5));
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(10); // a few samples wait for the next frame
    expect(Math.abs(out[out.length - 1]! / 0x7fff - 0.5)).toBeLessThan(0.01);
  });

  it("passes speech and stops what is above 8 kHz folding back into it", () => {
    const speech = run(48000, tone(1000, 48000, 0.5));
    const hiss = run(48000, tone(11000, 48000, 0.5));
    const sine = 0.5 / Math.SQRT2;
    expect(rms(speech.subarray(100)) / sine).toBeGreaterThan(0.95);
    expect(rms(hiss.subarray(100)) / sine).toBeLessThan(0.02);
  });

  it("handles 44.1 kHz without drift", () => {
    const d = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.push(new Float32Array(441)).length;
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(10);
  });
});

describe("pauseAfter", () => {
  it("breathes after a sentence, a beat after a clause", () => {
    expect(pauseAfter("Done.")).toBeGreaterThan(pauseAfter("Order shipped,"));
  });
});

async function* events(list: (VoiceTurnEvent | { wait: number })[]): AsyncGenerator<VoiceTurnEvent> {
  for (const e of list) {
    if ("wait" in e) await new Promise((r) => setTimeout(r, e.wait));
    else yield e;
  }
}

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("ReplyStream", () => {
  it("is ready on the first words, yields sentences as they complete, and records a handoff", async () => {
    const reply = new ReplyStream();
    const texts: string[] = [];
    reply.onText = (t) => texts.push(t);
    const ok = await reply.start(() =>
      events([{ delta: "Sure, I'll check " }, { wait: 5 }, { delta: "where it is. " }, { delta: "Back soon." }, { done: true, text: "", handoff: { taskId: "t9" } }]),
    );
    expect(ok).toBe(true);
    expect(await collect(reply.pieces())).toEqual(["Sure, I'll check where it is.", "Back soon."]);
    expect(reply.handoff).toEqual({ taskId: "t9" });
    expect(texts.at(-1)).toBe("Sure, I'll check where it is. Back soon.");
  });

  it("reports failure before any words, so Drive asks the agent instead", async () => {
    const failed = new ReplyStream();
    expect(await failed.start(() => events([{ error: "not signed in" }]))).toBe(false);
    expect(failed.error).toBe("not signed in");
    const slow = new ReplyStream();
    expect(await slow.start(() => events([{ wait: 200 }, { delta: "Late." }]), 20)).toBe(false);
  });
});
