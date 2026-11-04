import { createRequire } from "node:module";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { MIME } from "../mime";
import type { Fetch, SynthesisResult, SynthesizeOptions, TextToSpeech } from "../types";
import { encodeWav } from "../wav";
import { SPEECH_GATE_SOURCE } from "./gate";
import { CLEANUP_MODELS, installModel, isInstalled, LOCAL_MODELS, type LocalModel, type LocalModelName, modelPath } from "./models";
import { DEFAULT_VOICE_ID, findVoice, ttsModelConfig, type VoiceSpec, VOICES } from "./voices";

/** The chosen voice isn't downloaded yet (its download has been started). */
export class VoiceNotInstalledError extends Error {
  constructor(readonly voice: VoiceSpec) {
    super(`The ${voice.label} voice is still downloading (about ${voice.model.mb} MB)`);
  }
}

/** The parts of sherpa-onnx-node used here (it ships no types). */
export interface SherpaTts {
  sampleRate: number;
  generateAsync(request: { text: string; sid: number; speed: number; onProgress?: (info: { samples: Float32Array }) => number | boolean | void }): Promise<{
    samples: Float32Array;
    sampleRate: number;
  }>;
}
export interface Sherpa {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
}

/** What the recognition worker needs from a worker thread (a stand-in in tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: "message", listener: (message: AsrWorkerMessage) => void): unknown;
  on(event: "error" | "exit", listener: (arg: unknown) => void): unknown;
  terminate(): Promise<number> | void;
}

export type AsrWorkerMessage =
  | { type: "loaded"; ms: number }
  | { type: "failed"; message: string }
  | { type: "text"; id: number; text: string; endpoint: boolean }
  | { type: "final"; id: number; text: string }
  | { type: "log"; message: string };

export type LocalStatus = "missing" | "installing" | "ready" | "failed";

export interface LocalSpeechOptions {
  /** Where models are kept, e.g. $DATA_DIR/models/voice. */
  root: string;
  /**
   * The default voice: an id from VOICES ("piper:cori"), or a bare Piper or Kokoro voice name
   * read in the family `engine` names. Others can be chosen per request (and download then).
   */
  voice?: string;
  /** "piper" (default: fast) or "kokoro" (more natural, slower): the family of a bare `voice` name and of the default. */
  engine?: "piper" | "kokoro";
  /** Voice models kept loaded at once (default 2); the least recently used one is dropped. */
  maxLoadedVoices?: number;
  /** 0.7–1.3, default 1. */
  speed?: number;
  /** Engines unload after this long unused (default 10 minutes), so idle RAM costs nothing. */
  idleMs?: number;
  threads?: number;
  fetch?: Fetch;
  /** For tests: a stand-in for sherpa-onnx-node (the voice). */
  sherpa?: () => Sherpa;
  /**
   * Neural denoising (GTCRN) before recognition. Off by default: on test recordings it made
   * recognition worse under rustling, while the voice detector alone (always on) didn't.
   */
  denoise?: boolean;
  /** For tests: a stand-in for the recognition worker thread. */
  worker?: (data: { config: unknown }) => WorkerLike;
  log?: (line: string) => void;
}

/** One live recognition: feed 16 kHz audio; the text so far arrives through `onText`. */
export interface LocalAsrStream {
  accept(samples: Float32Array): void;
  /** Ends the audio; resolves with the final text. */
  finish(): Promise<string>;
  /** Drops the stream without a result. */
  close(): void;
}

export interface AsrUpdate {
  /** Everything heard so far (finished phrases plus the current one). */
  text: string;
  /** True when a pause just ended a phrase. */
  endpoint: boolean;
}

/**
 * The recognizer runs in a worker thread: loading it takes seconds of CPU, and decoding stays
 * off the server's event loop. Plain CommonJS, evaluated as the worker's source.
 */
const ASR_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
${SPEECH_GATE_SOURCE}
const started = Date.now();
let rec;
let so;
try {
  so = require(workerData.sherpa);
  rec = new so.OnlineRecognizer(workerData.config);
  parentPort.postMessage({ type: "loaded", ms: Date.now() - started });
} catch (err) {
  parentPort.postMessage({ type: "failed", message: String(err && err.message || err) });
}
// Clean-up per stream (both optional): the denoiser (off unless VOICE_DENOISE=on), then the voice
// detector, which lets only speech through to the recogniser.
const cleanup = workerData.cleanup || {};
const newDenoiser = () => {
  if (!cleanup.denoise) return null;
  try {
    return new so.OnlineSpeechDenoiser({ model: { gtcrn: { model: cleanup.denoise }, numThreads: 1 } });
  } catch (err) {
    parentPort.postMessage({ type: "log", message: "denoiser unavailable: " + (err && err.message || err) });
    cleanup.denoise = null;
    return null;
  }
};
const newVad = () => {
  if (!cleanup.vad) return null;
  try {
    return new so.Vad({ sileroVad: { model: cleanup.vad, threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 30 }, sampleRate: 16000, numThreads: 1 }, 30);
  } catch (err) {
    parentPort.postMessage({ type: "log", message: "voice detector unavailable: " + (err && err.message || err) });
    cleanup.vad = null;
    return null;
  }
};
const clean = (st, samples) => {
  let out = samples;
  if (st.denoiser) out = st.denoiser.run({ samples: out, sampleRate: 16000 }).samples;
  if (!st.vad || !out.length) return out;
  st.vad.acceptWaveform(out);
  const speaking = st.vad.isDetected();
  while (!st.vad.isEmpty()) st.vad.pop();
  return st.gate.push(out, speaking);
};
const streams = new Map();
const join = (st) => (st.committed + " " + st.current).replace(/\\s+/g, " ").trim();
const decode = (st) => { while (rec.isReady(st.s)) rec.decode(st.s); st.current = rec.getResult(st.s).text.trim(); };
parentPort.on("message", (m) => {
  if (!rec) return;
  if (m.type === "open") streams.set(m.id, { s: rec.createStream(), committed: "", current: "", denoiser: newDenoiser(), vad: newVad(), gate: new SpeechGate() });
  else if (m.type === "audio") {
    const st = streams.get(m.id);
    if (!st) return;
    const samples = clean(st, m.samples);
    if (!samples.length) return;
    st.s.acceptWaveform({ samples, sampleRate: 16000 });
    decode(st);
    let endpoint = false;
    if (rec.isEndpoint(st.s)) {
      endpoint = st.current.length > 0;
      st.committed = join(st);
      st.current = "";
      rec.reset(st.s);
    }
    parentPort.postMessage({ type: "text", id: m.id, text: join(st), endpoint });
  } else if (m.type === "finish") {
    const st = streams.get(m.id);
    if (!st) return parentPort.postMessage({ type: "final", id: m.id, text: "" });
    if (st.denoiser) {
      const rest = st.denoiser.flush().samples;
      if (rest.length) st.s.acceptWaveform({ samples: st.vad && !st.gate.open ? new Float32Array(rest.length) : rest, sampleRate: 16000 });
    }
    st.s.acceptWaveform({ samples: new Float32Array(4800), sampleRate: 16000 });
    st.s.inputFinished();
    decode(st);
    streams.delete(m.id);
    parentPort.postMessage({ type: "final", id: m.id, text: join(st) });
  } else if (m.type === "close") streams.delete(m.id);
});
`;

/**
 * Self-hosted speech with open models (sherpa-onnx, CPU): streaming recognition and the Kokoro
 * voice. Models download once into `root`; engines load on first use and unload when idle.
 */
export class LocalSpeech {
  readonly status: Record<LocalModelName, LocalStatus>;
  private worker: { w: WorkerLike; loaded: Promise<void> } | null = null;
  private readonly streams = new Map<number, { onText: (u: AsrUpdate) => void; final?: (text: string) => void }>();
  private nextId = 1;
  /** Loaded voice models by model folder, least recently used first. */
  private readonly loaded = new Map<string, Promise<SherpaTts>>();
  private readonly voiceInstalls = new Map<string, Promise<void>>();
  private readonly voiceFailures = new Map<string, string>();
  private ttsChain: Promise<unknown> = Promise.resolve();
  private readonly idle: Partial<Record<LocalModelName, ReturnType<typeof setTimeout>>> = {};
  private sherpaModule: Sherpa | null = null;
  private installing: Promise<void> | null = null;
  /** The default voice (used when a request names none, or one that isn't downloaded yet). */
  readonly defaultVoice: VoiceSpec;

  constructor(private readonly options: LocalSpeechOptions) {
    const family = options.engine ?? "piper";
    this.defaultVoice = findVoice(options.voice, family) ?? findVoice(family === "kokoro" ? "kokoro:bf_emma" : DEFAULT_VOICE_ID)!;
    this.status = {
      asr: isInstalled(options.root, LOCAL_MODELS.asr) ? "ready" : "missing",
      tts: isInstalled(options.root, this.defaultVoice.model) ? "ready" : "missing",
    };
  }

  /** The default voice's id, e.g. "piper:cori". */
  get voice(): string {
    return this.defaultVoice.id;
  }

  /** The default voice's model. */
  get ttsModel(): LocalModel {
    return this.defaultVoice.model;
  }

  /** Every voice that can be chosen, with whether it's downloaded. */
  voices(): (VoiceSpec & { status: LocalStatus; error?: string; isDefault: boolean })[] {
    return VOICES.map((v) => ({
      ...v,
      status: this.voiceStatus(v),
      error: this.voiceFailures.get(v.model.dir),
      isDefault: v.id === this.defaultVoice.id,
    }));
  }

  private voiceStatus(v: VoiceSpec): LocalStatus {
    if (isInstalled(this.options.root, v.model)) return "ready";
    if (this.voiceInstalls.has(v.model.dir)) return "installing";
    return this.voiceFailures.has(v.model.dir) ? "failed" : "missing";
  }

  /** Downloads a voice's model (once; voices sharing a model share the download). */
  installVoice(id: string): Promise<void> {
    const v = findVoice(id);
    if (!v) return Promise.reject(new Error(`There is no voice "${id}"`));
    if (isInstalled(this.options.root, v.model)) return Promise.resolve();
    const dir = v.model.dir;
    const running = this.voiceInstalls.get(dir);
    if (running) return running;
    const started = Date.now();
    this.log(`downloading ${dir} (about ${v.model.mb} MB) for the ${v.label} voice`);
    this.voiceFailures.delete(dir);
    const job = installModel(this.options.root, v.model, this.options.fetch)
      .then(() => {
        this.log(`${dir} ready in ${Math.round((Date.now() - started) / 1000)} s`);
        if (v.model.dir === this.defaultVoice.model.dir) this.status.tts = "ready";
      })
      .catch((err) => {
        this.voiceFailures.set(dir, (err as Error).message);
        this.log(`${dir} failed: ${(err as Error).message}`);
        throw err;
      })
      .finally(() => this.voiceInstalls.delete(dir));
    this.voiceInstalls.set(dir, job);
    return job;
  }

  get asrReady() {
    return this.status.asr === "ready";
  }
  get ttsReady() {
    return this.status.tts === "ready";
  }

  /** Downloads whatever is missing (recognition first: it is small). Safe to call repeatedly. */
  install(): Promise<void> {
    this.installing ??= (async () => {
      for (const name of ["asr", "denoise", "vad", "tts"] as const) {
        if (name === "denoise" && !this.options.denoise) continue;
        if (name === "denoise" || name === "vad") {
          // Small and optional: without them recognition still works, just without clean-up.
          const model = CLEANUP_MODELS[name];
          if (isInstalled(this.options.root, model)) continue;
          await installModel(this.options.root, model, this.options.fetch)
            .then(() => this.log(`${model.dir} ready`))
            .catch((err) => this.log(`${model.dir} failed: ${(err as Error).message}`));
          continue;
        }
        if (this.status[name] === "ready") continue;
        if (name === "tts") {
          this.status.tts = "installing";
          await this.installVoice(this.defaultVoice.id).then(
            () => (this.status.tts = "ready"),
            () => (this.status.tts = "failed"),
          );
          continue;
        }
        const model = LOCAL_MODELS[name];
        this.status[name] = "installing";
        const started = Date.now();
        this.log(`downloading ${model.dir} (about ${model.mb} MB)`);
        try {
          await installModel(this.options.root, model, this.options.fetch);
          this.status[name] = "ready";
          this.log(`${model.dir} ready in ${Math.round((Date.now() - started) / 1000)} s`);
        } catch (err) {
          this.status[name] = "failed";
          this.log(`${model.dir} failed: ${(err as Error).message}`);
        }
      }
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  /** Loads the engines ahead of use (e.g. when Drive mode opens), so the first word isn't delayed. */
  async warm(which: LocalModelName[] = ["asr", "tts"]): Promise<void> {
    if (which.includes("asr") && this.asrReady) await this.asr().loaded.catch(() => {});
    if (which.includes("tts") && this.ttsReady) await this.loadVoice(this.defaultVoice).catch(() => {});
  }

  /**
   * Opens a live recognition. Audio sent before the recognizer has loaded is queued by the
   * worker, so nothing is lost on a cold start.
   */
  openStream(onText: (update: AsrUpdate) => void): LocalAsrStream {
    const { w } = this.asr();
    const id = this.nextId++;
    const entry: { onText: (u: AsrUpdate) => void; final?: (text: string) => void } = { onText };
    this.streams.set(id, entry);
    w.postMessage({ type: "open", id });
    let closed = false;
    return {
      accept: (samples) => {
        if (closed) return;
        this.touch("asr");
        w.postMessage({ type: "audio", id, samples }, [samples.buffer as ArrayBuffer]);
      },
      finish: () => {
        if (closed) return Promise.resolve("");
        closed = true;
        return new Promise<string>((resolve) => {
          const guard = setTimeout(() => resolve(""), 15_000);
          entry.final = (text) => {
            clearTimeout(guard);
            this.streams.delete(id);
            resolve(text);
          };
          w.postMessage({ type: "finish", id });
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.streams.delete(id);
        w.postMessage({ type: "close", id });
      },
    };
  }

  /**
   * Synthesizes one piece of speech in `voice` (an id from VOICES; default: the default voice).
   * A voice that isn't downloaded yet starts downloading; meanwhile the default voice speaks,
   * unless `fallback` is false, when VoiceNotInstalledError is thrown (a preview). Calls are
   * queued: one at a time.
   */
  synthesize(text: string, opts: { voice?: string; speed?: number; fallback?: boolean } = {}): Promise<{ samples: Float32Array; sampleRate: number; voice: string }> {
    let spec = findVoice(opts.voice) ?? this.defaultVoice;
    if (!isInstalled(this.options.root, spec.model)) {
      void this.installVoice(spec.id).catch(() => {});
      if (opts.fallback === false) return Promise.reject(new VoiceNotInstalledError(spec));
      spec = this.defaultVoice;
    }
    const voice = spec;
    const speed = Math.min(1.3, Math.max(0.7, opts.speed ?? this.options.speed ?? 1));
    const run = this.ttsChain.then(async () => {
      const tts = await this.loadVoice(voice);
      this.touch("tts");
      const audio = await tts.generateAsync({ text, sid: voice.speaker ?? 0, speed });
      this.touch("tts");
      return { ...audio, voice: voice.id };
    });
    this.ttsChain = run.catch(() => {});
    return run;
  }

  private asr(): { w: WorkerLike; loaded: Promise<void> } {
    if (!this.asrReady) throw new Error("speech recognition models aren't installed yet");
    this.touch("asr");
    if (this.worker) return this.worker;
    const m = LOCAL_MODELS.asr;
    const root = this.options.root;
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: modelPath(root, m, "encoder.onnx"), decoder: modelPath(root, m, "decoder.onnx"), joiner: modelPath(root, m, "joiner.onnx") },
        tokens: modelPath(root, m, "tokens.txt"),
        numThreads: Math.min(2, this.threads()),
      },
      decodingMethod: "greedy_search",
      enableEndpoint: 1,
      // Rule 2: a pause this long after speech ends a phrase (and the turn, when not latched).
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 60,
    };
    const w: WorkerLike =
      this.options.worker?.({ config }) ??
      (new Worker(ASR_WORKER, { eval: true, workerData: { config, cleanup: this.cleanupPaths(), sherpa: createRequire(import.meta.url).resolve("sherpa-onnx-node") } }) as unknown as WorkerLike);
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const loaded = new Promise<void>((res, rej) => {
      ready = res;
      failed = rej;
    });
    loaded.catch(() => {});
    const current = { w, loaded };
    w.on("message", (msg: AsrWorkerMessage) => {
      if (msg.type === "loaded") {
        this.log(`recognizer loaded in ${msg.ms} ms`);
        ready();
      } else if (msg.type === "failed") {
        this.log(`recognizer failed to load: ${msg.message}`);
        failed(new Error(msg.message));
        this.dropWorker(current);
      } else if (msg.type === "log") this.log(msg.message);
      else if (msg.type === "text") this.streams.get(msg.id)?.onText({ text: msg.text, endpoint: msg.endpoint });
      else if (msg.type === "final") this.streams.get(msg.id)?.final?.(msg.text);
    });
    w.on("error", (err) => {
      this.log(`recognizer crashed: ${(err as Error)?.message ?? err}`);
      this.dropWorker(current);
    });
    w.on("exit", () => this.dropWorker(current));
    this.worker = current;
    return current;
  }

  /** The clean-up models that are installed (a new recognizer worker picks up any downloaded since). */
  private cleanupPaths(): { denoise: string | null; vad: string | null } {
    const root = this.options.root;
    const path = (m: (typeof CLEANUP_MODELS)[keyof typeof CLEANUP_MODELS]) => (isInstalled(root, m) ? modelPath(root, m, m.files[0]) : null);
    return { denoise: this.options.denoise ? path(CLEANUP_MODELS.denoise) : null, vad: path(CLEANUP_MODELS.vad) };
  }

  private dropWorker(which: { w: WorkerLike }) {
    if (this.worker !== which) return;
    this.worker = null;
    void which.w.terminate();
    for (const [, s] of this.streams) s.final?.("");
    this.streams.clear();
  }

  private loadVoice(voice: VoiceSpec): Promise<SherpaTts> {
    if (!isInstalled(this.options.root, voice.model)) return Promise.reject(new VoiceNotInstalledError(voice));
    this.touch("tts");
    const key = voice.model.dir;
    const hit = this.loaded.get(key);
    if (hit) {
      // Most recently used goes last.
      this.loaded.delete(key);
      this.loaded.set(key, hit);
      return hit;
    }
    const started = Date.now();
    const tts = this.sherpa()
      .OfflineTts.createAsync({
        model: { ...ttsModelConfig(voice, this.options.root), numThreads: Math.min(4, this.threads()) },
        maxNumSentences: 1,
      })
      .then((t) => {
        this.log(`voice ${key} loaded in ${Date.now() - started} ms (${rssMb()} MB resident)`);
        return t;
      });
    tts.catch(() => this.loaded.delete(key));
    this.loaded.set(key, tts);
    // Keep memory bounded: drop the least recently used voice beyond the limit.
    while (this.loaded.size > (this.options.maxLoadedVoices ?? 2)) this.loaded.delete(this.loaded.keys().next().value!);
    return tts;
  }

  private sherpa(): Sherpa {
    this.sherpaModule ??= this.options.sherpa?.() ?? (createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa);
    return this.sherpaModule;
  }

  private threads() {
    return this.options.threads ?? Math.max(1, cpus().length);
  }

  /** Resets the idle timer; an idle engine is dropped so its memory is freed. */
  private touch(name: LocalModelName) {
    clearTimeout(this.idle[name]);
    const t = setTimeout(() => {
      if (name === "asr") {
        if (this.streams.size) return this.touch("asr");
        if (this.worker) this.dropWorker(this.worker);
      } else this.loaded.clear();
      this.log(`${name === "asr" ? "recognizer" : "voice"} unloaded after idling`);
    }, this.options.idleMs ?? 10 * 60_000);
    t.unref?.();
    this.idle[name] = t;
  }

  private log(line: string) {
    (this.options.log ?? ((l) => console.log(`[voice] ${l}`)))(line);
  }
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1e6);
}

/** The self-hosted voices behind the provider-neutral TextToSpeech contract (WAV out). */
export class LocalTextToSpeech implements TextToSpeech {
  readonly provider = "local";
  constructor(private readonly speech: LocalSpeech) {}

  get model() {
    return this.speech.ttsModel.dir;
  }

  /** The default voice's id, e.g. "piper:cori". */
  get defaultVoice() {
    return this.speech.voice;
  }

  /** `opts.voice`: a voice id; one not downloaded yet falls back to the default (and starts downloading). */
  async synthesize(text: string, opts: SynthesizeOptions & { fallback?: boolean } = {}): Promise<SynthesisResult> {
    const { samples, sampleRate, voice } = await this.speech.synthesize(text, { voice: opts.voice, speed: opts.speed, fallback: opts.fallback });
    return { audio: encodeWav(samples, sampleRate), mime: MIME.wav, voice };
  }
}
