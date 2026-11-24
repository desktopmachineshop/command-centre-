import type { TaskStatus } from "@cc/core";
import { describe, expect, it } from "vitest";
import type { LessonAudio, RecorderState } from "../src/learning-audio";
import { britishSpelling, MAX_PROOFS, MAX_REVISIONS, type Prep, ReleaseDesk, reviewLesson } from "../src/learning-release";
import { parseSkillTree, SKILL_TREE_TEMPLATE, skillTreeView } from "../src/learning-skills";

// ---------- a lecture that passes ----------

const para = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `The ${topic} works in a particular way, and the reason matters for engineers in practice. Consider case ${i + 1}, where the numbers show the effect clearly and the trade-off is plain to see.`).join(" ");
const SOURCES = ["https://www.beckhoff.com/a", "https://www.ethercat.org/b", "https://www.iec.ch/c", "https://en.wikipedia.org/d", "https://www.beckhoff.com/e", "https://www.controleng.com/f"];

function lecture(over: { intro?: string; extraSection?: string; figures?: string; sources?: string[]; frontmatter?: Record<string, unknown> } = {}) {
  const sections = ["Frames on the wire", "Distributed clocks", "Drift and correction", "Cabling and topology"]
    .map((h, i) => `## ${h}\n\n${para(h.toLowerCase(), 18)}\n\n${para("drive", 18)}\n\n${i === 0 ? (over.figures ?? FIGURES) : ""}`)
    .join("\n\n");
  const body = [
    "# How EtherCAT keeps axes in step",
    "",
    "## Introduction",
    "",
    over.intro ?? para("network", 12),
    "",
    sections,
    over.extraSection ?? "",
    "## Summary",
    "",
    para("summary", 3),
    "",
    "## Exercises",
    "",
    "Work out the cycle time for 100 drives.",
    "",
    "## Self-test",
    "",
    "1. What keeps the clocks in step?\n   **Answer:** The reference clock and the drift correction.",
    "",
    "## Further reading",
    "",
    ...(over.sources ?? SOURCES).map((u, i) => `- [Source ${i + 1}](${u}), publisher, 2026`),
  ].join("\n");
  return {
    frontmatter: { type: "lesson", track: "robotics", topic: "EtherCAT distributed clocks", title: "How EtherCAT keeps axes in step", summary: "One sentence.", skill: "rob.ethercat", research: "learning/research/x.md", status: "draft", ...over.frontmatter },
    body,
  };
}
const FIGURES = [
  "![Four drives on one cable](https://upload.wikimedia.org/four.png)",
  "",
  "> **Figure 1. One frame, four drives.** A cable runs through four drives in a line; the frame goes out through each and comes back.",
  "",
  "```mermaid",
  "flowchart LR",
  "  Master --> Drive1 --> Drive2",
  "```",
  "",
  "> **Figure 2. The frame's route.** The controller on the left sends one frame along a line of drives, each passing it on.",
].join("\n");
const research = (sources = SOURCES) => ({ body: sources.map((u) => `## ${u}\n\n${para("source", 3)}`).join("\n\n") });

describe("the release check (pure)", () => {
  it("passes a lecture that keeps the rules", () => {
    const r = reviewLesson(lecture(), research());
    expect(r.problems).toEqual([]);
    expect(r.words).toBeGreaterThan(4300);
    expect(r.images).toEqual(["https://upload.wikimedia.org/four.png"]);
  });

  it("catches talk of what wasn't read, and a chatbot's register", () => {
    const r = reviewLesson(lecture({ intro: `${para("network", 12)} I could only read the abstract of the paper, so I can't tell you what it adds. Great question! Let's dive in.` }), research());
    expect(r.problems.some((p) => p.includes("own research") && p.includes("abstract"))).toBe(true);
    expect(r.problems.some((p) => p.includes("chatbot") && p.includes("Great question"))).toBe(true);
    expect(r.problems.some((p) => p.includes("chatbot") && p.includes("dive in"))).toBe(true);
  });

  it("doesn't mistake engineering for research talk", () => {
    const r = reviewLesson(lecture({ intro: `${para("network", 12)} The controller couldn't access the bus until the header alone had passed, and the register cannot be read while it is busy.` }), research());
    expect(r.problems).toEqual([]);
  });

  it("wants a caption that describes each figure, and two figures at least", () => {
    const bare = reviewLesson(lecture({ figures: "![A drive](https://upload.wikimedia.org/a.png)\n\n| Bus | Cycle |\n| --- | --- |\n| EtherCAT | 100 µs |\n\n> **Table 1. Cycle times.**" }), research());
    expect(bare.problems.some((p) => p.includes("picture") && p.includes("no caption"))).toBe(true);
    expect(bare.problems.some((p) => p.includes("Table 1") && p.includes("doesn't say what"))).toBe(true);
    const none = reviewLesson(lecture({ figures: "" }), research());
    expect(none.problems.some((p) => p.includes("0 figures"))).toBe(true);
  });

  it("wants wide sources, every one in the research notes", () => {
    const narrow = reviewLesson(lecture({ sources: SOURCES.slice(0, 3) }), research());
    expect(narrow.problems.some((p) => p.includes("3 sources"))).toBe(true);
    const unread = reviewLesson(lecture(), research(SOURCES.slice(0, 4)));
    expect(unread.problems.some((p) => p.includes("aren't in the research notes") && p.includes("controleng.com"))).toBe(true);
    expect(reviewLesson(lecture(), null).problems.some((p) => p.includes("no research notes"))).toBe(true);
  });

  it("wants the lecture's shape and its frontmatter", () => {
    const r = reviewLesson({ frontmatter: { track: "ai" }, body: "# T\n\n## Body\n\nShort." }, research());
    for (const want of ["`topic:`", "`skill:`", "`research:`", "## Introduction", "## Summary", "## Self-test", "## Exercises", "## Further reading", "teaching section", "words"]) {
      expect(r.problems.some((p) => p.includes(want))).toBe(true);
    }
  });

  it("puts American spelling right in the prose, and leaves names, quotes, code and sources alone", () => {
    const { body, changes } = britishSpelling(
      [
        "The color of the fiber changes when we analyze it, organizing the data on November 23, 2026.",
        "Encoders use Gray code; the Center for Security Studies and OpenAI's tokenizer keep their names. Behavior matters; the mold is modeled in aluminum.",
        'He wrote "the color was off" and the size and prize stay; resize too, but emphasize changes.',
        "`colorize()` stays, as does [the page](https://example.com/color-center).",
        "```",
        "color = gray",
        "```",
        "## Further reading",
        "- [Fiber optics center](https://x.org), Organization, November 3, 2026",
      ].join("\n"),
    );
    expect(body).toContain("The colour of the fibre changes when we analyse it, organising the data on 23 November 2026.");
    expect(body).toContain("Encoders use Gray code; the Center for Security Studies and OpenAI's tokeniser keep their names. Behaviour matters; the mould is modelled in aluminium.");
    expect(body).toContain('He wrote "the color was off" and the size and prize stay; resize too, but emphasise changes.');
    expect(body).toContain("`colorize()` stays, as does [the page](https://example.com/color-center).");
    expect(body).toContain("color = gray");
    expect(body).toContain("- [Fiber optics center](https://x.org), Organization, November 3, 2026");
    expect(changes).toContain("color → colour");
  });
});

describe("the skill tree (pure)", () => {
  it("reads the starter tree: every track, levels in order, what each skill builds on", () => {
    const tree = parseSkillTree(SKILL_TREE_TEMPLATE);
    expect(tree.map((t) => t.track)).toEqual(["ai", "robotics", "saas", "maker", "market", "interest"]);
    const ai = tree[0]!;
    expect(ai.levels.map((l) => l.name)).toEqual(["Foundations", "Practitioner", "Advanced", "Expert"]);
    expect(ai.levels[1]!.skills.find((s) => s.id === "ai.rag")).toEqual({ id: "ai.rag", title: "Retrieval-augmented generation", why: "chunking, reranking and when it isn't the answer", needs: ["ai.embeddings", "ai.prompting"] });
    // Every skill a skill builds on is in the tree.
    const ids = new Set(tree.flatMap((t) => t.levels.flatMap((l) => l.skills.map((s) => s.id))));
    for (const t of tree) for (const l of t.levels) for (const s of l.skills) for (const n of s.needs) expect(ids.has(n), `${s.id} needs ${n}`).toBe(true);
  });

  it("works out what's done, taught, open and locked from the lessons", () => {
    const tree = parseSkillTree(SKILL_TREE_TEMPLATE);
    const view = skillTreeView(tree, [
      { path: "a.md", title: "LLMs", topic: "", skill: "ai.llm", status: "done" },
      // A lesson from before the tree, matched by its topic.
      { path: "b.md", title: "Something", topic: "Prompting and context engineering", skill: "", status: "ready" },
      { path: "c.md", title: "Skipped", topic: "", skill: "ai.embeddings", status: "skipped" },
    ]);
    const ai = view.tracks[0]!;
    const of = (id: string) => ai.levels.flatMap((l) => l.skills).find((s) => s.id === id)!;
    expect(of("ai.llm").status).toBe("done");
    expect(of("ai.prompting").status).toBe("taught");
    expect(of("ai.embeddings").status).toBe("open");
    expect(of("ai.tools").status).toBe("open");
    expect(of("ai.rag")).toMatchObject({ status: "locked", waitsOn: ["Embeddings and vector search"] });
    expect(ai).toMatchObject({ done: 1, taught: 2 });
  });
});

// ---------- the desk, with fakes ----------

class FakeBrain {
  notes = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();
  writes: string[] = [];
  async read(path: string) {
    const n = this.notes.get(path);
    return n ? { path, frontmatter: { ...n.frontmatter }, body: n.body, version: 1, updatedBy: "x", updatedAt: "" } : null;
  }
  async write(path: string, content: { frontmatter?: Record<string, unknown>; body: string }, opts?: { message?: string } | string) {
    this.notes.set(path, { frontmatter: content.frontmatter ?? {}, body: content.body });
    this.writes.push(typeof opts === "string" ? opts : (opts?.message ?? ""));
    return (await this.read(path))!;
  }
  async summaries(folder: string) {
    return [...this.notes].filter(([p]) => p.startsWith(folder)).map(([path, n]) => ({ path, title: "", frontmatter: n.frontmatter, words: 0, updatedAt: "" }));
  }
}

class FakeStore {
  rows = new Map<string, Prep>();
  constructor(private readonly now: () => Date) {}
  async get(path: string) {
    return this.rows.get(path) ?? null;
  }
  async remove(path: string) {
    this.rows.delete(path);
  }
  async open() {
    return [...this.rows.values()].filter((r) => r.stage !== "released");
  }
  async save(p: Partial<Prep> & Pick<Prep, "path" | "stage">) {
    const at = this.now().toISOString();
    const prev = this.rows.get(p.path) ?? { path: p.path, stage: p.stage, revisions: 0, proofs: 0, taskId: null, requestedAt: null, problems: [], flagged: [], createdAt: at, updatedAt: at };
    const next = { ...prev, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), updatedAt: at } as Prep;
    this.rows.set(p.path, next);
    return next;
  }
}

function setup(opts: { recorder?: boolean } = {}) {
  let clock = Date.parse("2026-11-24T05:40:00Z");
  const now = () => new Date(clock);
  const brain = new FakeBrain();
  const store = new FakeStore(now);
  const tasks = new Map<string, TaskStatus>();
  const prompts: string[] = [];
  let n = 0;
  const state: RecorderState = { available: true, reason: null, current: null, queued: [], lastError: null };
  const requested: string[] = [];
  const recorder = {
    state: () => state,
    request: (path: string) => {
      requested.push(path);
      state.queued.push(path);
    },
  };
  const desk = new ReleaseDesk({
    brain: brain as never,
    store,
    pipeline: {
      ingest: async (e: { payload: { text: string } }) => {
        prompts.push(e.payload.text);
        const id = `task-${++n}`;
        tasks.set(id, "running");
        return { task: { id } } as never;
      },
    } as never,
    taskStatus: async (id) => tasks.get(id) ?? null,
    recorder: opts.recorder === false ? null : recorder,
    keepImage: async (url) => `/media/${url.split("/").pop()}`,
    now,
  });
  /** The recorder finishes: the recording lands on the note. */
  const recorded = (path: string, flagged: LessonAudio["flagged"]) => {
    state.queued = state.queued.filter((p) => p !== path);
    const note = brain.notes.get(path)!;
    note.frontmatter.audio = { id: "a", url: "/media/a", voice: "v", seconds: 1800, chapters: [], recorded: now().toISOString(), checked: 300, flagged };
  };
  return { brain, store, desk, tasks, prompts, requested, recorded, tick: (ms: number) => (clock += ms) };
}

const PATH = "learning/lessons/2026-11-24-ethercat.md";

describe("the release desk", () => {
  it("records a clean draft, has what sounded off fixed, records again and releases it", async () => {
    const t = setup();
    t.brain.notes.set(PATH, lecture());
    t.brain.notes.set("learning/research/x.md", { frontmatter: {}, body: research().body });
    await t.desk.sweep();
    // The picture is kept with the lesson's files, and the draft goes to the recorder.
    expect(t.brain.notes.get(PATH)!.body).toContain("](/media/four.png)");
    expect(t.requested).toEqual([PATH]);
    expect((await t.store.get(PATH))!.stage).toBe("recording");

    t.tick(60_000);
    t.recorded(PATH, [{ text: "TwinCAT keeps time.", missing: ["twincat"], heard: "twin cut keeps time" }]);
    await t.desk.sweep();
    expect((await t.store.get(PATH))!.stage).toBe("proofing");
    expect(t.prompts.at(-1)).toContain('"TwinCAT keeps time." → heard "twin cut keeps time" (words: twincat)');
    expect(t.brain.notes.get(PATH)!.frontmatter.status).toBe("draft");

    // Waits for the coach, then records again.
    await t.desk.sweep();
    expect(t.requested).toHaveLength(1);
    t.tasks.set("task-1", "done");
    t.tick(60_000);
    await t.desk.sweep();
    expect(t.requested).toEqual([PATH, PATH]);
    t.tick(60_000);
    t.recorded(PATH, []);
    await t.desk.sweep();
    const note = t.brain.notes.get(PATH)!;
    expect(note.frontmatter.status).toBe("ready");
    expect(note.frontmatter.open_issues).toBeUndefined();
    expect((await t.store.get(PATH))!.stage).toBe("released");
  });

  it("sends a draft back to the coach, at most twice, then goes on with what's left listed on it", async () => {
    const t = setup({ recorder: false });
    t.brain.notes.set(PATH, lecture({ intro: `${para("network", 12)} Unfortunately the article was paywalled.` }));
    t.brain.notes.set("learning/research/x.md", { frontmatter: {}, body: research().body });
    for (let round = 1; round <= MAX_REVISIONS; round++) {
      await t.desk.sweep();
      expect((await t.store.get(PATH))!).toMatchObject({ stage: "revising", revisions: round });
      expect(t.prompts.at(-1)).toContain("paywalled");
      expect(t.prompts.at(-1)).toContain("`status: draft`");
      t.tasks.set(`task-${round}`, "done");
    }
    // Not recorded here (no narrator): released with the open problem on it.
    await t.desk.sweep();
    const note = t.brain.notes.get(PATH)!;
    expect(note.frontmatter.status).toBe("ready");
    expect(String(note.frontmatter.open_issues)).toContain("paywalled");
  });

  it("stops asking for pronunciation fixes after the last round", async () => {
    const t = setup();
    t.brain.notes.set(PATH, lecture({ figures: FIGURES.replace("![Four drives on one cable](https://upload.wikimedia.org/four.png)", "| A | B |\n| --- | --- |\n| 1 | 2 |") }));
    t.brain.notes.set("learning/research/x.md", { frontmatter: {}, body: research().body });
    await t.desk.sweep();
    for (let round = 1; round <= MAX_PROOFS; round++) {
      t.tick(60_000);
      t.recorded(PATH, [{ text: "x", missing: ["x"], heard: "y" }]);
      await t.desk.sweep();
      expect((await t.store.get(PATH))!).toMatchObject({ stage: "proofing", proofs: round });
      t.tasks.set(`task-${round}`, "done");
      t.tick(60_000);
      await t.desk.sweep();
    }
    t.tick(60_000);
    t.recorded(PATH, [{ text: "x", missing: ["x"], heard: "y" }]);
    await t.desk.sweep();
    expect(t.brain.notes.get(PATH)!.frontmatter.status).toBe("ready");
    expect(String(t.brain.notes.get(PATH)!.frontmatter.open_issues)).toContain("1 sentence may still sound off");
  });

  it("takes a new lesson saved as ready, without the checks, back to draft; leaves older ones be", async () => {
    const t = setup({ recorder: false });
    t.brain.notes.set(PATH, lecture({ frontmatter: { status: "ready", created: "2026-11-24" } }));
    const old = "learning/lessons/2026-11-01-old.md";
    t.brain.notes.set(old, lecture({ frontmatter: { status: "ready", created: "2026-11-01" } }));
    await t.desk.sweep();
    expect(t.brain.writes[0]).toContain("back to draft");
    expect((await t.store.get(PATH))).not.toBeNull();
    expect(t.brain.notes.get(old)!.frontmatter.status).toBe("ready");
    expect(await t.store.get(old)).toBeNull();
  });

  it("forgets a draft released by hand", async () => {
    const t = setup();
    t.brain.notes.set(PATH, lecture());
    await t.desk.sweep();
    t.brain.notes.get(PATH)!.frontmatter.status = "ready";
    await t.desk.sweep();
    expect((await t.store.get(PATH))!.stage).toBe("released");
  });
});
