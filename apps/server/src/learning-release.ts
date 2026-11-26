import { Readable } from "node:stream";
import type { Frontmatter, NoteSummary, PgBrain } from "@cc/brain";
import type { TaskStatus } from "@cc/core";
import type { Storage } from "@cc/storage";
import { CAPTION, lessonScript, readingOnly } from "@cc/voice/lesson";
import type { Pool } from "./db/pool";
import { LESSONS_FOLDER } from "./learning";
import { audioOf, type LessonAudio, type LessonRecorder, PRONUNCIATION_PATH } from "./learning-audio";
import type { Pipeline } from "./pipeline";

/**
 * The release desk: nothing the coach writes reaches Dave until it has been checked. The coach
 * saves a lesson as `status: draft`; this then, one step per sweep (the state lives in the
 * lesson_prep table, out of the coach's reach):
 *
 * 1. review: reads the draft against the house rules (reviewLesson: a lecture, not a chat; no
 *    talk of what was or wasn't read; enough sources, all in the research notes; every picture,
 *    diagram and table with a description a listener can follow; British spelling, which it puts
 *    right itself), and keeps any web pictures with the lesson's other files;
 * 2. revising: if anything's wrong, hands the coach the list and waits for the rewrite (twice at most);
 * 3. recording: has the narrator record it and listen back to every sentence;
 * 4. proofing: if words sounded off, has the coach fix learning/pronunciation.md, then records again
 *    (twice at most);
 * 5. released: `status: ready`, on the Learning page and in the brief.
 *
 * A draft never waits for ever: after MAX_HOURS it is released as it is, with what's still open
 * listed on it (`open_issues`).
 */

export const MAX_REVISIONS = 2;
export const MAX_PROOFS = 2;
export const MAX_HOURS = 8;
const HOUR = 3_600_000;
/** A spoken lesson's length in words (the narrator reads about 165 a minute: 30 minutes). */
export const MIN_WORDS = 4300;
export const MAX_WORDS = 6200;
export const MIN_SOURCES = 6;
export const MIN_SOURCE_SITES = 4;
export const MIN_FIGURES = 2;
/** A caption must say what the figure shows: at least this many words after its title. */
const MIN_CAPTION_WORDS = 8;

// ---------- British spelling (pure) ----------

const OUR_STEMS = ["colo", "favo", "behavio", "hono", "labo", "neighbo", "flavo", "harbo", "humo", "rumo", "vapo", "armo", "endeavo", "odo", "savo", "valo", "vigo", "rigo", "tumo", "clamo", "splendo", "parlo"];
const OUR_ENDINGS = ["", "s", "ed", "ing", "ings", "ful", "less", "able", "ite", "ites", "al", "hood", "hoods", "ly"];
const OUR = new Map<string, string>();
for (const stem of OUR_STEMS) for (const end of OUR_ENDINGS) OUR.set(`${stem}r${end}`, `${stem}ur${end}`);
// Kept as they are in British English too.
for (const w of ["honorary", "humorous", "vigorous", "rigorous", "laborious", "odorous", "valorous", "armory", "colorimeter", "colorimetry"]) OUR.delete(w);

/** American spelling → British, word by word (lower case). */
const WORDS: Record<string, string> = {
  center: "centre",
  centers: "centres",
  centered: "centred",
  centering: "centring",
  centerline: "centreline",
  centerpiece: "centrepiece",
  fiber: "fibre",
  fibers: "fibres",
  fiberglass: "fibreglass",
  liter: "litre",
  liters: "litres",
  milliliter: "millilitre",
  milliliters: "millilitres",
  millimeter: "millimetre",
  millimeters: "millimetres",
  centimeter: "centimetre",
  centimeters: "centimetres",
  kilometer: "kilometre",
  kilometers: "kilometres",
  nanometer: "nanometre",
  nanometers: "nanometres",
  theater: "theatre",
  theaters: "theatres",
  caliber: "calibre",
  somber: "sombre",
  meager: "meagre",
  specter: "spectre",
  luster: "lustre",
  modeling: "modelling",
  modeled: "modelled",
  modeler: "modeller",
  modelers: "modellers",
  traveling: "travelling",
  traveled: "travelled",
  traveler: "traveller",
  travelers: "travellers",
  labeling: "labelling",
  labeled: "labelled",
  canceled: "cancelled",
  canceling: "cancelling",
  signaling: "signalling",
  signaled: "signalled",
  fueled: "fuelled",
  fueling: "fuelling",
  leveled: "levelled",
  leveling: "levelling",
  totaled: "totalled",
  tunneling: "tunnelling",
  tunneled: "tunnelled",
  channeled: "channelled",
  channeling: "channelling",
  counselor: "counsellor",
  marvelous: "marvellous",
  jewelry: "jewellery",
  aluminum: "aluminium",
  gray: "grey",
  grayscale: "greyscale",
  catalog: "catalogue",
  catalogs: "catalogues",
  cataloged: "catalogued",
  analog: "analogue",
  mold: "mould",
  molds: "moulds",
  molded: "moulded",
  molding: "moulding",
  moldings: "mouldings",
  moldmaking: "mouldmaking",
  plow: "plough",
  airplane: "aeroplane",
  airplanes: "aeroplanes",
  artifact: "artefact",
  artifacts: "artefacts",
  skeptical: "sceptical",
  skeptic: "sceptic",
  skeptics: "sceptics",
  maneuver: "manoeuvre",
  maneuvers: "manoeuvres",
  maneuvered: "manoeuvred",
  maneuvering: "manoeuvring",
  maneuverable: "manoeuvrable",
  defense: "defence",
  offense: "offence",
  pretense: "pretence",
  math: "maths",
  gotten: "got",
  esthetic: "aesthetic",
  toward: "towards",
  afterward: "afterwards",
  fulfill: "fulfil",
  fulfillment: "fulfilment",
  enroll: "enrol",
  enrollment: "enrolment",
  installment: "instalment",
  installments: "instalments",
  skillful: "skilful",
  willful: "wilful",
  cozy: "cosy",
};

/** British for one lower-case word, or null when it's already right (or isn't a word we touch). */
function britishWord(w: string): string | null {
  const known = WORDS[w] ?? OUR.get(w);
  if (known) return known === w ? null : known;
  // -yze → -yse (analyse, paralyse, catalyse).
  let m = /^(.{2,}l)yz(e|es|ed|ing|er|ers)$/.exec(w);
  if (m) return `${m[1]}ys${m[2]}`;
  // -ize → -ise, but never "size", "seize", "prize", "capsize", "maize" and friends.
  m = /^(.{3,})iz(e|es|ed|ing|er|ers|ation|ations|able)$/.exec(w);
  if (m && !/^(?:re|over|down|up|out|under|super|cap|mid|full|king|life|pint|bite|as)s$/.test(m[1]!)) return `${m[1]}is${m[2]}`;
  return null;
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_US = new RegExp(`\\b(${MONTHS}) (\\d{1,2})(?:st|nd|rd|th)?(,? (\\d{4}))?\\b`, "g");
/** Text left alone: inline code, link targets, web addresses and anything quoted from a source. */
const PROTECTED = /(`[^`\n]*`|\]\([^)\n]*\)|https?:\/\/[^\s)]+|"[^"\n]*"|“[^”\n]*”)/;

/**
 * British spelling for a lesson's prose: colour, centre, analyse, organisation, modelling,
 * aluminium; "23 November 2026", not "November 23, 2026". Left alone: code, link addresses,
 * anything quoted, the source list, diagrams, and names (a capital past a sentence's start:
 * "Gray code", "Center for Security Studies"). Returns the text and what changed. Pure.
 */
export function britishSpelling(body: string): { body: string; changes: string[] } {
  const changes = new Map<string, string>();
  let fenced = false;
  let section = "";
  const out = body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) section = h[1]!;
    if (/^(sources|references|further reading)\b/i.test(section)) return line;
    const pattern = new RegExp(`${PROTECTED.source}|${DATE_US.source}|([A-Za-z][A-Za-z']*)`, "g");
    return line.replace(pattern, (match: string, guarded: string | undefined, month: string | undefined, day: string | undefined, yearPart: string | undefined, year: string | undefined, word: string | undefined, offset: number) => {
      if (guarded) return match;
      if (month) {
        const uk = `${day} ${month}${yearPart ? ` ${year}` : ""}`;
        changes.set(match, uk);
        return uk;
      }
      if (!word) return match;
      const lower = word.toLowerCase();
      // A capital past the first letter (OpenAI), or a capital mid-sentence, is a name.
      if (/[A-Z]/.test(word.slice(1))) return match;
      const before = line.slice(0, offset);
      const starts = /^[\s>#*_+\-\d.)]*$/.test(before) || /[.!?:]["')\]*_]*\s+$/.test(before);
      if (word[0] !== lower[0] && !starts) return match;
      const uk = britishWord(lower);
      if (!uk) return match;
      const fixed = word[0] !== lower[0] ? uk[0]!.toUpperCase() + uk.slice(1) : uk;
      changes.set(word, fixed);
      return fixed;
    });
  });
  return { body: out.join("\n"), changes: [...changes].map(([a, b]) => `${a} → ${b}`) };
}

// ---------- the review (pure) ----------

/**
 * Talk about the writer's own research, or its limits: a lecturer doesn't tell the class which
 * pages they couldn't open. Each is a sign the lesson leans on a source it never read.
 */
const RESEARCH_TALK: RegExp[] = [
  /\bI (?:only|just) (?:read|saw|skimmed|managed to (?:read|open|see))\b/i,
  /\bI (?:couldn'?t|could not|wasn'?t able to|was unable to|can'?t|cannot|am unable to) (?:access|read|open|load|see|view|verify|fetch|retrieve|get (?:past|through|at)|find (?:the|any) (?:full|details))\b/i,
  /\b(?:source|article|page|paper|report|site|document|story)s? (?:couldn'?t|could not|can'?t|cannot|wouldn'?t) (?:be )?(?:accessed|read|opened|retrieved|load(?:ed)?|open)\b/i,
  /\bpaywall(?:ed|s)?\b/i,
  /\b(?:headline|abstract|snippet|preview|excerpt)s? (?:only|alone)\b/i,
  /\bonly (?:the|its|their) (?:headline|abstract|snippet|preview|excerpt)s?\b/i,
  /\bbased (?:only |solely |purely )?on (?:the |its |a )?(?:headline|abstract|snippet|search results?|preview)\b/i,
  /\bas an AI\b|\bI'?m an AI\b|\bas a (?:large )?language model\b/i,
  /\bmy (?:training data|knowledge cut-?off)\b/i,
  /\bI (?:searched|googled|browsed|looked it up|fetched|tried to (?:read|open|access|find))\b/i,
  /\b(?:my|the) (?:web )?search(?:es)? (?:turned up|returned|found|didn'?t)\b/i,
  /\bI (?:don'?t|do not) (?:have (?:access|the full (?:text|article|paper))|know what (?:it|the article|the paper|the report) (?:says|said|contributes))\b/i,
  /\b(?:can'?t|cannot) tell you (?:exactly )?(?:what|how|whether) (?:it|the|this|that)\b/i,
];

/** The register of a chatbot, not a lecturer. */
const CHAT_TALK: RegExp[] = [
  /\bgreat question\b/i,
  /\bI hope (?:this|that) helps\b/i,
  /\blet me know\b/i,
  /\bhappy (?:learning|listening|reading|building|tinkering)\b/i,
  /\bfeel free to\b/i,
  /\b(?:I'?d|I would) be (?:happy|glad) to\b/i,
  /\blet'?s (?:dive|jump|get) (?:in|into|started)\b/i,
  /\bdive (?:in|into|deep)\b|\bdeep[- ]dive\b/i,
  /\bbuckle up\b|\bwithout further ado\b|\bgame[- ]changer\b|\bin today'?s fast[- ]paced\b/i,
  /\bdelve\b|\bdelving\b/i,
  /\bit'?s (?:important|worth) (?:to note|noting) that\b/i,
  /\bas your (?:coach|assistant)\b/i,
];

const EMOJI = /\p{Extended_Pictographic}/u;
const SEARCH_URL = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/\?|search\.yahoo\.com)/i;

const LINK = /\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s)<>\]]+)/g;
const linksIn = (text: string) => [...text.matchAll(LINK)].map((m) => (m[1] ?? m[2]!).replace(/[.,;:]+$/, ""));
const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
  } catch {
    return url;
  }
};
const normUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
const words = (text: string) => text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
const sentenceAround = (text: string, index: number) => {
  const start = Math.max(text.lastIndexOf(". ", index) + 2, 0);
  const end = text.indexOf(". ", index);
  const s = text.slice(start, end === -1 ? undefined : end + 1).trim();
  return s.length > 180 ? `${s.slice(0, 177)}…` : s;
};

export interface Review {
  /** What the coach has to put right, each a clear instruction. Empty: ready to record. */
  problems: string[];
  /** The text with British spelling (and nothing else) put right. */
  body: string;
  /** What britishSpelling changed ("color → colour"). */
  spelling: string[];
  /** The pictures on the web that it shows (to keep a copy of). */
  images: string[];
  words: number;
}

/**
 * Reads a draft against the house rules. `research` is the lesson's research note (its
 * `research:` frontmatter), or null if it has none. Pure.
 */
export function reviewLesson(note: { frontmatter: Frontmatter; body: string }, research: { body: string } | null): Review {
  const problems: string[] = [];
  const fm = note.frontmatter;
  const { body, changes } = britishSpelling(note.body);
  const script = lessonScript(body, typeof fm.title === "string" ? fm.title : undefined);

  // Frontmatter.
  for (const key of ["track", "topic", "title", "summary", "skill", "research"] as const) {
    if (typeof fm[key] !== "string" || !String(fm[key]).trim()) problems.push(`The frontmatter has no \`${key}:\`.`);
  }

  // Headings: a lecture's shape.
  const headings = script.blocks.filter((b) => b.heading === 2).map((b) => b.source.replace(/^##\s+/, "").trim());
  const has = (re: RegExp) => headings.some((h) => re.test(h));
  if (!has(/^introduction\b/i)) problems.push("It needs a `## Introduction` that says why the subject matters, what the listener will be able to do by the end, and the route through it.");
  if (!has(/^summary\b/i)) problems.push("It needs a `## Summary` that draws the lecture together.");
  if (!has(/^(self-test|quiz)\b/i)) problems.push("It needs a `## Self-test` (five questions, each answer straight after it).");
  if (!has(/^(exercises?|try it)\b/i)) problems.push("It needs an `## Exercises` section (for reading: a calculation, a snippet or something to look at on the bench).");
  if (!has(/^(further reading|sources|references)\b/i)) problems.push("It needs a `## Further reading` list of every source used.");
  const teaching = headings.filter((h) => !/^(introduction|summary|self-test|quiz|exercises?|try it|further reading|sources|references)\b/i.test(h));
  if (teaching.length < 4) problems.push(`It has ${teaching.length} teaching section${teaching.length === 1 ? "" : "s"} between the introduction and the summary; a lecture needs four to six.`);

  // Length of what is spoken (the self-test included; exercises and sources aren't read).
  const spoken = script.parts.map((p) => p.text).join(" ");
  const count = words(spoken);
  if (count < MIN_WORDS) problems.push(`The spoken lecture is about ${count} words: it needs ${MIN_WORDS} to ${MAX_WORDS} (about 30 minutes). Go deeper, with more worked examples, not padding.`);
  if (count > MAX_WORDS) problems.push(`The spoken lecture is about ${count} words: cut it to under ${MAX_WORDS} (about 30 minutes).`);

  // How it talks: the spoken text and the reading-only sections alike.
  let section = "";
  const prose: string[] = [];
  for (const b of script.blocks) {
    if (b.heading === 2) section = b.source.replace(/^##\s+/, "");
    if (b.figure && b.figure !== "caption") continue;
    if (/^\s*(```|~~~)/.test(b.source)) continue;
    if (/^(further reading|sources|references)\b/i.test(section)) continue;
    prose.push(b.source);
  }
  const text = prose.join("\n").replace(/\s+/g, " ");
  const quote = (re: RegExp) => {
    const m = re.exec(text);
    return m ? `"${sentenceAround(text, m.index)}"` : null;
  };
  for (const re of RESEARCH_TALK) {
    const q = quote(re);
    if (q) problems.push(`It talks about its own research or what couldn't be read: ${q}. A lecturer teaches what the sources say; never mention what wasn't read. Read that source in full, or replace it with one you can read, and rewrite the passage from what it actually says.`);
  }
  for (const re of CHAT_TALK) {
    const q = quote(re);
    if (q) problems.push(`It sounds like a chatbot, not a lecturer: ${q}. Rewrite it in the lecturer's voice (see the skill).`);
  }
  if (EMOJI.test(text)) problems.push("It has emoji: a lecture has none.");
  const bangs = (spoken.match(/!/g) ?? []).length;
  if (bangs > 2) problems.push(`It has ${bangs} exclamation marks: a lecturer's enthusiasm is in the material, not the punctuation. Keep two at most.`);

  // Figures: each picture, diagram and table has a caption a listener can follow.
  let figures = 0;
  section = "";
  script.blocks.forEach((b, i) => {
    if (b.heading === 2) section = b.source.replace(/^##\s+/, "");
    if (!b.figure || b.figure === "caption" || readingOnly(section)) return;
    figures++;
    const next = script.blocks[i + 1];
    const what = b.figure === "table" ? "table" : b.figure === "diagram" ? "diagram" : "picture";
    const first = b.source.split("\n").find((l) => l.trim() && !/^\s*```/.test(l))?.trim().slice(0, 60) ?? "";
    if (next?.figure !== "caption") {
      problems.push(`The ${what} in "${section}" (${first}) has no caption straight after it: add \`> **Figure N. Title.** What it shows\`, a sentence or two a listener can follow without seeing it.`);
      return;
    }
    const said = next.source.replace(/^\s*>\s?/gm, "").replace(/^\*\*[^*]+\*\*/, "");
    if (words(said) < MIN_CAPTION_WORDS) problems.push(`The caption "${next.source.replace(/^\s*>\s?/, "").slice(0, 80)}" doesn't say what the ${what} shows: describe it in a sentence or two for someone listening.`);
  });
  const orphanCaptions = script.blocks.filter((b, i) => b.figure === "caption" && !script.blocks[i - 1]?.figure);
  for (const c of orphanCaptions) problems.push(`The caption "${c.source.replace(/^\s*>\s?/, "").slice(0, 80)}" isn't straight after a picture, diagram or table.`);
  if (figures < MIN_FIGURES) problems.push(`It has ${figures} figure${figures === 1 ? "" : "s"}: draw at least ${MIN_FIGURES} (a diagram, a chart, a table or a picture) where they make the idea clearer, each with its caption.`);

  // Sources: wide, real, and all read (in the research notes).
  const sourcesBlock = (() => {
    const m = /^##\s+(?:further reading|sources|references)\b.*$/im.exec(body);
    if (!m) return "";
    const rest = body.slice(m.index + m[0].length);
    const end = rest.search(/^##\s/m);
    return end === -1 ? rest : rest.slice(0, end);
  })();
  const cited = [...new Set(linksIn(sourcesBlock))];
  const sites = new Set(cited.map(siteOf));
  if (cited.length < MIN_SOURCES || sites.size < MIN_SOURCE_SITES)
    problems.push(`Further reading lists ${cited.length} source${cited.length === 1 ? "" : "s"} from ${sites.size} site${sites.size === 1 ? "" : "s"}: use at least ${MIN_SOURCES} from at least ${MIN_SOURCE_SITES} different sites (primary sources first: standards bodies, makers' documentation, papers, official statistics, then the best trade press), each read in full.`);
  const searches = cited.filter((u) => SEARCH_URL.test(u));
  if (searches.length) problems.push(`Further reading cites a search page (${searches[0]}): cite the pages themselves.`);
  if (!research) problems.push("There are no research notes: write them (see the skill, \"Research\") and point `research:` at them.");
  else {
    const noted = new Set(linksIn(research.body).map(normUrl));
    const unread = cited.filter((u) => !noted.has(normUrl(u)));
    if (unread.length) problems.push(`These sources are cited but aren't in the research notes, so there's no sign they were read: ${unread.slice(0, 5).join(", ")}. Read each in full and note what it says, or drop it.`);
    if (noted.size >= 1 && words(research.body) / noted.size < 60) problems.push("The research notes are thin: for each source, note in your own words what it actually says (the facts, figures and arguments you used), at least a short paragraph each.");
  }

  const images = [...new Set([...body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!))];
  return { problems, body, spelling: changes, images, words: count };
}

// ---------- the state of each draft ----------

export type PrepStage = "review" | "revising" | "recording" | "proofing" | "released";

export interface Prep {
  path: string;
  stage: PrepStage;
  revisions: number;
  proofs: number;
  taskId: string | null;
  /** When the current recording was asked for (a recording made after it is the one to check). */
  requestedAt: string | null;
  problems: string[];
  flagged: { text: string; missing: string[]; heard: string }[];
  createdAt: string;
  updatedAt: string;
}

/** The lesson_prep table (migration 0029). */
export class PrepStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  private static row(r: Record<string, unknown>): Prep {
    return {
      path: r.path as string,
      stage: r.stage as PrepStage,
      revisions: Number(r.revisions),
      proofs: Number(r.proofs),
      taskId: (r.task_id as string | null) ?? null,
      requestedAt: r.requested_at ? new Date(r.requested_at as string).toISOString() : null,
      problems: (r.problems as string[]) ?? [],
      flagged: (r.flagged as Prep["flagged"]) ?? [],
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async get(path: string): Promise<Prep | null> {
    const { rows } = await this.pool.query("select * from lesson_prep where path = $1", [path]);
    return rows[0] ? PrepStore.row(rows[0]) : null;
  }

  async remove(path: string): Promise<void> {
    await this.pool.query("delete from lesson_prep where path = $1", [path]);
  }

  async open(): Promise<Prep[]> {
    const { rows } = await this.pool.query("select * from lesson_prep where stage <> 'released' order by created_at");
    return rows.map(PrepStore.row);
  }

  async save(p: Pick<Prep, "path" | "stage"> & Partial<Omit<Prep, "createdAt" | "updatedAt">>): Promise<Prep> {
    const { rows } = await this.pool.query(
      `insert into lesson_prep (path, stage, revisions, proofs, task_id, requested_at, problems, flagged)
       values ($1, $2, coalesce($3, 0), coalesce($4, 0), $5, $6, coalesce($7, '[]'::jsonb), coalesce($8, '[]'::jsonb))
       on conflict (path) do update set
         stage = excluded.stage,
         revisions = coalesce($3, lesson_prep.revisions),
         proofs = coalesce($4, lesson_prep.proofs),
         task_id = case when $9 then excluded.task_id else lesson_prep.task_id end,
         requested_at = case when $10 then excluded.requested_at else lesson_prep.requested_at end,
         problems = coalesce($7, lesson_prep.problems),
         flagged = coalesce($8, lesson_prep.flagged),
         updated_at = now()
       returning *`,
      [
        p.path,
        p.stage,
        p.revisions ?? null,
        p.proofs ?? null,
        p.taskId ?? null,
        p.requestedAt ?? null,
        p.problems ? JSON.stringify(p.problems) : null,
        p.flagged ? JSON.stringify(p.flagged) : null,
        "taskId" in p,
        "requestedAt" in p,
      ],
    );
    return PrepStore.row(rows[0]);
  }
}

// ---------- what the coach is asked to do ----------

export function revisePrompt(path: string, problems: string[]): string {
  return [
    `Revise the draft lecture at "${path}" before it is released. Follow the career-coach skill ("Revising a draft").`,
    "The release check found:",
    ...problems.map((p) => `- ${p}`),
    "Read the lesson and its research notes, put every point right (rewrite whole passages where needed, and research further, reading each new source in full, where a point is thin), and save the lesson again at the same path with `status: draft`, its research notes too if they changed. Never mention the check, the research or what you couldn't read in the lesson itself.",
    "Don't propose any action. Reply in one line: what you changed.",
  ].join("\n");
}

export function proofPrompt(path: string, title: string, flagged: Prep["flagged"]): string {
  return [
    `Pronunciation check for the draft lecture "${title}" (${path}), before it is released. Follow the career-coach skill ("Pronunciation").`,
    "The narrator recorded it and listened back; in these sentences it couldn't hear the words marked (what the voice was given → what was heard):",
    ...flagged.slice(0, 25).map((f) => `- "${f.text}" → heard "${f.heard}" (words: ${f.missing.join(", ")})`),
    `For each marked word, in "${PRONUNCIATION_PATH}": if a voice would say it wrong (a name, an acronym, jargon, a unit), add or improve its line under "## Say it like this" (\`- Term: how to say it\`, the British way); if it is ordinary English the recogniser simply misheard, list it under "## Heard fine" as \`- word\`. Take what you've dealt with out of "## To check". Write the note once. Don't change the lesson: it is recorded again from the same text.`,
    "Don't propose any action. Reply in one line: the terms you added.",
  ].join("\n");
}

// ---------- the desk ----------

export interface ReleaseDeps {
  brain: Pick<PgBrain, "read" | "write" | "summaries">;
  store: Pick<PrepStore, "get" | "save" | "remove" | "open">;
  pipeline: Pick<Pipeline, "ingest">;
  /** A task's status (the revision and pronunciation tasks), or null if there's no such task. */
  taskStatus: (id: string) => Promise<TaskStatus | null>;
  /** The narrator; absent (or unavailable) where lessons aren't recorded: they're released unrecorded. */
  recorder?: Pick<LessonRecorder, "request" | "state"> | null;
  /** Keeps a copy of a picture from the web with the lesson's files; absent: pictures stay linked. */
  keepImage?: (url: string) => Promise<string>;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * A lesson saved as ready that never went through the checks: recent (written in the last two
 * days), not recorded and not released by the desk. The coach is told to save drafts; this
 * catches one that didn't, so nothing reaches Dave unchecked. Older lessons are left as they are.
 */
export function skippedChecks(fm: Frontmatter, path: string, now: Date): boolean {
  if (fm.status !== "ready" || fm.released || audioOf(fm)) return false;
  const day = (typeof fm.created === "string" ? fm.created : /(\d{4}-\d{2}-\d{2})/.exec(path)?.[1] ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return now.getTime() - Date.parse(`${day}T00:00:00Z`) < 2 * 24 * HOUR;
}

const FINISHED: TaskStatus[] = ["done", "failed", "dropped", "awaiting_approval", "deferred"];
/** A recording that hasn't come back in this long has gone wrong. */
const RECORDING_HOURS = 3;

export class ReleaseDesk {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ReleaseDeps) {}

  private now = () => this.deps.now?.() ?? new Date();

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.sweep().catch((err) => this.deps.log?.(`[learning] release: ${(err as Error).message}`)), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Moves every draft on by a step. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const notes = await this.deps.brain.summaries(LESSONS_FOLDER);
      for (const n of notes) {
        if (!skippedChecks(n.frontmatter, n.path, this.now()) || (await this.deps.store.get(n.path))) continue;
        const note = await this.deps.brain.read(n.path);
        if (!note) continue;
        const { updated: _u, ...fm } = note.frontmatter;
        await this.deps.brain.write(n.path, { frontmatter: { ...fm, status: "draft" }, body: note.body }, { author: "system", message: "learning: saved as ready without the checks; back to draft" });
        n.frontmatter.status = "draft";
        this.deps.log?.(`[learning] ${n.path} was saved as ready without the checks: back to draft`);
      }
      const drafts = notes.filter((n) => n.frontmatter.status === "draft");
      for (const n of drafts) {
        try {
          await this.step(n);
        } catch (err) {
          this.deps.log?.(`[learning] release ${n.path}: ${(err as Error).message}`);
        }
      }
      // Released by hand (Dave or the coach set it ready), or the note's gone: nothing more to do.
      const live = new Set(drafts.map((n) => n.path));
      for (const p of await this.deps.store.open()) if (!live.has(p.path)) await this.deps.store.save({ path: p.path, stage: "released" });
    } finally {
      this.running = false;
    }
  }

  private recorderUp(): boolean {
    return Boolean(this.deps.recorder?.state().available);
  }

  private async step(n: Pick<NoteSummary, "path" | "frontmatter">): Promise<void> {
    const path = n.path;
    const prep = (await this.deps.store.get(path)) ?? (await this.deps.store.save({ path, stage: "review" }));
    if (prep.stage === "released") {
      // A draft saved again after its release (the coach rewrote it): check it afresh.
      await this.deps.store.remove(path);
      return this.review(path, await this.deps.store.save({ path, stage: "review" }));
    }
    if (this.now().getTime() - Date.parse(prep.createdAt) > MAX_HOURS * HOUR) return this.release(path, prep, "time");

    switch (prep.stage) {
      case "review":
        return this.review(path, prep);
      case "revising":
      case "proofing": {
        const status = prep.taskId ? await this.deps.taskStatus(prep.taskId) : null;
        if (status && !FINISHED.includes(status)) return;
        if (prep.stage === "revising") return this.review(path, prep);
        return this.record(path, prep);
      }
      case "recording": {
        if (!this.recorderUp()) return this.release(path, prep, "unrecorded");
        const audio = audioOf(n.frontmatter);
        if (audio && prep.requestedAt && Date.parse(audio.recorded) >= Date.parse(prep.requestedAt)) return this.listened(path, prep, audio);
        const state = this.deps.recorder!.state();
        const busy = state.current?.path === path || state.queued.includes(path);
        if (!busy && state.lastError?.path === path) return this.release(path, prep, "unrecorded");
        if (prep.requestedAt && this.now().getTime() - Date.parse(prep.requestedAt) > RECORDING_HOURS * HOUR) return this.release(path, prep, "unrecorded");
        if (!busy) this.deps.recorder!.request(path);
        return;
      }
    }
  }

  private async review(path: string, prep: Prep): Promise<void> {
    const note = await this.deps.brain.read(path);
    if (!note) return;
    const researchPath = typeof note.frontmatter.research === "string" ? note.frontmatter.research : null;
    const research = researchPath ? await this.deps.brain.read(researchPath).catch(() => null) : null;
    const r = reviewLesson(note, research);
    let body = r.body;
    // Pictures from the web are kept with the lesson's files: links rot, and the reading view shouldn't depend on them.
    if (this.deps.keepImage) {
      for (const url of r.images) {
        try {
          const kept = await this.deps.keepImage(url);
          body = body.split(`](${url})`).join(`](${kept})`);
        } catch (err) {
          r.problems.push(`The picture ${url} couldn't be loaded (${(err as Error).message}): use another (a direct link to the image file, ideally from Wikimedia Commons or the maker's own site) or draw it as a diagram.`);
        }
      }
    }
    if (body !== note.body) {
      const { updated: _u, ...fm } = note.frontmatter;
      await this.deps.brain.write(path, { frontmatter: fm, body }, { author: "system", message: `learning: release check${r.spelling.length ? ` (British spelling: ${r.spelling.slice(0, 5).join(", ")})` : ""}` });
    }
    if (r.problems.length && prep.revisions < MAX_REVISIONS) {
      const result = await this.deps.pipeline.ingest({ source: "chat", vertical: "personal", kind: "message", title: `Lesson check: ${String(note.frontmatter.title ?? path)}`.slice(0, 120), payload: { text: revisePrompt(path, r.problems), quiet: true } });
      await this.deps.store.save({ path, stage: "revising", revisions: prep.revisions + 1, taskId: result?.task.id ?? null, problems: r.problems });
      this.deps.log?.(`[learning] ${path}: ${r.problems.length} problem(s), back to the coach (round ${prep.revisions + 1})`);
      return;
    }
    await this.deps.store.save({ path, stage: "review", problems: r.problems });
    return this.record(path, { ...prep, problems: r.problems });
  }

  private async record(path: string, prep: Prep): Promise<void> {
    if (!this.recorderUp()) return this.release(path, prep, "unrecorded");
    const requestedAt = this.now().toISOString();
    await this.deps.store.save({ path, stage: "recording", requestedAt, taskId: null });
    this.deps.recorder!.request(path);
  }

  /** The recording is back: release it, or have the coach fix what sounded off and record again. */
  private async listened(path: string, prep: Prep, audio: LessonAudio): Promise<void> {
    if (audio.flagged.length && prep.proofs < MAX_PROOFS) {
      const note = await this.deps.brain.read(path);
      const title = String(note?.frontmatter.title ?? path);
      const result = await this.deps.pipeline.ingest({ source: "chat", vertical: "personal", kind: "message", title: `Lesson pronunciation: ${title}`.slice(0, 120), payload: { text: proofPrompt(path, title, audio.flagged), quiet: true } });
      await this.deps.store.save({ path, stage: "proofing", proofs: prep.proofs + 1, taskId: result?.task.id ?? null, flagged: audio.flagged });
      this.deps.log?.(`[learning] ${path}: ${audio.flagged.length} sentence(s) sounded off, to the coach (round ${prep.proofs + 1})`);
      return;
    }
    return this.release(path, { ...prep, flagged: audio.flagged }, "checked");
  }

  private async release(path: string, prep: Prep, why: "checked" | "unrecorded" | "time"): Promise<void> {
    const note = await this.deps.brain.read(path);
    if (!note) return;
    const audio = audioOf(note.frontmatter);
    const open = [
      ...prep.problems,
      ...(audio && audio.flagged.length ? [`${audio.flagged.length} sentence${audio.flagged.length === 1 ? "" : "s"} may still sound off in the recording.`] : []),
      ...(why === "time" ? [`Released after ${MAX_HOURS} hours of checks without finishing them.`] : []),
    ];
    const { updated: _u, open_issues: _o, ...fm } = note.frontmatter;
    await this.deps.brain.write(
      path,
      { frontmatter: { ...fm, status: "ready", released: this.now().toISOString(), ...(open.length ? { open_issues: open } : {}) }, body: note.body },
      { author: "system", message: `learning: released${why === "unrecorded" ? " (not recorded)" : why === "time" ? " (out of time)" : ""}` },
    );
    await this.deps.store.save({ path, stage: "released" });
    this.deps.log?.(`[learning] released ${path} (${why}${open.length ? `, ${open.length} open issue(s)` : ""})`);
  }
}

/** What Learning shows of a draft being prepared. */
export const STAGE_LABEL: Record<PrepStage, string> = {
  review: "Checking the draft",
  revising: "The coach is revising it",
  recording: "Being recorded",
  proofing: "Fixing pronunciation",
  released: "Ready",
};

/** Stores a picture from the web (for ReleaseDesk.keepImage): an image, under 8 MB, within 30 s. */
export function imageKeeper(storage: Pick<Storage, "put">, mediaUrl: (id: string) => string, fetchImpl: typeof fetch = fetch) {
  return async (url: string): Promise<string> => {
    const res = await fetchImpl(url, { headers: { "user-agent": "CommandCentre/1.0 (lesson figures)", accept: "image/*" }, signal: AbortSignal.timeout(30_000), redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(type)) throw new Error(`not a picture (${type || "unknown type"})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new Error("over 8 MB");
    const ext = type === "image/svg+xml" ? "svg" : type.split("/")[1]!.replace("jpeg", "jpg");
    const name = `${(new URL(url).pathname.split("/").pop() || "figure").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60)}.${ext}`;
    const blob = await storage.put(Readable.from(bytes), { name, contentType: type, folder: "media", vertical: "personal", size: bytes.length });
    return mediaUrl(blob.id);
  };
}
