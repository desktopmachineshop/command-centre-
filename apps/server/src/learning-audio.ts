import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { BrainConflictError, type Brain, type Frontmatter, noteTitle } from "@cc/brain";
import type { Storage } from "@cc/storage";
import { type Lexicon, lessonScript, narrationPieces, parseLexicon, pronounce } from "@cc/voice/lesson";
import { LESSONS_FOLDER, README_PATH } from "./learning";

/**
 * Narrated lessons. A lesson isn't live, so instead of speaking it sentence by sentence on the
 * phone it is recorded once, carefully, into one MP3 (stored like any other file: on Google Drive
 * when it's connected, under "Command Centre/Personal/audio"):
 *
 * - pronunciation: terms are said the way learning/pronunciation.md says (the coach keeps it);
 * - cadence: whole sentences, with measured silences after a sentence, a paragraph, a heading and
 *   before each new section, instead of live speech's clause-sized bursts;
 * - checked by ear: the server's own speech recognition listens to every sentence; where it can't
 *   hear the expected words, an acronym is tried spelled out ("P L C") and the better take kept,
 *   and what still sounds off is listed on the lesson and under "To check" for the coach to fix;
 * - a proper player: chapters per section, seeking, speed, and playback with the screen off.
 */

export const PRONUNCIATION_PATH = "learning/pronunciation.md";

/** Free and natural (Kokoro, self-hosted) unless Dave picks another narrator on the Learning page. */
export const DEFAULT_NARRATOR = "kokoro:bf_emma";
/**
 * The server's own voices read lessons a touch slower than they chat (the default is 1.05): easier
 * to follow while driving. Measured on Kokoro: about 165 words a minute with the pauses.
 */
export const NARRATION_SPEED = 0.95;
/** How keyed voices that take a style (OpenAI gpt-4o-mini-tts) should read. */
export const NARRATOR_STYLE =
  "You are narrating an educational podcast for an experienced British engineer. Speak with a natural Southern British English accent and British pronunciations (zed, not zee). Warm, curious and unhurried, like a good radio presenter: natural rises and falls, light emphasis on the key word of each sentence, and a breath between ideas. Never rushed, never sing-song.";

export const PRONUNCIATION_TEMPLATE = `# Pronunciation

How the lesson narrator says words it would otherwise get wrong. One per line,
\`- Term: how to say it\` (spell it the way it sounds; spaces between letters spell an acronym
out). Terms with capitals match exactly; all-lower-case ones match any case. Standards' numbers
are read the way engineers say them ("IEC 61131-3" as "sixty-one one thirty-one, part 3") without
an entry, and a Z on its own is "zed" (the Z axis). Respell the British way: this list is used for
everything the app says aloud, lessons and Converse alike. Only add what the voice gets wrong: a respelling can make a word it already says well
worse ("Beckhoff" is fine as it is). The coach adds new
terms as it writes lessons. "To check" lists what the narrator's listen-back flagged: fix the
spelling here (or move it up) and the next recording uses it.

## Say it like this
- EtherCAT: Ether-cat
- TwinCAT: Twin-cat
- TwinSAFE: Twin-safe
- CODESYS: Code-sis
- PLC: P L C
- PLCs: P L Cs
- HMI: H M I
- SCADA: Scada
- IEC: I E C
- ISO: I S O
- IEEE: I triple E
- INCOSE: In-coze
- DO-178C: D O one seventy-eight C
- SIL: sill
- CNC: C N C
- CAD: cad
- CAM: cam
- G-code: G code
- FDM: F D M
- SLA: S L A
- LPBF: L P B F
- DED: D E D
- ESP32: E S P thirty-two
- MQTT: M Q T T
- SaaS: sass
- API: A P I
- MRR: M R R
- ARR: A R R
- LLM: L L M
- LLMs: L L Ms
- RAG: rag
- MCP: M C P
- GPU: G P U
- AI: A I
- XYZ: X Y zed
- ZDR: zed D R
- NdFeB: neodymium iron boron
- WC-Co: tungsten carbide cobalt
- µm: micrometres
- mm: millimetres
- rpm: R P M
- kW: kilowatts
- Nm: newton metres

## To check
`;

// ---------- checking by ear (pure) ----------

/**
 * One spelling for British and American variants, so the recogniser (which writes American)
 * isn't marked wrong for "synchronization" or "millimeter". Pure.
 */
export function oneSpelling(word: string): string {
  return word
    .toLowerCase()
    .replace(/is(ation|ations|e|es|ed|ing|er|ers)$/, "iz$1")
    .replace(/ys(e|es|ed|ing)$/, "yz$1")
    .replace(/tre(s?)$/, "ter$1")
    .replace(/our(s|ed|ing|ite|ites)?$/, "or$1")
    .replace(/ogue(s?)$/, "og$1")
    .replace(/ogued$/, "oged")
    .replace(/lled$/, "led")
    .replace(/lling$/, "ling")
    .replace(/(def|off|lic|pret)ence(s?)$/, "$1ense$2")
    .replace(/^tonne(s?)$/, "ton$1")
    .replace(/^programme(s?)$/, "program$1")
    .replace(/^aluminium$/, "aluminum")
    .replace(/^grey$/, "gray");
}

/**
 * A word's consonants, without "r" and doubled letters: what's left when a British voice meets an
 * American recogniser, which hears the short "o" of "shock", "clock" or "shops" as "shark",
 * "clerk", "sharps". Only used for ordinary words, never for names and jargon. Pure.
 */
export function skeleton(word: string): string {
  return word
    .toLowerCase()
    .replace(/ck/g, "k")
    .replace(/[aeiouyr]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** Words, keeping their case (to tell terms from ordinary words) and their position. */
const tokens = (t: string) =>
  t
    .replace(/[-–—/]/g, " ")
    .replace(/[^A-Za-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Words of `a` found in order in `b` (longest common subsequence). */
function lcs(a: string[], b: string[]): boolean[] {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const hit = new Array<boolean>(a.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      hit[i] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return hit;
}

/**
 * How much of what should have been said was heard: the share of expected words recognised in
 * order, the words that weren't (numbers and short words ignored: recognisers write "ten" as
 * "10", and "a", "of" come and go), and which of those are terms (a capital past the first word,
 * or an acronym): names and jargon are where voices go wrong. Pure.
 */
export function compareHeard(expected: string, heard: string): { score: number; missing: string[]; terms: string[] } {
  const raw = tokens(expected);
  const want = raw.map(oneSpelling);
  const said = tokens(heard).map(oneSpelling);
  const hit = lcs(want, said);
  // Spacing isn't pronunciation: "Ether-cat" heard as "Ethercat", or "TwinCAT" as "twin cat", is right.
  const joined = said.join("");
  const rawJoined = want.join("");
  for (let i = 0; i < want.length; i++) {
    if (hit[i]) continue;
    const w = want[i]!;
    const withNext = want[i + 1] ? w + want[i + 1] : "";
    const withPrev = want[i - 1] ? want[i - 1] + w : "";
    if ((withNext && joined.includes(withNext)) || (withPrev && joined.includes(withPrev)) || (w.length >= 5 && joined.includes(w))) hit[i] = true;
    else if (said.some((h) => h.length >= 5 && w.length < h.length && rawJoined.includes(h) && h.includes(w))) hit[i] = true;
  }
  // An ordinary word heard with the same consonants is an accent, not a mispronunciation.
  const isTerm = (i: number) => (i > 0 && /[A-Z]/.test(raw[i]!)) || /[A-Z].*[A-Z]/.test(raw[i]!);
  for (let i = 0; i < want.length; i++) {
    if (hit[i] || isTerm(i)) continue;
    const s = skeleton(want[i]!);
    const w = want[i]!;
    // Words with no consonants left ("ore" heard as "aur") match a similar vowel-only word.
    if (s.length >= 2 ? said.some((h) => skeleton(h) === s) : said.some((h) => skeleton(h) === s && Math.abs(h.length - w.length) <= 1)) hit[i] = true;
  }
  const counted = raw.map((w, i) => ({ w: want[i]!, hit: hit[i]!, counts: w.length > 2 && !/\d/.test(w), term: (i > 0 && /[A-Z]/.test(w)) || /[A-Z].*[A-Z]/.test(w) }));
  const total = counted.filter((c) => c.counts).length;
  if (!total) return { score: 1, missing: [], terms: [] };
  const lost = counted.filter((c) => c.counts && !c.hit);
  return { score: (total - lost.length) / total, missing: [...new Set(lost.map((c) => c.w))], terms: [...new Set(lost.filter((c) => c.term).map((c) => c.w))] };
}

/** Whether a sentence sounded off: too little of it heard, or a term in it misheard. Pure. */
export const soundsOff = (r: { score: number; terms: string[] }) => r.score < HEARD_THRESHOLD || r.terms.length > 0;

/** A sentence counts as off when under this share of its words were heard. */
export const HEARD_THRESHOLD = 0.8;

/** Acronyms in a sentence the lexicon doesn't cover ("PLC", "OPC", "EN50128"). Pure. */
export function unknownAcronyms(text: string, lexicon: Lexicon): string[] {
  return [...new Set([...text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]{1,5})s?(?![\w-])/g)].map((m) => m[1]!))].filter((a) => !lexicon.has(a) && /[A-Z].*[A-Z]|[A-Z]\d/.test(a));
}

/** The acronyms spelled out letter by letter, the British way ("OPC" → "O P C", "ZDR" → "zed D R"). Pure. */
export function spellOut(text: string, acronyms: string[]): string {
  let out = text;
  for (const a of acronyms)
    out = out.replace(new RegExp(`(?<![\\w-])${a}(s?)(?![\\w-])`, "g"), (_m, s: string) => `${a.replace(/[A-Z]/g, "$& ").trim().replace(/\bZ\b/g, "zed")}${s}`);
  return out;
}

/**
 * The pronunciation list for everything the server says (Converse replies, read-aloud, the spoken
 * briefing), read from the brain and kept for a minute, so an edit applies almost at once without
 * a database read per sentence.
 */
export class PronunciationList {
  private cached: { at: number; lexicon: Lexicon } | null = null;
  private loading: Promise<Lexicon> | null = null;

  constructor(
    private readonly brain: Pick<Brain, "read">,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async lexicon(): Promise<Lexicon> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.lexicon;
    this.loading ??= this.brain
      .read(PRONUNCIATION_PATH)
      .then((note) => (note ? parseLexicon(note.body) : new Map<string, string>()))
      .catch(() => this.cached?.lexicon ?? new Map<string, string>())
      .then((lexicon) => {
        this.cached = { at: this.now(), lexicon };
        return lexicon;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** `text` as the voice should say it. */
  async pronounce(text: string): Promise<string> {
    return pronounce(text, await this.lexicon());
  }
}

/** Adds flagged terms under "## To check" in the pronunciation note, once each. Pure. */
export function addToCheck(body: string, terms: { term: string; where: string }[]): string {
  const lines = body.split("\n");
  let at = lines.findIndex((l) => /^##\s+to check\s*$/i.test(l));
  if (at === -1) {
    lines.push("", "## To check");
    at = lines.length - 1;
  }
  const present = new Set(lines.map((l) => /^\s*[-*]\s+`?([^`:—]+?)`?\s*(?:[—:]|$)/.exec(l)?.[1]?.trim().toLowerCase()).filter(Boolean));
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  const add = terms.filter((t) => !present.has(t.term.toLowerCase())).map((t) => `- ${t.term} — ${t.where}`);
  // After the section's last entry (or straight under its heading), not after trailing blank lines.
  let insert = at + 1;
  for (let i = at + 1; i < end; i++) if (lines[i]!.trim()) insert = i + 1;
  lines.splice(insert, 0, ...add);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---------- audio (ffmpeg) ----------

/** The rate everything is mixed at, and recognition's. */
export const MIX_RATE = 24_000;
const ASR_RATE = 16_000;

function ffmpeg(args: string[], input: Uint8Array | null, bin = "ffmpeg"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim() || `exit ${code}`}`))));
    p.stdin.on("error", () => {});
    if (input) p.stdin.end(Buffer.from(input));
    else p.stdin.end();
  });
}

/** Whether ffmpeg is installed (the Docker image has it). */
export async function hasFfmpeg(bin = "ffmpeg"): Promise<boolean> {
  return ffmpeg(["-version"], null, bin).then(
    () => true,
    () => false,
  );
}

/** Any audio → mono 16-bit PCM at `rate`. */
export const toPcm = (audio: Uint8Array, rate = MIX_RATE, bin?: string) => ffmpeg(["-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(rate), "pipe:1"], audio, bin);
/** Mono 16-bit PCM at MIX_RATE → MP3 (64 kbit/s: speech, about half a megabyte a minute). */
export const pcmToMp3 = (pcm: Buffer, bin?: string) => ffmpeg(["-f", "s16le", "-ac", "1", "-ar", String(MIX_RATE), "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1"], pcm, bin);

const pcmToFloat = (pcm: Buffer): Float32Array => {
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
};
const silence = (seconds: number) => Buffer.alloc(Math.round(seconds * MIX_RATE) * 2);

// ---------- recording ----------

export interface LessonAudio {
  id: string;
  url: string;
  voice: string;
  seconds: number;
  chapters: { title: string; at: number }[];
  recorded: string;
  /** Sentences checked by ear, and those that still sounded off. */
  checked: number;
  flagged: { text: string; missing: string[]; heard: string }[];
}

export interface NarrationDeps {
  brain: Pick<Brain, "read" | "write" | "list">;
  storage: Pick<Storage, "put" | "delete">;
  /** One piece of speech in the narrator's voice (VoiceService.narrate). */
  narrate: (text: string, voice: string | undefined, opts: { instructions?: string; speed?: number }) => Promise<{ audio: Uint8Array }>;
  /** Recognition of 16 kHz mono samples, when the server's own recogniser is installed. */
  transcribe?: (() => ((samples: Float32Array) => Promise<string>) | null) | null;
  /** Public URL of a stored file (/media/<id>). */
  mediaUrl: (id: string) => string;
  ffmpegBin?: string;
  log?: (line: string) => void;
}

/** The narrator chosen on the Learning page (README frontmatter), else the free default. */
export async function narratorOf(brain: Pick<Brain, "read">): Promise<string> {
  const readme = await brain.read(README_PATH).catch(() => null);
  const n = readme?.frontmatter.narrator;
  return typeof n === "string" ? n : DEFAULT_NARRATOR;
}

export async function setNarrator(brain: Pick<Brain, "read" | "write">, voice: string): Promise<void> {
  const readme = await brain.read(README_PATH);
  const { updated: _u, ...fm } = readme?.frontmatter ?? { type: "playbook", vertical: "personal" };
  await brain.write(README_PATH, { frontmatter: { ...fm, narrator: voice }, body: readme?.body ?? "# Learning\n" }, { author: "dave", message: "learning: narrator" });
}

/** A lesson note's recording, if it has one. */
export const audioOf = (fm: Frontmatter): LessonAudio | null => {
  const a = fm.audio as Partial<LessonAudio> | undefined;
  return a && typeof a === "object" && typeof a.id === "string" && typeof a.url === "string" ? (a as LessonAudio) : null;
};

/**
 * Records one lesson and saves it on the lesson note (`audio:`), replacing any earlier take.
 * `onProgress(done, total)` follows the sentences.
 */
export async function recordLesson(deps: NarrationDeps, path: string, onProgress: (done: number, total: number) => void = () => {}): Promise<LessonAudio> {
  const note = await deps.brain.read(path);
  if (!note) throw new Error(`no lesson at ${path}`);
  const lexNote = await deps.brain.read(PRONUNCIATION_PATH).catch(() => null);
  const lexicon = lexNote ? parseLexicon(lexNote.body) : new Map<string, string>();
  const title = noteTitle(note);
  const script = lessonScript(note.body, title, lexicon);
  const pieces = narrationPieces(script);
  if (!pieces.length) throw new Error("nothing to read in this lesson");
  const voice = await narratorOf(deps.brain);
  const opts = { instructions: NARRATOR_STYLE, speed: NARRATION_SPEED };
  const listen = deps.transcribe?.() ?? null;

  const chunks: Buffer[] = [];
  let samples = 0;
  const chapters: LessonAudio["chapters"] = [];
  const flagged: LessonAudio["flagged"] = [];
  let checked = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (i === 0 || pieces[i - 1]!.section !== piece.section) {
      chapters.push({ title: script.sections[piece.section]?.title ?? title, at: Math.round((samples / MIX_RATE) * 10) / 10 });
    }
    const say = async (text: string) => {
      const { audio } = await deps.narrate(text, voice || undefined, opts);
      return { audio, pcm: await toPcm(audio, MIX_RATE, deps.ffmpegBin) };
    };
    let take = await say(piece.text);
    if (listen) {
      // Recognisers need a moment of lead-in and tail around the words.
      const hear = async (audio: Uint8Array) => {
        const f = pcmToFloat(await toPcm(audio, ASR_RATE, deps.ffmpegBin));
        // The streaming recogniser only commits its last words after a good second of silence.
        const padded = new Float32Array(f.length + Math.round(2.3 * ASR_RATE));
        padded.set(f, Math.round(0.3 * ASR_RATE));
        return listen(padded).catch(() => "");
      };
      let heard = await hear(take.audio);
      let result = compareHeard(piece.text, heard);
      checked++;
      if (soundsOff(result)) {
        const acronyms = unknownAcronyms(piece.text, lexicon);
        if (acronyms.length) {
          const spelled = spellOut(piece.text, acronyms);
          const retake = await say(spelled);
          const reheard = await hear(retake.audio);
          const again = compareHeard(spelled, reheard);
          if (again.score > result.score || (again.score === result.score && again.terms.length < result.terms.length)) {
            take = retake;
            heard = reheard;
            result = again;
          }
        }
      }
      if (soundsOff(result) && result.missing.length) flagged.push({ text: piece.text, missing: result.missing, heard });
    }
    chunks.push(take.pcm, silence(piece.pause));
    samples += take.pcm.length / 2 + Math.round(piece.pause * MIX_RATE);
    onProgress(i + 1, pieces.length);
  }
  const mp3 = await pcmToMp3(Buffer.concat(chunks), deps.ffmpegBin);
  const slug = path.split("/").pop()!.replace(/\.md$/, "");
  const blob = await deps.storage.put(Readable.from(mp3), { name: `${slug}.mp3`, contentType: "audio/mpeg", folder: "audio", vertical: "personal", size: mp3.length });

  const audio: LessonAudio = {
    id: blob.id,
    url: deps.mediaUrl(blob.id),
    voice: voice || "default",
    seconds: Math.round(samples / MIX_RATE),
    chapters,
    recorded: new Date().toISOString(),
    checked,
    flagged: flagged.slice(0, 40),
  };
  // Save on the note as it is now (the coach or Dave may have saved since we read it).
  const latest = (await deps.brain.read(path)) ?? note;
  const previous = audioOf(latest.frontmatter);
  const { updated: _u, ...fm } = latest.frontmatter;
  await deps.brain.write(path, { frontmatter: { ...fm, audio }, body: latest.body }, { author: "system", message: `learning: recorded (${Math.round(audio.seconds / 60)} min, ${voice || "default voice"})` });
  if (previous && previous.id !== audio.id) await deps.storage.delete(previous.id).catch(() => {});

  if (flagged.length) {
    const terms = [...new Set(flagged.flatMap((f) => f.missing))].slice(0, 20).map((term) => ({ term, where: `sounded off in "${title}" (${slug.slice(0, 10)})` }));
    const lex: { frontmatter: Frontmatter; body: string } = (await deps.brain.read(PRONUNCIATION_PATH).catch(() => null)) ?? { frontmatter: { type: "playbook", vertical: "personal" }, body: PRONUNCIATION_TEMPLATE };
    const { updated: _lu, ...lfm } = lex.frontmatter;
    await deps.brain.write(PRONUNCIATION_PATH, { frontmatter: lfm, body: addToCheck(lex.body, terms) }, { author: "system", message: "learning: words to check" }).catch(() => {});
  }
  return audio;
}

// ---------- the recorder: one lesson at a time, in the background ----------

export interface RecorderState {
  available: boolean;
  /** Why recording is off (no ffmpeg), if it is. */
  reason: string | null;
  current: { path: string; done: number; total: number } | null;
  queued: string[];
  lastError: { path: string; error: string } | null;
}

/**
 * Records lessons in the background: every lesson that is ready and has no recording (newest
 * first), and any Dave asks for again (a new narrator, a fixed pronunciation). One at a time, so
 * the server's own voice still answers Drive mode between sentences.
 */
export class LessonRecorder {
  private readonly queue: string[] = [];
  private current: RecorderState["current"] = null;
  private lastError: RecorderState["lastError"] = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ffmpeg: boolean | null = null;
  /** Lessons whose recording failed this run, so the sweep doesn't retry them every few minutes. */
  private readonly failed = new Set<string>();

  constructor(private readonly deps: NarrationDeps & { brain: NarrationDeps["brain"] & { summaries?: (folder: string) => Promise<{ path: string; frontmatter: Frontmatter }[]> } }) {}

  state(): RecorderState {
    return { available: this.ffmpeg !== false, reason: this.ffmpeg === false ? "ffmpeg isn't installed on the server" : null, current: this.current, queued: [...this.queue], lastError: this.lastError };
  }

  /** Records `path` next (again, if it has a recording). */
  request(path: string): void {
    this.failed.delete(path);
    if (this.current?.path !== path && !this.queue.includes(path)) this.queue.unshift(path);
    void this.drain();
  }

  /** Queues every ready lesson without a recording. */
  async sweep(): Promise<void> {
    const list = this.deps.brain.summaries ? await this.deps.brain.summaries(LESSONS_FOLDER) : [];
    const todo = list
      .filter((n) => n.frontmatter.status !== "done" && !audioOf(n.frontmatter) && !this.failed.has(n.path))
      .map((n) => n.path)
      .sort()
      .reverse();
    for (const p of todo) if (this.current?.path !== p && !this.queue.includes(p)) this.queue.push(p);
    await this.drain();
  }

  start(everyMs = 5 * 60_000): void {
    this.timer = setInterval(() => void this.sweep().catch((err) => this.deps.log?.(`[learning] sweep: ${(err as Error).message}`)), everyMs);
    this.timer.unref?.();
    setTimeout(() => void this.sweep().catch(() => {}), 30_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.ffmpeg ??= await hasFfmpeg(this.deps.ffmpegBin);
      if (!this.ffmpeg) return;
      for (let path = this.queue.shift(); path; path = this.queue.shift()) {
        this.current = { path, done: 0, total: 0 };
        const started = Date.now();
        try {
          const audio = await recordLesson(this.deps, path, (done, total) => (this.current = { path, done, total }));
          this.deps.log?.(`[learning] recorded ${path}: ${Math.round(audio.seconds / 60)} min in ${Math.round((Date.now() - started) / 60_000)} min, ${audio.flagged.length}/${audio.checked} sentences flagged`);
        } catch (err) {
          const error = (err as Error).message;
          this.lastError = { path, error };
          this.failed.add(path);
          this.deps.log?.(`[learning] recording ${path} failed: ${error}`);
          // A voice still downloading: try again at the next sweep.
          if ((err as Error).name === "VoiceNotInstalledError" || /not (downloaded|installed)/i.test(error)) this.failed.delete(path);
          if (err instanceof BrainConflictError) this.failed.delete(path);
        }
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }
}

