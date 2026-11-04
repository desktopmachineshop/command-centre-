import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeWav, int16ToFloat, SentenceAssembler, speechPieces } from "../src/index";
import { type AsrWorkerMessage, CLEANUP_MODELS, installModel, isInstalled, KOKORO_VOICES, LOCAL_MODELS, LocalSpeech, LocalTextToSpeech, SpeechGate, type WorkerLike } from "../src/local/index";

describe("wav", () => {
  it("encodes 16-bit mono PCM with a valid header, and decodes it back", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 1]), 24000);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint32(40, true)).toBe(8);
    const back = int16ToFloat(wav.slice(44));
    expect(back[0]).toBe(0);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBe(-1);
    expect(back[3]).toBeCloseTo(1, 3);
  });
});

describe("SentenceAssembler", () => {
  it("emits each sentence as soon as it's complete, across deltas", () => {
    const a = new SentenceAssembler();
    expect(a.push("Sure. I'll ")).toEqual(["Sure."]);
    expect(a.push("check that now. Then")).toEqual(["I'll check that now."]);
    expect(a.push(" I'll tell you")).toEqual([]);
    expect(a.flush()).toEqual(["Then I'll tell you"]);
  });

  it("lets the first piece end at a clause once it's long enough, and doesn't split at e.g. or initials", () => {
    expect(speechPieces("Order ten forty-two shipped yesterday, and it should arrive by Thursday.")).toEqual([
      "Order ten forty-two shipped yesterday,",
      "and it should arrive by Thursday.",
    ]);
    expect(speechPieces("Yes, it did. Then, later, it came back.")).toEqual(["Yes, it did.", "Then, later, it came back."]);
    expect(speechPieces("Ask J. Smith, e.g. about stock. Done.")).toEqual(["Ask J. Smith, e.g. about stock.", "Done."]);
  });

  it("splits a very long run-on piece between words and loses nothing", () => {
    const long = "word ".repeat(120).trim();
    const pieces = speechPieces(long, { maxChars: 100 });
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100);
    expect(pieces.join(" ")).toBe(long);
  });
});

/** A stand-in recognition worker: "hears" one word per audio frame, and a pause on a silent frame. */
function fakeWorker(): WorkerLike {
  const handlers: Record<string, ((m: any) => void)[]> = {};
  const emit = (m: AsrWorkerMessage) => queueMicrotask(() => handlers.message?.forEach((h) => h(m)));
  const streams = new Map<number, { committed: string[]; current: string[] }>();
  const join = (s: { committed: string[]; current: string[] }) => [...s.committed, ...s.current].join(" ");
  queueMicrotask(() => emit({ type: "loaded", ms: 1 }));
  return {
    on(event: string, h: (m: any) => void) {
      (handlers[event] ??= []).push(h);
      return this;
    },
    postMessage(m: any) {
      if (m.type === "open") streams.set(m.id, { committed: [], current: [] });
      if (m.type === "audio") {
        const s = streams.get(m.id)!;
        const silent = (m.samples as Float32Array).every((x) => x === 0);
        if (silent && s.current.length) {
          s.committed.push(...s.current);
          s.current = [];
          emit({ type: "text", id: m.id, text: join(s), endpoint: true });
        } else if (!silent) {
          s.current.push(`w${s.committed.length + s.current.length + 1}`);
          emit({ type: "text", id: m.id, text: join(s), endpoint: false });
        }
      }
      if (m.type === "finish") emit({ type: "final", id: m.id, text: join(streams.get(m.id)!) });
    },
    terminate() {},
  } as WorkerLike;
}

function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-voice-"));
  for (const model of Object.values(LOCAL_MODELS)) {
    for (const f of model.files) {
      const path = join(root, model.dir, f);
      if (f.includes(".")) {
        mkdirSync(join(root, model.dir), { recursive: true });
        writeFileSync(path, "");
      } else mkdirSync(path, { recursive: true });
    }
  }
  return root;
}

describe("LocalSpeech", () => {
  it("reports models missing until they're installed", () => {
    const empty = mkdtempSync(join(tmpdir(), "cc-voice-"));
    const speech = new LocalSpeech({ root: empty, log: () => {} });
    expect(speech.status).toEqual({ asr: "missing", tts: "missing" });
    expect(() => speech.openStream(() => {})).toThrow(/aren't installed/);
    const root = installedRoot();
    expect(isInstalled(root, LOCAL_MODELS.asr)).toBe(true);
    expect(new LocalSpeech({ root, log: () => {} }).status).toEqual({ asr: "ready", tts: "ready" });
  });

  it("streams text from the recognition worker, marks pauses, and finishes with the full text", async () => {
    const speech = new LocalSpeech({ root: installedRoot(), worker: fakeWorker, log: () => {} });
    const updates: { text: string; endpoint: boolean }[] = [];
    const stream = speech.openStream((u) => updates.push(u));
    stream.accept(new Float32Array([0.1]));
    stream.accept(new Float32Array([0.1]));
    stream.accept(new Float32Array([0]));
    stream.accept(new Float32Array([0.1]));
    expect(await stream.finish()).toBe("w1 w2 w3");
    expect(updates).toEqual([
      { text: "w1", endpoint: false },
      { text: "w1 w2", endpoint: false },
      { text: "w1 w2", endpoint: true },
      { text: "w1 w2 w3", endpoint: false },
    ]);
  });

  it("speaks with the chosen Kokoro voice, queued one at a time, as WAV", async () => {
    const calls: { text: string; sid: number; speed: number }[] = [];
    let active = 0;
    let maxActive = 0;
    const sherpa = () => ({
      OfflineTts: {
        createAsync: async () => ({
          sampleRate: 24000,
          generateAsync: async (r: { text: string; sid: number; speed: number }) => {
            active++;
            maxActive = Math.max(maxActive, active);
            calls.push(r);
            await new Promise((res) => setTimeout(res, 5));
            active--;
            return { samples: new Float32Array(10), sampleRate: 24000 };
          },
        }),
      },
    });
    const speech = new LocalSpeech({ root: installedRoot(), voice: "bm_george", speed: 2, sherpa, log: () => {} });
    const tts = new LocalTextToSpeech(speech);
    expect(tts.defaultVoice).toBe("bm_george");
    const [a] = await Promise.all([tts.synthesize("One."), tts.synthesize("Two.", { voice: "bf_emma" })]);
    expect(a.mime).toBe("audio/wav");
    expect(a.audio.byteLength).toBe(44 + 20);
    expect(maxActive).toBe(1);
    expect(calls).toEqual([
      { text: "One.", sid: KOKORO_VOICES.bm_george, speed: 1.3 },
      { text: "Two.", sid: KOKORO_VOICES.bf_emma, speed: 1.3 },
    ]);
  });
});

describe("SpeechGate", () => {
  const frame = (v: number, n = 1600) => new Float32Array(n).fill(v);

  it("passes silence in place of non-speech, then speech with the audio just before it", () => {
    const gate = new SpeechGate(3200, 1600);
    expect([...gate.push(frame(0.3), false)].every((x) => x === 0)).toBe(true);
    expect([...gate.push(frame(0.4), false)].every((x) => x === 0)).toBe(true);
    const start = gate.push(frame(0.5), true);
    // The preroll (the last 3200 samples before detection) comes first, so no syllable is lost.
    expect(start.length).toBe(3200 + 1600);
    expect(start[0]).toBeCloseTo(0.3);
    expect(start[1600]).toBeCloseTo(0.4);
    expect(start[3200]).toBeCloseTo(0.5);
    expect(gate.open).toBe(true);
  });

  it("keeps a short hangover after speech, then closes", () => {
    const gate = new SpeechGate(0, 1600);
    gate.push(frame(0.5), true);
    expect(gate.push(frame(0.2), false)[0]).toBeCloseTo(0.2); // within the hangover
    expect(gate.push(frame(0.2), false)[0]).toBe(0); // past it
    expect(gate.open).toBe(false);
  });
});

describe("clean-up models", () => {
  it("installs a single-file model, without tar", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-voice-"));
    const fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof globalThis.fetch;
    await installModel(root, CLEANUP_MODELS.vad, fetch);
    expect(isInstalled(root, CLEANUP_MODELS.vad)).toBe(true);
  });

  it("passes the voice detector to the recogniser always, and the denoiser only when asked", () => {
    const root = installedRoot();
    for (const m of Object.values(CLEANUP_MODELS)) {
      mkdirSync(join(root, m.dir), { recursive: true });
      writeFileSync(join(root, m.dir, m.files[0]!), "");
    }
    const paths = (denoise: boolean) => (new LocalSpeech({ root, denoise, log: () => {} }) as unknown as { cleanupPaths(): { denoise: string | null; vad: string | null } }).cleanupPaths();
    expect(paths(false).denoise).toBeNull();
    expect(paths(false).vad).toMatch(/silero_vad\.onnx$/);
    expect(paths(true).denoise).toMatch(/gtcrn_simple\.onnx$/);
  });
});
