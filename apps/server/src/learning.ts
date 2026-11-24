import { type Brain, BrainConflictError, type Frontmatter, type NoteSummary, noteTitle, type PgBrain } from "@cc/brain";
import { Hono } from "hono";
import { z } from "zod";
import { dayRange, localDay } from "./days";
import type { Pool } from "./db/pool";
import { type LessonAudio, type LessonRecorder, PRONUNCIATION_PATH, PRONUNCIATION_TEMPLATE, type RecorderState } from "./learning-audio";
import { type PrepStore, STAGE_LABEL } from "./learning-release";
import { parseSkillTree, SKILL_TREE_PATH, SKILL_TREE_TEMPLATE, skillTreeView } from "./learning-skills";
import type { Pipeline } from "./pipeline";

/**
 * Guided learning (the career coach): a 30-minute lesson a day, read or listened to.
 *
 * Everything lives in the brain, so Dave and the agents edit it like any note:
 * - learning/topics.md, the topic map the assistant keeps (skills/career-coach);
 * - learning/skill-tree.md, each track's skills from foundations to expert (learning-skills.ts);
 * - learning/lessons/YYYY-MM-DD-<slug>.md, one note per lesson, frontmatter `type: lesson`;
 * - learning/research/YYYY-MM-DD-<slug>.md, the coach's notes on every source a lesson uses.
 *
 * The assistant writes lessons (the daily-lesson schedule, or a request from the Learning page)
 * as drafts; the release desk (learning-release.ts) checks, records and releases them. The
 * server seeds the notes, lists lessons, marks them done from the app and keeps the scoreboard,
 * all from the lessons' frontmatter.
 */

export const LEARNING_FOLDER = "learning/";
export const LESSONS_FOLDER = "learning/lessons/";
export const TOPICS_PATH = "learning/topics.md";
export const README_PATH = "learning/README.md";
export const ACTIVITY_FOLDER = "learning/activity/";
export const activityPath = (day: string) => `${ACTIVITY_FOLDER}${day}.md`;

/** The tracks lessons are filed under (the career-coach skill uses the same ids). */
export const LEARNING_TRACKS = [
  { id: "ai", name: "AI", description: "Models, agents, tooling, evaluation, research and news" },
  { id: "robotics", name: "Robotics & automation", description: "Robotics, industrial PLCs (Beckhoff), motion, fabrication, industrial AM, manufacturing and supply chain" },
  { id: "saas", name: "SaaS & requirements", description: "Requirements management and compliance, building and running a SaaS, Railway, agentic workflows" },
  { id: "maker", name: "Maker & home automation", description: "Hobby CNC and 3D printing, home electronics and automation, CODESYS" },
  { id: "market", name: "Tools & materials market", description: "Home-manufacturing trends and the world news behind tooling and motor prices" },
  { id: "interest", name: "Your picks", description: "Anything you ask for or show interest in" },
] as const;
export type TrackId = (typeof LEARNING_TRACKS)[number]["id"];
const TRACK_IDS = new Set<string>(LEARNING_TRACKS.map((t) => t.id));
const trackOf = (v: unknown): TrackId => (typeof v === "string" && TRACK_IDS.has(v.toLowerCase()) ? (v.toLowerCase() as TrackId) : "interest");

/** The narrator's pace (words a minute, pauses included, measured on Kokoro at 0.95) and a reader's, for the time estimates. */
export const LISTEN_WPM = 165;
export const READ_WPM = 230;

export const README_BODY = `# Learning

Your guided-learning mode. Every morning at 05:40 the assistant (as your career coach) picks a
topic and writes a lecture of about 30 minutes, read or listened to, into \`learning/lessons/\`.
The morning brief tells you what it is; open **Learning** in the app to read it or press
**Listen** and mark it done when you finish.

- **Lectures, not chat**: each lesson is written as a lecturer would deliver it, in British
  English, from sources the coach has read in full; its notes on each source are in
  \`learning/research/\`. Pictures, diagrams and tables are on the page, each with a caption
  that the narrator reads, so you can follow by ear.
- **Checked before release**: the coach saves a draft. The server checks it (the lecturer's
  voice, no talk of what couldn't be read, enough sources, every figure described, British
  spelling) and sends it back if need be, then records it and listens back to every sentence;
  anything that sounds off goes to the coach to fix in \`learning/pronunciation.md\` and it is
  recorded again. Only then does it appear in Learning.
- **Narrated**: recorded with a natural voice (free, on the server; pick another under
  *Narrator*). Recordings are stored with your other files (Google Drive, when connected:
  Command Centre/Personal/audio).
- **Skill tree**: \`learning/skill-tree.md\` lays out each track from foundations to expert,
  with what each skill builds on. Learning shows what's done, what's open and what's locked;
  lessons work through it.
- **Topics**: \`learning/topics.md\` is the topic map. Add a line under *Requested* (or ask in
  chat: "teach me about …") and it's taught next. Edit or reorder anything.
- **From your work**: before each lesson the server notes what you dealt with the day before in
  \`learning/activity/\`. The coach turns that into topics under *From your work*.
- **Scoreboard**: the Learning page counts lessons done, minutes, your streak and each track.
- **Daily lesson**: the Businesses page (Assistant → schedules → daily-lesson) turns it off or
  moves it.
`;

export const TOPICS_TEMPLATE = `# Learning topics

The career coach's topic map (skills/career-coach). One topic per line, as
\`- [track] Topic: why it's worth learning\`. Tracks: ai, robotics, saas, maker, market, interest.
Add anything under Requested and it's taught next. "From your work" is filled each morning from
what you dealt with the day before (learning/activity/). Edit freely.

## Requested

## From your work

## Up next
- [ai] How AI agents plan and use tools: the loop behind coding and research agents, and where it breaks
- [robotics] EtherCAT and Beckhoff TwinCAT 3 motion: how distributed clocks keep axes in step
- [market] Why carbide end mill prices move: tungsten, cobalt, China's export controls and what to watch
- [saas] Requirements traceability done well: from stakeholder need to verified test, and what auditors look for

## Backlog

### AI
- [ai] Evaluating LLM systems: test sets, judges and the traps in both
- [ai] Retrieval-augmented generation: chunking, embeddings, reranking and when it isn't the answer
- [ai] The Model Context Protocol: how tools and data reach a model
- [ai] Vision-language-action models for robots: what they can and can't do yet
- [ai] The EU AI Act in practice: what applies to engineering and SaaS products, and when
- [ai] Fine-tuning versus prompting versus tools: choosing the cheapest thing that works

### Robotics & automation
- [robotics] IEC 61131-3 beyond ladder: structured text, function blocks and object orientation in TwinCAT
- [robotics] Safety PLCs and TwinSAFE: functional safety from risk assessment to SIL and PL
- [robotics] Industrial metal additive manufacturing: laser powder bed fusion, DED and where each pays
- [robotics] Servo tuning from first principles: current, velocity and position loops
- [robotics] Machine vision for robot guidance: calibration, hand-eye and accuracy budgets
- [robotics] Lean supply chains for low-volume engineering: lead times, dual sourcing and buffers
- [robotics] Welding and fabrication automation: cobots, seam tracking and fixturing

### SaaS & requirements
- [saas] Writing good requirements: ISO/IEC/IEEE 29148 and the INCOSE rules
- [saas] Compliance frameworks that need requirements traceability: DO-178C, ISO 26262, IEC 61508, EN 50128
- [saas] SaaS metrics that matter early: activation, retention cohorts, churn and net revenue retention
- [saas] Running production on Railway: services, volumes, private networking, scaling and cost
- [saas] Agentic workflows for project management: what to automate, where humans must stay in the loop
- [saas] Multi-tenant SaaS architecture: isolation, data residency and noisy neighbours

### Maker & home automation
- [maker] CODESYS on a Raspberry Pi: a real PLC runtime at home
- [maker] Hobby CNC rigidity and chatter: what really limits a desktop machine
- [maker] Klipper, input shaping and pressure advance: faster 3D printing explained
- [maker] Home Assistant and ESPHome: sensors and automations that are worth it
- [maker] Closed-loop steppers versus servos on a hobby machine

### Tools & materials market
- [market] Rare earth magnets and motor prices: neodymium, China and what changed
- [market] How shipping costs and tariffs reach the price of a hobby machine in the UK
- [market] The desktop manufacturing market: who buys, what's growing, and why
- [market] Copper and steel prices: what they do to motors, cables and machine frames

## Taught

## Skipped
`;

// ---------- topics.md ----------

export interface Suggestion {
  track: TrackId;
  title: string;
  why: string;
}

/** `- [track] Title: why` (the colon or a dash before the why is optional). Pure. */
export function parseTopicLine(line: string): Suggestion | null {
  const m = /^\s*[-*]\s+\[([a-z-]+)\]\s+(.+?)\s*$/i.exec(line);
  if (!m) return null;
  const rest = m[2]!;
  const split = /^(.+?)(?::\s+|\s+[—–-]\s+)(.+)$/.exec(rest);
  const title = (split ? split[1]! : rest).trim();
  if (!title || /^\d{4}-\d{2}-\d{2}$/.test(title)) return null;
  return { track: trackOf(m[1]), title, why: split ? split[2]!.trim() : "" };
}

/** The Requested and Up next topics, and how many are taught. Pure. */
export function parseTopics(body: string): { requested: Suggestion[]; fromWork: Suggestion[]; upNext: Suggestion[]; backlog: number; taught: number } {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const sections = new Map<string, string[]>();
  for (const part of text.split(/^##\s+/m).slice(1)) {
    const [heading = "", ...lines] = part.split("\n");
    sections.set(heading.trim().toLowerCase(), lines);
  }
  const items = (name: string) => (sections.get(name) ?? []).map(parseTopicLine).filter((s): s is Suggestion => s !== null);
  return {
    requested: items("requested"),
    fromWork: items("from your work"),
    upNext: items("up next"),
    backlog: items("backlog").length,
    taught: (sections.get("taught") ?? []).filter((l) => /^\s*[-*]\s+\S/.test(l)).length,
  };
}

/** Adds a topic under "## Requested" (creating the section, or the map, if need be). Pure. */
export function addRequested(body: string | null, s: Suggestion): string {
  return addToSection(body ?? TOPICS_TEMPLATE, "Requested", `- [${s.track}] ${s.title}${s.why ? `: ${s.why}` : ""}`);
}

/**
 * Skips a topic: takes it out of Requested, From your work, Up next and the Backlog (matching
 * its title, any case), and lists it under "## Skipped", so the coach never writes it. Pure.
 */
export function skipTopic(body: string | null, s: { track: TrackId; title: string }, note: string): string {
  const want = topicKey(s.title);
  const { body: kept } = dropOpen(body ?? TOPICS_TEMPLATE, (t) => topicKey(t.title) === want);
  return addToSection(kept, "Skipped", `- [${s.track}] ${s.title.trim()} (${note})`);
}

/** How topic titles are compared: case, punctuation and spacing don't count. */
export const topicKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const OPEN_SECTIONS = ["requested", "from your work", "up next", "backlog"];

/** Takes lines out of the open sections (Requested, From your work, Up next, Backlog) where `drop(topic, section)` says so. Pure. */
function dropOpen(body: string, drop: (s: Suggestion, section: string) => boolean): { body: string; dropped: Suggestion[] } {
  let section = "";
  const dropped: Suggestion[] = [];
  const kept = body.split("\n").filter((l) => {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) section = h[1]!.toLowerCase();
    if (!OPEN_SECTIONS.includes(section)) return true;
    const s = parseTopicLine(l);
    if (!s || !drop(s, section)) return true;
    dropped.push(s);
    return false;
  });
  return { body: kept.join("\n"), dropped };
}

/**
 * Files a topic asked for from the app: under Requested once, and out of From your work, Up next
 * and the Backlog, so there's one copy for the lesson to clear. Pure.
 */
export function requestTopic(body: string | null, s: Suggestion): string {
  const want = topicKey(s.title);
  const { body: rest } = dropOpen(body ?? TOPICS_TEMPLATE, (t, section) => section !== "requested" && topicKey(t.title) === want);
  const already = parseTopics(rest).requested.some((t) => topicKey(t.title) === want);
  return already ? rest : addRequested(rest, s);
}

/**
 * Settles the map against the lessons already written: a topic still open (Requested, From your
 * work, Up next, Backlog) whose title matches a lesson's `topic` or title comes out, and goes
 * under Taught if that lesson isn't listed there. The coach does this itself, but several lessons
 * written at once each rewrite the whole map from the copy they read first, so one undoes
 * another's; this puts it right. Null when nothing changes. Pure.
 */
export function settleTopics(body: string, lessons: Pick<Lesson, "path" | "title" | "topic" | "track" | "created">[]): string | null {
  const written = new Map<string, Pick<Lesson, "path" | "title" | "topic" | "track" | "created">>();
  for (const l of lessons) {
    for (const t of [l.topic, l.title]) if (t && topicKey(t) && !written.has(topicKey(t))) written.set(topicKey(t), l);
  }
  const { body: rest, dropped } = dropOpen(body, (s) => written.has(topicKey(s.title)));
  if (dropped.length === 0) return null;
  let next = rest;
  for (const s of dropped) {
    const l = written.get(topicKey(s.title))!;
    if (next.includes(l.path)) continue;
    next = addToSection(next, "Taught", `- ${l.created} [${l.track}] ${l.title} → ${l.path}`);
  }
  return next;
}

/** Adds a line at the end of a "## <name>" section's list, creating the section if need be. Pure. */
function addToSection(body: string, name: string, line: string): string {
  const base = body;
  const lines = base.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, "i").test(l));
  if (at === -1) return `${base.trimEnd()}\n\n## ${name}\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  // After the last item of the section (or straight under the heading).
  let insert = at + 1;
  for (let i = at + 1; i < end; i++) if (/^\s*[-*]\s+/.test(lines[i]!)) insert = i + 1;
  lines.splice(insert, 0, line);
  return lines.join("\n");
}

// ---------- lessons ----------

export type CompletionMode = "read" | "listen";

export interface Lesson {
  path: string;
  title: string;
  track: TrackId;
  topic: string;
  summary: string;
  /**
   * "skipped": Dave doesn't want it; off To do, Converse and the recorder, and not counted.
   * "preparing": a draft still going through the release checks (learning-release.ts).
   */
  status: "ready" | "done" | "skipped" | "preparing";
  /** The skill-tree skill it teaches (learning-skills.ts), if it says. */
  skill: string;
  /** What the release checks couldn't settle before it went out (learning-release.ts). */
  openIssues?: string[];
  /** YYYY-MM-DD the lesson was written for. */
  created: string;
  /** ISO time it was marked done. */
  completedAt: string | null;
  completedMode: CompletionMode | null;
  /** Minutes credited for it (what Dave spent, or the lesson's length). */
  minutesSpent: number | null;
  rating: number | null;
  words: number;
  listenMinutes: number;
  readMinutes: number;
  /** The narrated recording (learning-audio.ts), once made. */
  audio: LessonAudio | null;
  /** Where Dave got to, listening and reading (LessonProgress), when he has started it. */
  progress?: Progress | null;
  /** How far through it is, 0-100: 100 once done, else the further of listened and read. */
  percent?: number;
}

/** How far through a lesson Dave is, 0-100. Pure. */
export function lessonPercent(lesson: Pick<Lesson, "status" | "audio">, progress: Progress | null | undefined): number {
  if (lesson.status === "done") return 100;
  if (!progress) return 0;
  const listened = progress.audioSeconds !== null && lesson.audio?.seconds ? progress.audioSeconds / lesson.audio.seconds : 0;
  const read = progress.readPart !== null && progress.readTotal ? (progress.readPart + 1) / progress.readTotal : 0;
  // Not 100 until it's marked done (the end of the recording does that).
  return Math.min(99, Math.round(Math.max(listened, read) * 100));
}

/** Where Dave got to in a lesson: the recording's position and the paragraph (part) he read to. */
export interface Progress {
  audioSeconds: number | null;
  audioAt: string | null;
  readPart: number | null;
  /** The lesson's number of spoken parts when the reading place was saved. */
  readTotal: number | null;
  readAt: string | null;
}

/**
 * Whether Dave is listening to a lesson right now, on any device: the app says so while one plays
 * (and every 30 s), and it lapses 90 s after the last word, so a closed tab or a dead phone doesn't
 * keep notifications quiet.
 */
export class ListeningPresence {
  private until = 0;
  constructor(private readonly now: () => number = Date.now, private readonly graceMs = 90_000) {}
  set(playing: boolean): void {
    this.until = playing ? this.now() + this.graceMs : 0;
  }
  get active(): boolean {
    return this.now() < this.until;
  }
}

/** Each lesson's place, kept in Postgres (written every few seconds while listening, so not the brain). */
export class LessonProgress {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  private static row(r: { audio_seconds: number | null; audio_at: Date | null; read_part: number | null; read_total?: number | null; read_at: Date | null }): Progress {
    return {
      audioSeconds: r.audio_seconds === null ? null : Number(r.audio_seconds),
      audioAt: r.audio_at ? new Date(r.audio_at).toISOString() : null,
      readPart: r.read_part,
      readTotal: r.read_total ?? null,
      readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    };
  }

  async get(path: string): Promise<Progress | null> {
    const { rows } = await this.pool.query("select * from lesson_progress where path = $1", [path]);
    return rows[0] ? LessonProgress.row(rows[0]) : null;
  }

  async all(): Promise<Map<string, Progress>> {
    const { rows } = await this.pool.query("select * from lesson_progress");
    return new Map(rows.map((r) => [r.path as string, LessonProgress.row(r)]));
  }

  /** Saves the listening place and/or the reading place (each stamped now). */
  async set(path: string, patch: { audioSeconds?: number; readPart?: number; readTotal?: number }, now = new Date()): Promise<Progress> {
    const { rows } = await this.pool.query(
      `insert into lesson_progress (path, audio_seconds, audio_at, read_part, read_total, read_at)
       values ($1, $2::real, case when $2::real is null then null else $4::timestamptz end, $3::int, $5::int, case when $3::int is null then null else $4::timestamptz end)
       on conflict (path) do update set
         audio_seconds = coalesce(excluded.audio_seconds, lesson_progress.audio_seconds),
         audio_at = coalesce(excluded.audio_at, lesson_progress.audio_at),
         read_part = coalesce(excluded.read_part, lesson_progress.read_part),
         read_total = coalesce(excluded.read_total, lesson_progress.read_total),
         read_at = coalesce(excluded.read_at, lesson_progress.read_at)
       returning *`,
      [path, patch.audioSeconds ?? null, patch.readPart ?? null, now, patch.readTotal ?? null],
    );
    return LessonProgress.row(rows[0]);
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const dayOf = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
};

/** A lesson from a note under learning/lessons/ (null for anything else, e.g. a README). Pure. */
export function lessonOf(note: Pick<NoteSummary, "path" | "title" | "frontmatter" | "words" | "updatedAt">): Lesson | null {
  const fm = note.frontmatter;
  if (!note.path.startsWith(LESSONS_FOLDER) || (fm.type !== undefined && fm.type !== "lesson")) return null;
  const words = Math.max(0, note.words);
  const listen = Math.max(1, Math.round(words / LISTEN_WPM));
  const stated = num(fm.minutes);
  const done = fm.status === "done";
  const mode = fm.completed_mode === "read" || fm.completed_mode === "listen" ? fm.completed_mode : null;
  const rating = num(fm.rating);
  const a = fm.audio as LessonAudio | undefined;
  const audio = a && typeof a === "object" && typeof a.url === "string" && typeof a.seconds === "number" ? a : null;
  return {
    path: note.path,
    title: note.title,
    track: trackOf(fm.track),
    topic: str(fm.topic),
    summary: str(fm.summary),
    status: done ? "done" : fm.status === "skipped" ? "skipped" : fm.status === "draft" ? "preparing" : "ready",
    skill: str(fm.skill),
    ...(Array.isArray(fm.open_issues) && fm.open_issues.length ? { openIssues: fm.open_issues.map(String).slice(0, 10) } : {}),
    created: dayOf(fm.created) || /(\d{4}-\d{2}-\d{2})/.exec(note.path)?.[1] || note.updatedAt.slice(0, 10),
    completedAt: done ? str(fm.completed) || note.updatedAt : null,
    completedMode: done ? mode : null,
    minutesSpent: done ? (num(fm.minutes_spent) ?? stated ?? listen) : null,
    rating: done && rating !== null && rating >= 1 && rating <= 5 ? Math.round(rating) : null,
    words,
    listenMinutes: audio ? Math.max(1, Math.round(audio.seconds / 60)) : listen,
    // Reading the text, plus the Try it exercise and the quiz.
    readMinutes: stated ?? Math.max(1, Math.round(words / READ_WPM + 8)),
    audio,
  };
}

// ---------- scoreboard ----------

export interface LearningStats {
  completed: number;
  minutes: number;
  ready: number;
  read: number;
  listened: number;
  /** Days in a row with a lesson done, up to today (or yesterday, while today's isn't done yet). */
  streak: number;
  bestStreak: number;
  doneToday: boolean;
  thisWeek: number;
  /** Lessons done per track, every track listed. */
  byTrack: { track: TrackId; name: string; completed: number; minutes: number }[];
  /** The last 12 weeks, oldest first: Monday's date, lessons and minutes. */
  weeks: { start: string; completed: number; minutes: number }[];
  averageRating: number | null;
  badges: { id: string; label: string; earned: boolean; detail: string }[];
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The scoreboard, from the lessons. Days are local to `timeZone`. Pure. */
export function learningStats(lessons: Lesson[], now: Date, timeZone: string): LearningStats {
  const done = lessons.filter((l) => l.status === "done" && l.completedAt);
  const dayDone = (l: Lesson) => localDay(new Date(l.completedAt!), timeZone);
  const days = new Set(done.map(dayDone));
  const today = localDay(now, timeZone);

  let streak = 0;
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streak++;
  let bestStreak = 0;
  for (const d of days) {
    if (days.has(addDays(d, -1))) continue; // not the start of a run
    let run = 0;
    for (let x = d; days.has(x); x = addDays(x, 1)) run++;
    bestStreak = Math.max(bestStreak, run);
  }

  const minutes = done.reduce((sum, l) => sum + (l.minutesSpent ?? 0), 0);
  const thisMonday = mondayOf(today);
  const weeks = Array.from({ length: 12 }, (_, i) => ({ start: addDays(thisMonday, (i - 11) * 7), completed: 0, minutes: 0 }));
  for (const l of done) {
    const w = weeks.find((x) => x.start === mondayOf(dayDone(l)));
    if (w) {
      w.completed++;
      w.minutes += l.minutesSpent ?? 0;
    }
  }
  const byTrack = LEARNING_TRACKS.map((t) => {
    const mine = done.filter((l) => l.track === t.id);
    return { track: t.id, name: t.name, completed: mine.length, minutes: mine.reduce((s, l) => s + (l.minutesSpent ?? 0), 0) };
  });
  const rated = done.filter((l) => l.rating !== null);
  const tracksDone = byTrack.filter((t) => t.track !== "interest" && t.completed > 0).length;
  const coreTracks = LEARNING_TRACKS.length - 1;
  const badges = [
    { id: "first", label: "First lesson", earned: done.length >= 1, detail: "Finish a lesson" },
    { id: "week", label: "Week streak", earned: bestStreak >= 7, detail: "7 days in a row" },
    { id: "ten", label: "Ten lessons", earned: done.length >= 10, detail: `${Math.min(done.length, 10)}/10 lessons` },
    { id: "all-tracks", label: "All-rounder", earned: tracksDone >= coreTracks, detail: `${tracksDone}/${coreTracks} tracks` },
    { id: "ten-hours", label: "Ten hours", earned: minutes >= 600, detail: `${Math.floor(minutes / 60)}/10 hours` },
    { id: "month", label: "Month streak", earned: bestStreak >= 30, detail: "30 days in a row" },
  ];
  return {
    completed: done.length,
    minutes,
    ready: lessons.filter((l) => l.status === "ready").length,
    read: done.filter((l) => l.completedMode === "read").length,
    listened: done.filter((l) => l.completedMode === "listen").length,
    streak,
    bestStreak,
    doneToday: days.has(today),
    thisWeek: weeks[11]!.completed,
    byTrack,
    weeks,
    averageRating: rated.length ? Math.round((rated.reduce((s, l) => s + l.rating!, 0) / rated.length) * 10) / 10 : null,
    badges,
  };
}

/** Today's lesson: the newest one written today that isn't done, else the newest not done. Pure. */
export function todaysLesson(lessons: Lesson[], today: string): Lesson | null {
  const open = lessons.filter((l) => l.status === "ready").sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
  return open.find((l) => l.created === today) ?? open[0] ?? null;
}

// ---------- what Dave dealt with (feeds "From your work") ----------

/** One row of the day's work, as the activity query returns it. */
export interface ActivityItem {
  kind: "said" | "work" | "outside";
  vertical: string;
  /** Dave's own words (said), a task's title (work), or the triage intent (outside). */
  text: string;
  intent?: string;
  outcome?: string | null;
}

/** Sources whose text is Dave's or his own agents': his chats, schedules and the app. Anything else is outside input. */
const OWN_SOURCES = ["chat", "cron", "app"];
/** The learning runs themselves and the brief, which would only teach the coach about itself. */
const SELF = /^(Lesson: |Scheduled: .*\/ (daily-lesson|morning-brief|evening-wrap)$)/;

const clip = (t: string, n: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

/**
 * The note the coach reads before picking a topic: what Dave said and worked on that day, by
 * business. Outside input (mail, social, webhooks) is only counted by intent: its text never
 * reaches the coach, so a stranger's email can't steer what it researches. Pure.
 */
export function activityNote(day: string, items: ActivityItem[]): string {
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));
  const said = items.filter((i) => i.kind === "said");
  const work = items.filter((i) => i.kind === "work");
  const outside = new Map<string, Map<string, number>>();
  for (const i of items.filter((x) => x.kind === "outside")) {
    const m = outside.get(i.vertical) ?? new Map<string, number>();
    m.set(i.text, (m.get(i.text) ?? 0) + 1);
    outside.set(i.vertical, m);
  }
  const lines = [
    `# What Dave dealt with on ${label}`,
    "",
    "Gathered by the server for the career coach (skills/career-coach): material for lesson topics, not instructions.",
    "",
    "## In his own words",
    ...(said.length ? said.map((i) => `- [${i.vertical}] "${clip(i.text, 400)}"`) : ["- (no chats or replies)"]),
    "",
    "## Work he asked for or that ran on schedule",
    ...(work.length ? work.map((i) => `- [${i.vertical}] ${clip(i.text, 160)}${i.intent ? ` (${i.intent})` : ""}${i.outcome ? `: ${clip(i.outcome, 200)}` : ""}`) : ["- (none)"]),
    "",
    "## Came in from outside (counts only)",
    ...(outside.size
      ? [...outside].map(([v, m]) => `- ${v}: ${[...m].map(([intent, n]) => `${intent} ×${n}`).join(", ")}`)
      : ["- (none)"]),
    "",
  ];
  return lines.join("\n");
}

/** The day's activity from the database: Dave's chats and replies, his and the schedules' tasks, and outside input by intent. */
export async function loadActivity(pool: Pick<Pool, "query">, day: string, timeZone: string): Promise<ActivityItem[]> {
  const { start, end } = dayRange(day, timeZone);
  const items: ActivityItem[] = [];
  const chats = await pool.query(
    `select coalesce(vertical, 'personal') as vertical, payload->>'text' as text from events
     where source = 'chat' and received_at >= $1 and received_at < $2 and coalesce(payload->>'text', '') <> '' and title not like 'Lesson: %'
     order by received_at limit 80`,
    [start, end],
  );
  const replies = await pool.query(
    `select t.vertical, r.text from task_replies r join tasks t on t.id = r.task_id
     where r.created_at >= $1 and r.created_at < $2 order by r.created_at limit 80`,
    [start, end],
  );
  for (const r of [...chats.rows, ...replies.rows]) items.push({ kind: "said", vertical: r.vertical, text: r.text });
  const tasks = await pool.query(
    `select t.vertical, t.intent, e.source, e.title,
       (select r.result from agent_runs r where r.task_id = t.id and r.result is not null order by r.started_at desc limit 1) as result
     from tasks t join events e on e.id = t.event_id
     where t.created_at >= $1 and t.created_at < $2 and t.status <> 'dropped'
     order by t.created_at limit 300`,
    [start, end],
  );
  for (const t of tasks.rows) {
    if (OWN_SOURCES.includes(t.source)) {
      if (t.source === "chat" || SELF.test(t.title)) continue; // chats are already in his own words
      const outcome = typeof t.result === "string" ? t.result.split("\n").find((l: string) => l.trim()) ?? null : null;
      items.push({ kind: "work", vertical: t.vertical, text: t.title, intent: t.intent, outcome });
    } else items.push({ kind: "outside", vertical: t.vertical, text: `${t.source} ${t.intent}` });
  }
  return items;
}

/**
 * Writes learning/activity/<day>.md for the day before `now`, once; called as the daily lesson
 * fires, so the coach can mine it. A day with nothing in it writes nothing.
 */
export async function writeActivityNote(brain: Pick<Brain, "read" | "write">, pool: Pick<Pool, "query">, now: Date, timeZone: string): Promise<string | null> {
  const today = localDay(now, timeZone);
  const day = new Date(Date.parse(`${today}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const path = activityPath(day);
  if (await brain.read(path)) return path;
  const items = await loadActivity(pool, day, timeZone);
  if (!items.length) return null;
  await brain.write(path, { frontmatter: { type: "note", vertical: "personal", tags: ["learning", "activity"] }, body: activityNote(day, items) }, { author: "system", message: "learning: the day's activity for the coach" });
  return path;
}

// ---------- seeding ----------

/** Writes the README and the starter topic map once (a note deleted on purpose stays deleted). */
export async function seedLearning(brain: Brain, pool: Pick<Pool, "query">): Promise<void> {
  const seeds: [string, Frontmatter, string][] = [
    [README_PATH, { type: "playbook", vertical: "personal" }, README_BODY],
    [TOPICS_PATH, { type: "note", vertical: "personal", tags: ["learning"] }, TOPICS_TEMPLATE],
    [PRONUNCIATION_PATH, { type: "playbook", vertical: "personal", tags: ["learning"] }, PRONUNCIATION_TEMPLATE],
    [SKILL_TREE_PATH, { type: "note", vertical: "personal", tags: ["learning"] }, SKILL_TREE_TEMPLATE],
  ];
  for (const [path, frontmatter, body] of seeds) {
    try {
      const seen = await pool.query("select 1 from brain_note_versions where path = $1 limit 1", [path]);
      if (seen.rows.length) continue;
      await brain.write(path, { frontmatter, body }, { author: "system", message: "learning: starter notes", expectedVersion: 0 });
    } catch (err) {
      if (!(err instanceof BrainConflictError)) console.error(`[learning] seeding ${path}:`, (err as Error).message);
    }
  }
}

// ---------- API ----------

export interface LearningDeps {
  brain: Pick<PgBrain, "read" | "write" | "summaries" | "appendJournal">;
  pipeline: Pick<Pipeline, "ingest">;
  timeZone: string;
  /** Listening and reading places (absent: none kept). */
  progress?: Pick<LessonProgress, "get" | "set" | "all">;
  /** Whether a lesson is playing somewhere (notifications go quiet meanwhile). */
  listening?: Pick<ListeningPresence, "set" | "active">;
  /** Narrated recordings (learning-audio.ts); absent where recording is off (tests). */
  narration?: {
    recorder: Pick<LessonRecorder, "request" | "state">;
    narrator: () => Promise<string>;
    setNarrator: (voice: string) => Promise<void>;
    /** The pronunciation list, for the app's own (browser) voice. */
    lexicon?: () => Promise<Map<string, string>>;
  };
  /** Drafts going through the release checks (absent: none shown as being prepared). */
  prep?: Pick<PrepStore, "open">;
  now?: () => Date;
}

const LessonPath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith(LESSONS_FOLDER) && p.endsWith(".md") && !p.includes(".."), "not a lesson");

/** The prompt a lesson request from the Learning page hands the assistant. */
export function lessonRequestPrompt(topic: string, track: TrackId | null, skill: string | null = null): string {
  return [
    `Make me a learning lesson on: ${topic}${track ? ` (track: ${track})` : ""}.`,
    `Follow the career-coach skill: research it properly (reading every source in full, with research notes), and write the 30-minute lecture to learning/lessons/ with today's date and \`status: draft\`, with \`topic: ${topic}\` in its frontmatter exactly as written here${skill ? ` and \`skill: ${skill}\` (that skill in learning/skill-tree.md)` : " and the skill it teaches from learning/skill-tree.md (add the skill there first if it has none)"}. Update learning/topics.md (take it out of Requested and add it to Taught).`,
    "Other lessons may be being written at the same time, so read learning/topics.md again just before you write it, and change only this topic's lines.",
    "Reply in one or two lines: the title, the track, and that it's being checked and recorded and will appear in Learning when it's ready.",
  ].join(" ");
}

/** The prompt "New topics" on the Learning page hands the assistant. */
export function topicsRefreshPrompt(): string {
  return [
    "Give me some new learning topics to pick from.",
    "Follow the career-coach skill: look at the open skills in learning/skill-tree.md (what they build on is taught), what's new in each track (search the last week or two of news) and the recent notes in learning/activity/, then put five fresh topics under ## Up next in learning/topics.md, spread across tracks (at least two not AI), each as `- [track] Topic: why it's worth learning now`. Prefer open skills, with a timely angle; where a good topic has no skill, add one to the tree at the right level.",
    "None may already be in the map, Taught or Skipped, or be a near-copy of one. Move the topics that were in Up next to the top of their track's Backlog. Leave Requested, From your work, Taught and Skipped as they are.",
    "Read learning/topics.md just before you write it, and write it once.",
    "Reply in one line: the new topics.",
  ].join(" ");
}

export function learningRoutes(deps: LearningDeps) {
  const app = new Hono();
  const now = () => deps.now?.() ?? new Date();

  /**
   * Edits the topic map, only over the version just read (retrying if someone else saves in
   * between), so the app's edits never undo a lesson's. `edit` returns null to leave it be.
   */
  const editTopics = async (edit: (body: string | null) => string | null, author: string, message: string) => {
    for (let attempt = 0; ; attempt++) {
      const topics = await deps.brain.read(TOPICS_PATH);
      const body = edit(topics?.body ?? null);
      if (body === null || body === topics?.body) return;
      try {
        await deps.brain.write(TOPICS_PATH, { frontmatter: topics?.frontmatter ?? { type: "note", vertical: "personal", tags: ["learning"] }, body }, { author, message, expectedVersion: topics?.version ?? 0 });
        return;
      } catch (err) {
        if (!(err instanceof BrainConflictError) || attempt >= 3) throw err;
      }
    }
  };

  const lessons = async () =>
    (await deps.brain.summaries(LESSONS_FOLDER))
      .map(lessonOf)
      .filter((l): l is Lesson => l !== null)
      .sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));

  /** Everything the Learning page shows: tracks, lessons (newest first), suggestions, today's pick and the scoreboard. */
  app.get("/learning", async (c) => {
    const [all, places] = await Promise.all([lessons(), deps.progress?.all().catch(() => null) ?? null]);
    // Topics already written come off the list (and out of the map), however the map was saved.
    await editTopics((body) => (body === null ? null : settleTopics(body, all)), "system", "learning: topics already taught").catch(() => {});
    const topics = await deps.brain.read(TOPICS_PATH);
    for (const l of all) {
      if (places) l.progress = places.get(l.path) ?? null;
      l.percent = lessonPercent(l, l.progress);
    }
    const map = topics ? parseTopics(topics.body) : { requested: [], fromWork: [], upNext: [], backlog: 0, taught: 0 };
    const today = localDay(now(), deps.timeZone);
    // Drafts aren't lessons yet: they're listed as being prepared, with where they've got to.
    const released = all.filter((l) => l.status !== "preparing");
    const stages = new Map((await deps.prep?.open().catch(() => []))?.map((p) => [p.path, p]) ?? []);
    const preparing = all
      .filter((l) => l.status === "preparing")
      .map((l) => {
        const p = stages.get(l.path);
        const stage = p?.stage ?? "review";
        return { path: l.path, title: l.title, track: l.track, created: l.created, stage, label: STAGE_LABEL[stage], round: stage === "revising" ? p!.revisions : stage === "proofing" ? p!.proofs : 0 };
      });
    const tree = await deps.brain.read(SKILL_TREE_PATH).catch(() => null);
    return c.json({
      tracks: LEARNING_TRACKS,
      today,
      todays: todaysLesson(released, today),
      lessons: released,
      preparing,
      suggestions: { requested: map.requested, fromWork: map.fromWork, upNext: map.upNext, backlog: map.backlog },
      skillTree: tree ? skillTreeView(parseSkillTree(tree.body), all) : null,
      stats: learningStats(released, now(), deps.timeZone),
      topicsPath: TOPICS_PATH,
      narration: await narrationState(),
    });
  });

  const narrationState = async (): Promise<({ narrator: string } & RecorderState) | null> =>
    deps.narration ? { narrator: await deps.narration.narrator(), ...deps.narration.recorder.state() } : null;

  /** The narrator, and what the recorder is doing (the lesson page follows a recording's progress). */
  app.get("/learning/narration", async (c) => c.json(await narrationState()));

  /** Picks the narrator for recordings from now on: a voice id from /voice/voices, or "" for the server's default voice. */
  app.put("/learning/narrator", async (c) => {
    if (!deps.narration) return c.json({ error: "recording is off on this server" }, 400);
    const { voice } = z.object({ voice: z.string().max(120) }).parse(await c.req.json());
    await deps.narration.setNarrator(voice);
    return c.json(await narrationState());
  });

  /**
   * The pronunciation list as [term, how to say it] pairs, so the app's own voice (the browser's,
   * when the server's isn't used) says terms the same way as the server's.
   */
  app.get("/learning/pronunciation", async (c) => c.json({ entries: deps.narration?.lexicon ? [...(await deps.narration.lexicon())] : [] }));

  /** Records a lesson (again): after a new narrator, or a pronunciation fixed. */
  app.post("/learning/record", async (c) => {
    if (!deps.narration) return c.json({ error: "recording is off on this server" }, 400);
    const { path } = z.object({ path: LessonPath }).parse(await c.req.json());
    if (!(await deps.brain.read(path))) return c.json({ error: "no such lesson" }, 404);
    deps.narration.recorder.request(path);
    return c.json(await narrationState(), 202);
  });

  app.get("/learning/lesson", async (c) => {
    const path = LessonPath.parse(c.req.query("path"));
    const note = await deps.brain.read(path);
    if (!note) return c.json({ error: "no such lesson" }, 404);
    const words = note.body.trim() ? note.body.trim().split(/\s+/).length : 0;
    const lesson = lessonOf({ path: note.path, title: noteTitle(note), frontmatter: note.frontmatter, words, updatedAt: str(note.frontmatter.updated) || new Date().toISOString() });
    if (!lesson) return c.json({ error: "not a lesson" }, 400);
    return c.json({ lesson, body: note.body });
  });

  /** A lesson is playing (or stopped) on one of Dave's devices: notifications stay quiet while it plays. */
  app.put("/learning/listening", async (c) => {
    const { playing } = z.object({ playing: z.boolean() }).parse(await c.req.json());
    deps.listening?.set(playing);
    return c.json({ playing: deps.listening?.active ?? false });
  });

  /** Where Dave got to in a lesson, listening and reading. */
  app.get("/learning/progress", async (c) => {
    const path = LessonPath.parse(c.req.query("path"));
    return c.json((await deps.progress?.get(path)) ?? { audioSeconds: null, audioAt: null, readPart: null, readTotal: null, readAt: null });
  });

  /** Saves the listening place (seconds into the recording) and/or the reading place (a part index). */
  app.put("/learning/progress", async (c) => {
    const body = z
      .object({
        path: LessonPath,
        audioSeconds: z.number().min(0).max(24 * 3600).optional(),
        readPart: z.number().int().min(0).max(100_000).optional(),
        readTotal: z.number().int().min(1).max(100_000).optional(),
      })
      .parse(await c.req.json());
    if (!deps.progress) return c.json({ error: "progress isn't kept on this server" }, 400);
    return c.json(await deps.progress.set(body.path, { audioSeconds: body.audioSeconds, readPart: body.readPart, readTotal: body.readTotal }));
  });

  /** Marks a lesson done: how (read or listened), optionally the minutes spent and a 1-5 rating. */
  app.post("/learning/complete", async (c) => {
    const body = z
      .object({ path: LessonPath, mode: z.enum(["read", "listen"]), minutes: z.number().int().min(1).max(240).optional(), rating: z.number().int().min(1).max(5).optional() })
      .parse(await c.req.json());
    const note = await deps.brain.read(body.path);
    if (!note) return c.json({ error: "no such lesson" }, 404);
    const { updated: _u, ...fm } = note.frontmatter;
    const words = note.body.trim().split(/\s+/).length;
    const frontmatter: Frontmatter = {
      ...fm,
      status: "done",
      completed: now().toISOString(),
      completed_mode: body.mode,
      minutes_spent: body.minutes ?? num(fm.minutes) ?? Math.max(1, Math.round(words / LISTEN_WPM)),
      ...(body.rating ? { rating: body.rating } : {}),
    };
    await deps.brain.write(body.path, { frontmatter, body: note.body }, { author: "dave", message: `learning: ${body.mode === "listen" ? "listened to" : "read"} the lesson` });
    await deps.brain.appendJournal(`Learning: ${body.mode === "listen" ? "listened to" : "read"} "${noteTitle(note)}"`, { vertical: "personal" }).catch(() => {});
    return c.json({ ok: true });
  });

  /**
   * Skips a lesson Dave doesn't want to bother with: off To do, Converse and the recorder, not
   * counted on the scoreboard, and its topic listed under Skipped so the coach steers clear.
   */
  app.post("/learning/skip", async (c) => {
    const { path } = z.object({ path: LessonPath }).parse(await c.req.json());
    const note = await deps.brain.read(path);
    if (!note) return c.json({ error: "no such lesson" }, 404);
    const { updated: _u, ...fm } = note.frontmatter;
    const today = localDay(now(), deps.timeZone);
    await deps.brain.write(path, { frontmatter: { ...fm, status: "skipped", skipped: today }, body: note.body }, { author: "dave", message: "learning: skipped" });
    const title = typeof fm.topic === "string" && fm.topic ? fm.topic : noteTitle(note);
    await editTopics((t) => skipTopic(t, { track: trackOf(fm.track), title }, `skipped the lesson ${today}`), "dave", "learning: skipped a lesson").catch(() => {});
    return c.json({ ok: true });
  });

  /** Skips a suggested topic so it's never written (Pick another topic's Skip). */
  app.post("/learning/skip-topic", async (c) => {
    const body = z.object({ title: z.string().trim().min(2).max(300), track: z.string().optional() }).parse(await c.req.json());
    const today = localDay(now(), deps.timeZone);
    await editTopics((t) => skipTopic(t, { track: trackOf(body.track), title: body.title }, `skipped ${today}`), "dave", "learning: skipped a topic");
    return c.json({ ok: true });
  });

  /** Puts a lesson back to ready (marked done, or skipped, by mistake). */
  app.post("/learning/reopen", async (c) => {
    const { path } = z.object({ path: LessonPath }).parse(await c.req.json());
    const note = await deps.brain.read(path);
    if (!note) return c.json({ error: "no such lesson" }, 404);
    const { updated: _u, completed: _c, completed_mode: _m, minutes_spent: _s, rating: _r, skipped: _k, ...fm } = note.frontmatter;
    await deps.brain.write(path, { frontmatter: { ...fm, status: "ready" }, body: note.body }, { author: "dave", message: "learning: back to ready" });
    return c.json({ ok: true });
  });

  /**
   * Asks the coach for a lesson now. Adds the topic to Requested in the topic map (so it isn't
   * lost if the run fails), then hands the assistant a chat task to write it.
   */
  app.post("/learning/request", async (c) => {
    const body = z
      .object({ topic: z.string().trim().min(2).max(300), track: z.string().optional(), why: z.string().max(300).optional(), skill: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,80}$/i).optional() })
      .parse(await c.req.json());
    const track = body.track && TRACK_IDS.has(body.track) ? (body.track as TrackId) : null;
    const title = body.topic.replace(/\s+/g, " ");
    await editTopics((t) => requestTopic(t, { track: track ?? "interest", title, why: body.why ?? "" }), "dave", "learning: requested a topic");
    const result = await deps.pipeline.ingest({
      source: "chat",
      vertical: "personal",
      kind: "message",
      title: `Lesson: ${body.topic}`.slice(0, 120),
      payload: { text: lessonRequestPrompt(title, track, body.skill?.toLowerCase() ?? null) },
    });
    return c.json({ taskId: result?.task.id ?? null }, 201);
  });

  /** "New topics": asks the coach for a fresh Up next (Pick another topic). */
  app.post("/learning/suggest", async (c) => {
    const result = await deps.pipeline.ingest({
      source: "chat",
      vertical: "personal",
      kind: "message",
      title: "Learning: new topics",
      payload: { text: topicsRefreshPrompt() },
    });
    return c.json({ taskId: result?.task.id ?? null }, 201);
  });

  return app;
}
