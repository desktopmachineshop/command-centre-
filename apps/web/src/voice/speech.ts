/**
 * Browser speech plumbing for Drive mode: listening (Web Speech API, or
 * MediaRecorder + server transcription), speaking (speechSynthesis, or server
 * TTS), earcons, screen wake lock and the headset button (MediaSession).
 * Every piece degrades: a missing API reports itself rather than throwing.
 */

import { AnalyserLevel, type LevelSource, PulseLevel, SILENT, speechThreshold, updateNoiseFloor } from "./level";

export class VoicePermissionError extends Error {}

// ---------- Listening ----------

export interface ListenOptions {
  lang: string;
  /** Give up after this long without hearing speech. */
  timeoutMs: number;
  /** Called with partial transcripts while Dave speaks. */
  onInterim?: (text: string) => void;
  /** Silence after speech that ends Dave's turn (default 2.5 s). */
  endOfTurnMs?: number;
  /** Longest a turn can last, so background chatter can't keep it open (default 60 s; Send ends it any time). */
  maxTurnMs?: number;
  /**
   * Push to talk, latched: pauses don't end the turn; only Send (`stop()`) or `maxTurnMs` does,
   * so a long message can be dictated with breaks to think.
   */
  latched?: boolean;
}

export interface Listener {
  readonly kind: "browser" | "server" | "live";
  /** The microphone level while listening, for the waveform (0..1 per animation frame). */
  readonly level: LevelSource;
  /** The transcript, or null when nothing was said. */
  listen(options: ListenOptions): Promise<string | null>;
  /** Stops listening now; a pending listen() resolves with what was heard so far. */
  stop(): void;
  /** Releases anything kept open between turns (a warm microphone). */
  close?(): void;
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
};

function recognitionCtor(): (new () => Recognition) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** iOS home-screen apps expose SpeechRecognition but it has historically done nothing there. */
export function isIosStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && (nav.standalone === true || matchMedia?.("(display-mode: standalone)").matches);
}

export function hasBrowserRecognition(): boolean {
  return recognitionCtor() !== null;
}

/** Microphone capture with Web Audio, what live transcription streams from. */
export function hasLiveCapture(): boolean {
  return typeof AudioContext !== "undefined" && typeof WebSocket !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function hasRecorder(): boolean {
  return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Folds recognition results that repeat the one before: Chrome on Android, listening
 * continuously, can send "draft", "draft a", "draft a note" as separate results, which would
 * otherwise read "draft draft a draft a note". A result whose words start with the previous
 * result's words replaces it; one that only repeats the start of the previous result is dropped.
 * Pure.
 */
export function collapseRepeats(parts: string[]): string[] {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, "").split(/\s+/).filter(Boolean);
  const startsWith = (a: string[], b: string[]) => b.length > 0 && b.length <= a.length && b.every((w, i) => a[i] === w);
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && startsWith(words(part), words(prev))) out[out.length - 1] = part;
    else if (prev !== undefined && startsWith(words(prev), words(part))) continue;
    else out.push(part);
  }
  return out;
}

/** Web Speech API recognition: one utterance per listen(). */
export class BrowserListener implements Listener {
  readonly kind = "browser";
  private current: Recognition | null = null;
  private readonly pulse = new PulseLevel();
  private meter: MicMeter | null = null;

  /** The real microphone level where a second capture is safe; elsewhere, animated from recognition events. */
  get level(): LevelSource {
    return this.meter?.level ?? this.pulse;
  }

  /**
   * Listens until Dave pauses for `endOfTurnMs` after speaking (or Send calls `stop()`), so a
   * short pause mid-sentence doesn't send half an answer. Gives up after `timeoutMs` if he says
   * nothing. Android may end a continuous session by itself; before any speech it is restarted.
   */
  listen({ lang, timeoutMs, onInterim, endOfTurnMs = 2500, maxTurnMs = 60_000, latched = false }: ListenOptions): Promise<string | null> {
    const Ctor = recognitionCtor();
    if (!Ctor) return Promise.reject(new Error("Speech recognition isn't available in this browser"));
    this.stop();
    return new Promise((resolve, reject) => {
      // What earlier recognition sessions heard, and the current session's text.
      let committed = "";
      let current = "";
      let heard = false;
      let settled = false;
      let stopping = false;
      let rec: Recognition;
      let endTimer: ReturnType<typeof setTimeout> | undefined;
      const text = () => `${committed} ${current}`.replace(/\s+/g, " ").trim();
      const finish = (value: string | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(endTimer);
        clearTimeout(cap);
        if (this.current === rec) this.current = null;
        this.stopTurn = null;
        this.pulse.active = false;
        this.meter?.close();
        this.meter = null;
        try {
          rec.abort();
        } catch {
          // already ended
        }
        if (error) reject(error);
        else resolve(value?.trim() ? value.trim() : null);
      };
      const timer = setTimeout(() => {
        if (!heard) finish(null);
      }, timeoutMs);
      const cap = setTimeout(() => finish(text() || null), maxTurnMs);
      const armEnd = () => {
        if (latched) return; // only Send or the cap ends a latched turn
        clearTimeout(endTimer);
        endTimer = setTimeout(() => finish(text() || null), endOfTurnMs);
      };
      // Send: end the turn now with what was heard.
      this.stopTurn = () => {
        stopping = true;
        finish(text() || null);
      };
      const start = () => {
        committed = text();
        current = "";
        rec = new Ctor();
        this.current = rec;
        rec.lang = lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onspeechstart = () => {
          heard = true;
          this.pulse.pulse(0.6);
        };
        rec.onresult = (e) => {
          heard = true;
          this.pulse.pulse(0.9);
          // Rebuilt from the whole session each time: Android sends each word as a new result
          // repeating the sentence so far, which collapseRepeats folds back into one.
          const parts: string[] = [];
          for (let i = 0; i < e.results.length; i++) parts.push(e.results[i]![0]!.transcript);
          current = collapseRepeats(parts).join(" ");
          onInterim?.(text());
          armEnd();
        };
        rec.onerror = (e) => {
          if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            finish(null, new VoicePermissionError("Microphone or speech recognition permission was refused"));
          } else if (e.error === "network") finish(null, new Error("Speech recognition needs a network connection"));
          else if (e.error !== "no-speech" && e.error !== "aborted") finish(null, new Error(`Speech recognition failed (${e.error})`));
        };
        rec.onend = () => {
          if (settled || stopping) return;
          // The engine stopped by itself: after speech, that's the end of the turn (unless latched,
          // which keeps listening until Send); before any, keep listening until the timeout.
          if (heard && !latched) finish(text() || null);
          else {
            try {
              start();
            } catch (err) {
              finish(null, err as Error);
            }
          }
        };
        rec.start();
      };
      try {
        start();
        this.pulse.active = true;
        // Android Chrome's recognition loses the microphone to a second capture; elsewhere, meter it.
        if (!/Android/i.test(navigator.userAgent)) {
          void MicMeter.open().then((m) => {
            if (settled) m?.close();
            else this.meter = m;
          });
        }
      } catch (err) {
        finish(null, err as Error);
      }
    });
  }

  private stopTurn: (() => void) | null = null;

  stop() {
    if (this.stopTurn) this.stopTurn();
    else this.current?.stop();
  }
}

/**
 * Records with MediaRecorder until Dave stops talking (simple level-based
 * end-pointing), then sends the clip to the server for transcription.
 */
export class RecorderListener implements Listener {
  readonly kind = "server";
  level: LevelSource = SILENT;
  private stopNow: (() => void) | null = null;

  constructor(
    private readonly transcribe: (audio: Blob, seconds: number, lang: string) => Promise<string>,
    private readonly maxSeconds = 30,
  ) {}

  /**
   * Records until Dave pauses (or Send), then transcribes on the server. Latched, it ignores
   * pauses and records in segments no longer than the server accepts, transcribing each, until
   * Send or `maxTurnMs`.
   */
  async listen(options: ListenOptions): Promise<string | null> {
    this.stopped = false;
    if (!options.latched) return this.segment(options);
    const deadline = Date.now() + (options.maxTurnMs ?? 60_000);
    const parts: string[] = [];
    while (!this.stopped && Date.now() < deadline) {
      const text = await this.segment({ ...options, timeoutMs: deadline - Date.now() }, deadline);
      if (text) {
        parts.push(text);
        options.onInterim?.(parts.join(" "));
      }
    }
    return parts.join(" ").trim() || null;
  }

  private stopped = false;

  /** One recording, transcribed. */
  private async segment({ lang, timeoutMs, endOfTurnMs = 2500, latched = false }: ListenOptions, deadline = Infinity): Promise<string | null> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new VoicePermissionError("Microphone permission was refused");
      throw new Error(`No microphone available (${name})`);
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    // A high-pass cuts rumble and handling thumps before the mic is recorded or measured.
    const ctx = new AudioContext();
    const highpass = rumbleFilter(ctx);
    const clean = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(stream).connect(highpass).connect(clean);
    const recorder = new MediaRecorder(clean.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = Date.now();
    let heardAt = 0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    highpass.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const meter = ctx.createAnalyser();
    highpass.connect(meter);
    let noiseFloor = 0;
    this.level = new AnalyserLevel(meter);
    let quietSince = Date.now();

    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    const stop = () => recorder.state !== "inactive" && recorder.stop();
    this.stopNow = stop;
    recorder.start(250);

    const tick = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      const speech = rms > speechThreshold(noiseFloor);
      if (speech) {
        heardAt ||= now;
        quietSince = now;
      }
      // Tracked during "speech" too (more slowly), so steady noise louder than the starting
      // threshold (a car) is learnt as noise instead of keeping the turn open for ever.
      noiseFloor = updateNoiseFloor(noiseFloor, rms, speech);
      if (!heardAt && now - started > timeoutMs) stop();
      if (heardAt && !latched && now - quietSince > endOfTurnMs) stop();
      // A segment stays under what the server transcribes; a latched turn carries on in the next one.
      if (now - started > (this.maxSeconds - 1) * 1000 || now > deadline) stop();
    }, 100);

    await done;
    clearInterval(tick);
    this.stopNow = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    this.level = SILENT;
    if (!heardAt) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
    const text = await this.transcribe(blob, (Date.now() - started) / 1000, lang);
    return text.trim() || null;
  }

  stop() {
    this.stopped = true;
    this.stopNow?.();
  }
}

// ---------- Live (streaming) listening ----------

/** 120 Hz high-pass: rumble, wind and handling thumps go, speech (from about 150 Hz) stays. */
export function rumbleFilter(ctx: BaseAudioContext): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 120;
  f.Q.value = 0.707;
  return f;
}

const MIC_CONSTRAINTS: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

async function openMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new VoicePermissionError("Microphone permission was refused");
    throw new Error(`No microphone available (${name})`);
  }
}

/** A microphone opened only to measure its level (the browser-recognition fallback). */
class MicMeter {
  private constructor(
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    readonly level: LevelSource,
  ) {}

  static async open(): Promise<MicMeter | null> {
    try {
      const stream = await openMic();
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      return new MicMeter(stream, ctx, new AnalyserLevel(analyser));
    } catch {
      return null;
    }
  }

  close() {
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
  }
}

/**
 * Float audio at the device rate → 16 kHz 16-bit PCM, what the server's recognizer takes. A proper
 * low-pass first (a windowed-sinc FIR just under 8 kHz), then resampling, so sound above 8 kHz
 * doesn't fold back into the speech band as hiss and distortion (plain averaging let it through,
 * which costs recognition accuracy). Carries its history between calls so frames join seamlessly;
 * the last few samples (under 1 ms) wait for the next call. Pure apart from that state.
 */
export class Downsampler {
  private readonly ratio: number;
  private readonly taps: Float32Array;
  private readonly half: number;
  private buf: Float32Array;
  /** Where the next output sample falls in `buf` (fractional, in input samples). */
  private pos: number;

  constructor(inputRate: number, readonly outputRate = 16000) {
    this.ratio = inputRate / outputRate;
    // Cut-off at 0.45 of the output rate (7.2 kHz at 16 kHz), Blackman-windowed.
    const cutoff = (0.45 * outputRate) / inputRate;
    this.half = Math.max(4, Math.ceil(8 * this.ratio));
    const n = this.half * 2 + 1;
    const taps = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const k = i - this.half;
      const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
      taps[i] = sinc * w;
      sum += taps[i]!;
    }
    for (let i = 0; i < n; i++) taps[i]! /= sum; // unity gain for steady levels
    this.taps = taps;
    this.buf = new Float32Array(this.half); // silence before the first sample
    this.pos = this.half;
  }

  /** The low-passed input at sample `i` of `buf`. */
  private filtered(i: number): number {
    let acc = 0;
    for (let k = 0; k < this.taps.length; k++) acc += this.buf[i - this.half + k]! * this.taps[k]!;
    return acc;
  }

  push(input: Float32Array): Int16Array {
    const buf = new Float32Array(this.buf.length + input.length);
    buf.set(this.buf);
    buf.set(input, this.buf.length);
    this.buf = buf;
    const out: number[] = [];
    for (;;) {
      const i0 = Math.floor(this.pos);
      if (i0 + 1 + this.half >= buf.length) break;
      const frac = this.pos - i0;
      const a = this.filtered(i0);
      const v = Math.max(-1, Math.min(1, frac ? a + (this.filtered(i0 + 1) - a) * frac : a));
      out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
      this.pos += this.ratio;
    }
    const drop = Math.max(0, Math.floor(this.pos) - this.half);
    this.buf = buf.slice(drop);
    this.pos -= drop;
    return Int16Array.from(out);
  }
}

/** Forwards raw microphone frames to the page (AudioWorklet, registered from a Blob URL). */
const CAPTURE_WORKLET = `class CcCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("cc-capture", CcCapture);`;

/** Calls `onFrame` with the microphone's float samples; AudioWorklet where it exists, else ScriptProcessor. */
async function captureFrames(ctx: AudioContext, source: AudioNode, onFrame: (samples: Float32Array) => void): Promise<() => void> {
  const sink = ctx.createGain();
  sink.gain.value = 0; // processing nodes only run when connected towards the output
  sink.connect(ctx.destination);
  if (ctx.audioWorklet) {
    try {
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "cc-capture");
      node.port.onmessage = (e) => onFrame(e.data as Float32Array);
      source.connect(node).connect(sink);
      return () => {
        node.port.onmessage = null;
        node.disconnect();
      };
    } catch {
      // fall through to ScriptProcessor
    }
  }
  const node = ctx.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node).connect(sink);
  return () => {
    node.onaudioprocess = null;
    node.disconnect();
  };
}

/** How much of the moments before a turn starts goes in with it (a word begun on the tone). */
const PREROLL_SAMPLES = 16000 * 0.4;

/**
 * The microphone, running: filtered for rumble, metered for the orb, and turned into 16 kHz PCM,
 * with the last second kept so a turn can start a little before it was asked to. Opening one
 * takes a few hundred milliseconds on a real device (more with a Bluetooth headset), and whatever
 * is said meanwhile is lost: so Converse keeps one open between turns (StreamingListener `warm`).
 */
class MicSession {
  /** Where the PCM goes while a turn is listening; null between turns. */
  sink: ((pcm: Int16Array) => void) | null = null;
  private history = new Int16Array(16000);
  private filled = 0;
  private closed = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    readonly analyser: AnalyserNode,
    private stopCapture: () => void,
  ) {}

  static async open(): Promise<MicSession> {
    const stream = await openMic();
    const ctx = new AudioContext();
    void ctx.resume?.();
    // Rumble and thumps are filtered before both the waveform and what goes to the server, which
    // then keeps everything but speech from the recogniser (its voice detector).
    const source = rumbleFilter(ctx);
    ctx.createMediaStreamSource(stream).connect(source);
    const analyser = ctx.createAnalyser();
    source.connect(analyser);
    const down = new Downsampler(ctx.sampleRate);
    let session: MicSession | null = null;
    const stopCapture = await captureFrames(ctx, source, (frame) => session?.take(down.push(frame))).catch((err) => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
      throw err;
    });
    session = new MicSession(stream, ctx, analyser, stopCapture);
    return session;
  }

  private take(pcm: Int16Array) {
    if (!pcm.length) return;
    // Keep the last second: shift and append (frames are a few dozen samples).
    const h = this.history;
    if (pcm.length >= h.length) h.set(pcm.subarray(pcm.length - h.length));
    else {
      h.copyWithin(0, pcm.length);
      h.set(pcm, h.length - pcm.length);
    }
    this.filled = Math.min(h.length, this.filled + pcm.length);
    this.sink?.(pcm);
  }

  /** The last `samples` of audio (up to a second). */
  recent(samples: number): Int16Array {
    const n = Math.min(samples, this.filled);
    return this.history.slice(this.history.length - n);
  }

  get live() {
    return !this.closed && this.stream.getAudioTracks().some((t) => t.readyState === "live");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sink = null;
    this.stopCapture();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
  }
}

/**
 * Live transcription on the server (self-hosted, `/ws/voice`): the microphone is streamed as
 * 16 kHz PCM and the words come back as they're recognised, so the text grows while Dave talks.
 * Unlatched, the server's end-of-phrase detection ends the turn after a short pause.
 */
export class StreamingListener implements Listener {
  readonly kind = "live";
  level: LevelSource = SILENT;
  private stopNow: (() => void) | null = null;
  /** The microphone kept open between turns when `warm` (Converse); opened per turn otherwise. */
  private session: Promise<MicSession> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string | null,
    /**
     * Keep the microphone open between turns (until close()), so each turn starts at once and
     * with the moment before it: nothing said on the tone, or straight after a reply, is lost.
     */
    private readonly warm = false,
  ) {}

  private async mic(): Promise<MicSession> {
    if (!this.warm) return MicSession.open();
    const current = this.session ? await this.session.catch(() => null) : null;
    if (current?.live) return current;
    this.session = MicSession.open();
    this.session.catch(() => (this.session = null));
    return this.session;
  }

  /** Releases the microphone (a warm listener keeps it open until this). */
  close() {
    this.stop();
    const s = this.session;
    this.session = null;
    void s?.then((m) => m.close()).catch(() => {});
  }

  async listen({ timeoutMs, onInterim, maxTurnMs = 60_000, latched = false }: ListenOptions): Promise<string | null> {
    this.stop();
    const mic = await this.mic();
    this.level = new AnalyserLevel(mic.analyser);
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    // Audio from before the socket is ready is kept, so the first word isn't lost.
    const early: ArrayBuffer[] = [];
    let ready = false;
    let pending = new Int16Array(0);
    const FRAME = 640; // 40 ms at 16 kHz
    const sendAudio = (pcm: Int16Array) => {
      const joined = new Int16Array(pending.length + pcm.length);
      joined.set(pending);
      joined.set(pcm, pending.length);
      let at = 0;
      for (; at + FRAME <= joined.length; at += FRAME) {
        const buf = joined.slice(at, at + FRAME).buffer;
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(buf);
        else early.push(buf);
      }
      pending = joined.slice(at);
    };
    // A warm microphone has been running: the turn starts with the moment before it.
    if (this.warm) sendAudio(mic.recent(PREROLL_SAMPLES));
    mic.sink = sendAudio;
    const stopCapture = () => {
      if (mic.sink === sendAudio) mic.sink = null;
      if (!this.warm) mic.close();
    };

    return new Promise<string | null>((resolve, reject) => {
      let text = "";
      let heard = false;
      let settled = false;
      let stopping = false;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(cap);
        clearTimeout(guard);
        stopCapture();
        this.level = SILENT;
        this.stopNow = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      };
      const done = (value: string | null, error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value?.trim() ? value.trim() : null);
      };
      let guard: ReturnType<typeof setTimeout> | undefined;
      // Ends the turn: the server finishes the last words, then sends the final text.
      const end = () => {
        if (stopping || settled) return;
        stopping = true;
        stopCapture();
        if (pending.length) {
          const tail = new Int16Array(FRAME);
          tail.set(pending.slice(0, FRAME));
          pending = new Int16Array(0);
          if (ready && ws.readyState === WebSocket.OPEN) ws.send(tail.buffer);
        }
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
        guard = setTimeout(() => done(text || null), ready ? 2500 : 0);
      };
      this.stopNow = end;
      const timer = setTimeout(() => {
        if (!heard) end();
      }, timeoutMs);
      const cap = setTimeout(end, maxTurnMs);

      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token ?? "", latched }));
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const msg = JSON.parse(e.data) as { type: string; text?: string; message?: string };
        if (msg.type === "ready") {
          ready = true;
          for (const buf of early.splice(0)) ws.send(buf);
          if (stopping) ws.send(JSON.stringify({ type: "stop" }));
        } else if (msg.type === "partial") {
          text = msg.text ?? "";
          if (text) heard = true;
          onInterim?.(text);
        } else if (msg.type === "endOfTurn") {
          text = msg.text ?? text;
          if (!latched) end();
        } else if (msg.type === "final") {
          done(msg.text ?? text);
        } else if (msg.type === "error") {
          done(null, new Error(msg.message ?? "Live transcription failed"));
        }
      };
      ws.onerror = () => done(null, new Error("Couldn't reach live transcription"));
      ws.onclose = (e) => {
        if (settled) return;
        if (e.code === 4003) done(null, new Error("Live transcription refused the sign-in"));
        else done(text || null);
      };
    });
  }

  stop() {
    this.stopNow?.();
  }
}

// ---------- Speaking ----------

export interface Speaker {
  readonly kind: "browser" | "server";
  /** The voice's level while it talks, for Drive mode's orb. */
  readonly level: LevelSource;
  speak(text: string): Promise<void>;
  /** Speaks pieces (sentences) as they arrive, e.g. a reply that is still being written. */
  speakStream(pieces: AsyncIterable<string>): Promise<void>;
  cancel(): void;
}

type VoiceLike = Pick<SpeechSynthesisVoice, "name" | "lang" | "localService" | "default">;

const PREFERRED = [
  /microsoft (ryan|sonia|libby|maisie|thomas) online \(natural\)/i,
  /\b(daniel|serena|kate|arthur|martha|oliver|stephanie)\b.*\((premium|enhanced)\)/i,
  /google uk english/i,
  /\b(daniel|serena|kate|arthur|martha|oliver|stephanie)\b/i,
  /microsoft (ryan|sonia|libby|george|hazel)/i,
  /natural|neural|premium|enhanced/i,
];

/** Best voice for `lang` (en-GB by default): exact language, then same language; known-good names first. Pure. */
export function pickVoice<V extends VoiceLike>(voices: V[], lang = "en-GB"): V | null {
  const norm = (l: string) => l.replace("_", "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0]!;
  const score = (v: V) => {
    const l = norm(v.lang);
    let s = l === want ? 100 : l.startsWith(`${base}-`) || l === base ? 40 : 0;
    if (!s) return 0;
    PREFERRED.forEach((re, i) => {
      if (re.test(v.name)) s += 20 - i * 3;
    });
    if (/compact|novelty|whisper|bad news|bells|bubbles|zarvox|trinoids|albert|jester|organ|cellos/i.test(v.name)) return 0;
    if (v.localService) s += 2;
    return s;
  };
  const ranked = voices.map((v) => [score(v), v] as const).filter(([s]) => s > 0);
  ranked.sort((a, b) => b[0] - a[0]);
  return ranked[0]?.[1] ?? null;
}

/**
 * Sentence-sized chunks of at most `max` characters: Chrome (Android especially) stops a single
 * utterance after about 15 seconds, so a sentence longer than `max` is split at a comma, colon
 * or semicolon, else between words.
 */
export function chunkForSpeech(text: string, max = 160): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text];
  const pieces = sentences.map((x) => x.trim()).filter(Boolean).flatMap((s) => splitLong(s, max));
  const chunks: string[] = [];
  let current = "";
  for (const s of pieces) {
    if ((current + " " + s).trim().length > max && current) {
      chunks.push(current);
      current = s;
    } else current = `${current} ${s}`.trim();
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" - "));
    const at = clause > max * 0.4 ? clause + 1 : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function hasSynthesis(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Loads the voice list, which some browsers fill asynchronously. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!hasSynthesis()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(speechSynthesis.getVoices()), timeoutMs);
    speechSynthesis.addEventListener?.("voiceschanged", () => {
      clearTimeout(t);
      resolve(speechSynthesis.getVoices());
    }, { once: true });
  });
}

export class BrowserSpeaker implements Speaker {
  readonly kind = "browser";
  private generation = 0;
  private readonly pulse = new PulseLevel();
  readonly level: LevelSource = this.pulse;

  constructor(
    private readonly voice: SpeechSynthesisVoice | null,
    private readonly lang = "en-GB",
    private readonly rate = 1,
  ) {}

  async speak(text: string): Promise<void> {
    await this.speakStream(once(text));
  }

  async speakStream(pieces: AsyncIterable<string>): Promise<void> {
    this.cancel();
    const gen = ++this.generation;
    this.pulse.active = true;
    try {
      for await (const piece of pieces) {
        for (const chunk of chunkForSpeech(piece)) {
          if (gen !== this.generation) return;
          await this.utter(chunk);
        }
      }
    } finally {
      if (gen === this.generation) this.pulse.active = false;
    }
  }

  private utter(chunk: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = this.voice?.lang ?? this.lang;
      if (this.voice) u.voice = this.voice;
      u.rate = this.rate;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        clearInterval(poll);
        resolve();
      };
      u.onend = u.onerror = finish;
      u.onboundary = () => this.pulse.pulse(0.7);
      // Some engines never fire `end`. Don't hang on them, but don't move on (and open the mic,
      // which stops the voice) while it is still talking either: after a generous estimate,
      // wait for the engine to go quiet.
      let poll: ReturnType<typeof setInterval> | undefined;
      const guard = setTimeout(() => {
        poll = setInterval(() => {
          if (!speechSynthesis.speaking && !speechSynthesis.pending) finish();
        }, 250);
      }, 3000 + chunk.length * 120);
      speechSynthesis.speak(u);
    });
  }

  cancel() {
    this.generation++;
    this.pulse.active = false;
    if (hasSynthesis()) speechSynthesis.cancel();
  }
}

async function* once(text: string): AsyncIterable<string> {
  yield text;
}

let audioContext: AudioContext | null = null;

/**
 * One AudioContext for the server voice across the app. iOS only lets audio play once a tap has
 * resumed it, so call this from a tap (e.g. switching on "Read replies aloud"); later playback,
 * such as a reply arriving, then works.
 */
export function sharedAudioContext(): AudioContext {
  audioContext ??= new AudioContext();
  void audioContext.resume?.().catch(() => {});
  return audioContext;
}

/** The pause after a piece: a breath after a sentence, a beat after a clause. Pure. */
export function pauseAfter(piece: string): number {
  return /[.!?]["')\]]*$/.test(piece.trim()) ? 0.24 : /[,;:—–-]$/.test(piece.trim()) ? 0.08 : 0.14;
}

/**
 * The server's voice (self-hosted Kokoro, or a keyed provider), played through Web Audio: each
 * sentence is synthesised on its own (the first as soon as it's known, the next two fetched while
 * it plays) and scheduled back to back with natural pauses, so a reply starts quickly and flows.
 * The playback level drives Drive mode's orb. A piece that fails is spoken by `fallback`.
 */
export class ServerSpeaker implements Speaker {
  readonly kind = "server";
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meter: LevelSource = SILENT;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private generation = 0;

  constructor(
    private readonly synthesize: (text: string) => Promise<Blob>,
    private readonly fallback: Speaker | null = null,
  ) {}

  get level(): LevelSource {
    return this.meter;
  }

  /** Creates (or resumes) the audio context; call from a tap so iOS lets it play. */
  unlock(): AudioContext {
    if (!this.ctx) {
      this.ctx = sharedAudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.connect(this.ctx.destination);
      this.meter = new AnalyserLevel(this.analyser);
    }
    void this.ctx.resume?.().catch(() => {});
    return this.ctx;
  }

  speak(text: string): Promise<void> {
    return this.speakStream(once(text));
  }

  async speakStream(input: AsyncIterable<string>): Promise<void> {
    this.cancel();
    const gen = ++this.generation;
    const ctx = this.unlock();
    const live = () => gen === this.generation;

    // Pieces as they arrive (long ones split at clauses: the server takes up to 2000 characters).
    const pieces: string[] = [];
    const buffers: (Promise<AudioBuffer | null> | undefined)[] = [];
    let ended = false;
    const signal: { wake: (() => void) | null } = { wake: null };
    void (async () => {
      try {
        for await (const piece of input) {
          if (!live()) break;
          pieces.push(...chunkForSpeech(piece, 400));
          signal.wake?.();
        }
      } catch {
        // the source failed: speak what arrived
      } finally {
        ended = true;
        signal.wake?.();
      }
    })();
    const fetchAt = (i: number) => {
      if (i >= pieces.length || buffers[i]) return;
      buffers[i] = this.synthesize(pieces[i]!)
        .then(async (blob) => ctx.decodeAudioData(await blob.arrayBuffer()))
        .catch(() => null);
    };

    let next = 0;
    let last: Promise<void> = Promise.resolve();
    for (let i = 0; ; ) {
      if (!live()) return;
      if (i >= pieces.length) {
        if (ended) break;
        await new Promise<void>((r) => (signal.wake = r));
        signal.wake = null;
        continue;
      }
      // Synthesise this piece and the next two ahead of playback.
      for (let j = i; j < Math.min(pieces.length, i + 3); j++) fetchAt(j);
      const piece = pieces[i]!;
      const buffer = await buffers[i]!;
      i++;
      if (!live()) return;
      if (!buffer) {
        // Couldn't synthesise this one: say it with the fallback voice, after what's queued.
        await last;
        if (live()) await this.fallback?.speak(piece);
        next = 0;
        continue;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser!);
      const start = Math.max(ctx.currentTime + 0.03, next);
      src.start(start);
      next = start + buffer.duration + pauseAfter(piece);
      this.sources.add(src);
      last = new Promise<void>((resolve) => {
        src.onended = () => {
          this.sources.delete(src);
          resolve();
        };
      });
    }
    await last;
  }

  cancel() {
    this.generation++;
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // not started
      }
    }
    this.sources.clear();
    this.fallback?.cancel();
  }
}

// ---------- Earcons ----------

let audioCtx: AudioContext | null = null;

/** Short tones: "listen" (rising, I'm listening), "turn" (two rising, your turn), "done" (falling). */
export function earcon(kind: "listen" | "turn" | "done" | "error"): Promise<void> {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    void ctx.resume?.();
    const notes: Record<typeof kind, number[]> = { listen: [660, 880], turn: [523, 659, 784], done: [784, 523], error: [330, 247] };
    const t0 = ctx.currentTime + 0.02;
    notes[kind].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      const start = t0 + i * 0.11;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.11);
    });
    return new Promise((r) => setTimeout(r, notes[kind].length * 110 + 60));
  } catch {
    return Promise.resolve();
  }
}

// ---------- Wake lock ----------

type Sentinel = { release(): Promise<void>; addEventListener(t: "release", f: () => void): void };

/** Keeps the screen on while Drive mode is open, re-acquiring after the page becomes visible again. */
export class ScreenWakeLock {
  private sentinel: Sentinel | null = null;
  private wanted = false;
  onChange: (held: boolean) => void = () => {};

  get supported() {
    return "wakeLock" in navigator;
  }

  async acquire() {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisible);
    await this.request();
  }

  private onVisible = () => {
    if (this.wanted && document.visibilityState === "visible" && !this.sentinel) void this.request();
  };

  private pending = false;

  private async request() {
    if (!this.supported || document.visibilityState !== "visible" || this.pending || this.sentinel) return;
    this.pending = true;
    try {
      const s = (await (navigator as Navigator & { wakeLock: { request(t: "screen"): Promise<Sentinel> } }).wakeLock.request("screen")) as Sentinel;
      // Released (Drive closed) while the request was in flight: let it go straight away.
      if (!this.wanted) {
        await s.release().catch(() => {});
        return;
      }
      this.sentinel = s;
      this.onChange(true);
      s.addEventListener("release", () => {
        this.sentinel = null;
        this.onChange(false);
      });
    } catch {
      this.onChange(false);
    } finally {
      this.pending = false;
    }
  }

  async release() {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisible);
    await this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }
}

// ---------- Headset / steering-wheel button ----------

/** A WAV of silence; looping it keeps this page the "now playing" app so media buttons reach it. */
function silentWav(seconds = 10, rate = 8000): Blob {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit unsigned silence
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Maps the headset / car play-pause (and next/previous) buttons to `onPress`
 * through the Media Session API. Must be started from a tap (autoplay rules).
 */
export class HeadsetButton {
  private readonly audio = new Audio();
  private last = 0;
  active = false;

  constructor(private readonly onPress: () => void) {
    this.audio.loop = true;
    this.audio.src = URL.createObjectURL(silentWav());
  }

  get supported() {
    return "mediaSession" in navigator;
  }

  async start() {
    if (!this.supported || this.active) return;
    try {
      await this.audio.play();
    } catch {
      return; // no gesture yet; the next tap retries
    }
    this.active = true;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title: "Command Centre", artist: "Converse: press to talk" });
    } catch {
      // MediaMetadata missing
    }
    const press = () => {
      const now = Date.now();
      if (now - this.last < 500) return; // some cars send play and pause together
      this.last = now;
      void this.audio.play().catch(() => {});
      ms.playbackState = "playing";
      this.onPress();
    };
    for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack"] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(action, press);
      } catch {
        // action not supported here
      }
    }
    ms.playbackState = "playing";
  }

  stop() {
    this.active = false;
    this.audio.pause();
    if (!this.supported) return;
    for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack"] as MediaSessionAction[]) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
    navigator.mediaSession.playbackState = "none";
  }
}
