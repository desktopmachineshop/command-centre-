import { describe, expect, it } from "vitest";
import type { VoiceTurnEvent } from "../src/api";
import { rms, rmsToLevel, smooth } from "../src/voice/level";
import { ReplyStream } from "../src/voice/reply";
import { Downsampler, pauseAfter } from "../src/voice/speech";
import { barsFor } from "../src/voice/Waveform";

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
});

describe("Downsampler", () => {
  it("turns 48 kHz float audio into 16 kHz 16-bit PCM, seamlessly across frames", () => {
    const d = new Downsampler(48000);
    const a = d.push(new Float32Array(128).fill(0.5));
    const b = d.push(new Float32Array(128).fill(-0.5));
    expect(a.length + b.length).toBe(85); // 256 / 3, the remainder carried
    expect(a[0]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(b.at(-1)).toBe(-0x4000);
  });

  it("handles 44.1 kHz without drift", () => {
    const d = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.push(new Float32Array(441)).length;
    expect(total).toBe(16000);
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
