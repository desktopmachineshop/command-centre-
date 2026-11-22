import { chiefOfStaff } from "@cc/verticals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRequested, type Lesson, learningStats, lessonOf, parseTopicLine, parseTopics, TOPICS_TEMPLATE, todaysLesson } from "../src/learning";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const lesson = (over: Partial<Lesson>): Lesson => ({
  path: "learning/lessons/2026-11-01-x.md",
  title: "X",
  track: "ai",
  topic: "",
  summary: "",
  status: "ready",
  created: "2026-11-01",
  completedAt: null,
  completedMode: null,
  minutesSpent: null,
  rating: null,
  words: 4500,
  listenMinutes: 30,
  readMinutes: 30,
  ...over,
});
const done = (day: string, over: Partial<Lesson> = {}) =>
  lesson({ path: `learning/lessons/${day}-x.md`, created: day, status: "done", completedAt: `${day}T12:00:00Z`, completedMode: "listen", minutesSpent: 30, ...over });

describe("learning (pure)", () => {
  it("reads topic lines and the map's sections", () => {
    expect(parseTopicLine("- [robotics] EtherCAT distributed clocks: keeps axes in step")).toEqual({ track: "robotics", title: "EtherCAT distributed clocks", why: "keeps axes in step" });
    expect(parseTopicLine("- [nope] Something - why")).toEqual({ track: "interest", title: "Something", why: "why" });
    expect(parseTopicLine("- plain bullet")).toBeNull();
    const map = parseTopics(TOPICS_TEMPLATE);
    expect(map.requested).toEqual([]);
    expect(map.upNext.length).toBeGreaterThanOrEqual(3);
    expect(new Set(map.upNext.map((s) => s.track)).size).toBeGreaterThan(1);
    expect(map.backlog).toBeGreaterThan(20);
  });

  it("adds a requested topic under Requested, after any already there", () => {
    const once = addRequested(TOPICS_TEMPLATE, { track: "interest", title: "Harmonic drives", why: "" });
    const twice = addRequested(once, { track: "ai", title: "Speculative decoding", why: "faster inference" });
    expect(parseTopics(twice).requested.map((s) => s.title)).toEqual(["Harmonic drives", "Speculative decoding"]);
    expect(parseTopics(twice).upNext).toEqual(parseTopics(TOPICS_TEMPLATE).upNext);
    expect(parseTopics(addRequested("# Topics\n", { track: "ai", title: "Y", why: "" })).requested).toHaveLength(1);
  });

  it("makes a lesson from a note's frontmatter, with time estimates", () => {
    const l = lessonOf({
      path: "learning/lessons/2026-11-20-carbide.md",
      title: "Why carbide costs more",
      frontmatter: { type: "lesson", track: "market", status: "done", completed: "2026-11-21T08:00:00Z", completed_mode: "listen", minutes_spent: 28, rating: 4 },
      words: 4500,
      updatedAt: "2026-11-21T08:00:00Z",
    })!;
    expect(l).toMatchObject({ track: "market", status: "done", created: "2026-11-20", completedMode: "listen", minutesSpent: 28, rating: 4, listenMinutes: 30 });
    expect(lessonOf({ path: "learning/topics.md", title: "t", frontmatter: {}, words: 1, updatedAt: "2026-11-01T00:00:00Z" })).toBeNull();
  });

  it("keeps the scoreboard: streaks, weeks, tracks and badges", () => {
    const now = new Date("2026-11-22T10:00:00Z"); // a Sunday
    const lessons = [done("2026-11-20"), done("2026-11-21", { completedMode: "read", track: "robotics" }), done("2026-11-10"), done("2026-11-11"), done("2026-11-12"), lesson({ created: "2026-11-22" })];
    const s = learningStats(lessons, now, "Europe/London");
    expect(s).toMatchObject({ completed: 5, minutes: 150, ready: 1, read: 1, listened: 4, streak: 2, bestStreak: 3, doneToday: false, thisWeek: 2 });
    expect(s.weeks).toHaveLength(12);
    expect(s.weeks[11]).toMatchObject({ start: "2026-11-16", completed: 2 });
    expect(s.weeks[10]).toMatchObject({ start: "2026-11-09", completed: 3 });
    expect(s.byTrack.find((t) => t.track === "robotics")!.completed).toBe(1);
    expect(s.badges.find((b) => b.id === "first")!.earned).toBe(true);
    expect(s.badges.find((b) => b.id === "week")!.earned).toBe(false);
    // A gap of two days breaks the streak.
    expect(learningStats([done("2026-11-19")], now, "Europe/London").streak).toBe(0);
  });

  it("picks today's lesson: today's if open, else the newest open", () => {
    const a = lesson({ path: "learning/lessons/2026-11-21-a.md", created: "2026-11-21" });
    const b = lesson({ path: "learning/lessons/2026-11-22-b.md", created: "2026-11-22" });
    expect(todaysLesson([a, b], "2026-11-22")).toBe(b);
    expect(todaysLesson([a, { ...b, status: "done" }], "2026-11-22")).toBe(a);
    expect(todaysLesson([], "2026-11-22")).toBeNull();
  });

  it("gives the assistant the coach skill, a daily lesson before the brief, and a learning line in the brief", () => {
    expect(chiefOfStaff.skills).toContain("career-coach");
    const daily = chiefOfStaff.schedules.find((s) => s.id === "daily-lesson")!;
    expect(daily).toMatchObject({ cron: "40 5 * * *", timezone: "Europe/London", enabled: true });
    expect(daily.prompt).toContain("career-coach");
    expect(daily.prompt).toContain("do not use the mail tools");
    expect(chiefOfStaff.schedules.find((s) => s.id === "morning-brief")!.prompt).toContain("learning line");
  });
});

describe.skipIf(!DB_URL)("learning (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
  });
  afterAll(async () => ctx?.server.stop());

  const raw = (fm: string, words: number) => `---\n${fm}\n---\n\n# A lesson\n\n${"word ".repeat(words)}\n`;

  it("seeds the topic map and lists lessons with the scoreboard", async () => {
    const topics = await ctx.api("/api/brain/note?path=learning/topics.md");
    expect(topics.status).toBe(200);
    expect((await ctx.api("/api/brain/note?path=learning/README.md")).status).toBe(200);

    const empty = await ctx.api("/api/learning");
    expect(empty.status).toBe(200);
    expect(empty.body.lessons).toEqual([]);
    expect(empty.body.todays).toBeNull();
    expect(empty.body.suggestions.upNext.length).toBeGreaterThanOrEqual(3);
    expect(empty.body.tracks.map((t: { id: string }) => t.id)).toContain("robotics");

    const path = `learning/lessons/${empty.body.today}-ethercat.md`;
    const put = await ctx.api("/api/brain/note", { method: "PUT", json: { path, raw: raw(`type: lesson\ntrack: robotics\ntitle: EtherCAT clocks\nstatus: ready\ncreated: ${empty.body.today}\nminutes: 30`, 4500) } });
    expect(put.status).toBe(200);

    const listed = await ctx.api("/api/learning");
    expect(listed.body.lessons).toHaveLength(1);
    expect(listed.body.lessons[0]).toMatchObject({ path, title: "EtherCAT clocks", track: "robotics", status: "ready", listenMinutes: 30 });
    expect(listed.body.todays.path).toBe(path);

    const one = await ctx.api(`/api/learning/lesson?path=${encodeURIComponent(path)}`);
    expect(one.status).toBe(200);
    expect(one.body.body).toContain("# A lesson");
    expect((await ctx.api("/api/learning/lesson?path=people/x.md")).status).toBe(400);
  });

  it("marks a lesson done (and back), counting it on the scoreboard and in the journal", async () => {
    const { body } = await ctx.api("/api/learning");
    const path = body.lessons[0].path;
    expect((await ctx.api("/api/learning/complete", { method: "POST", json: { path, mode: "listen", minutes: 27, rating: 5 } })).status).toBe(200);
    const after = await ctx.api("/api/learning");
    expect(after.body.lessons[0]).toMatchObject({ status: "done", completedMode: "listen", minutesSpent: 27, rating: 5 });
    expect(after.body.stats).toMatchObject({ completed: 1, minutes: 27, listened: 1, streak: 1, doneToday: true });
    const journal = await ctx.api(`/api/brain/note?path=journal/${body.today}.md`);
    expect(journal.body.body).toContain('Learning: listened to "EtherCAT clocks"');

    expect((await ctx.api("/api/learning/reopen", { method: "POST", json: { path } })).status).toBe(200);
    const reopened = await ctx.api("/api/learning");
    expect(reopened.body.lessons[0]).toMatchObject({ status: "ready", completedAt: null, rating: null });
    expect(reopened.body.stats.completed).toBe(0);
  });

  it("files a requested topic and hands the coach a chat task to write it", async () => {
    const res = await ctx.api("/api/learning/request", { method: "POST", json: { topic: "Harmonic drive gearboxes", track: "robotics" } });
    expect(res.status).toBe(201);
    expect(res.body.taskId).toBeTruthy();
    const after = await ctx.api("/api/learning");
    expect(after.body.suggestions.requested).toEqual([{ track: "robotics", title: "Harmonic drive gearboxes", why: "" }]);
    // Asking again doesn't list it twice.
    await ctx.api("/api/learning/request", { method: "POST", json: { topic: "harmonic drive gearboxes" } });
    expect((await ctx.api("/api/learning")).body.suggestions.requested).toHaveLength(1);
    const task = await ctx.api(`/api/tasks/${res.body.taskId}`);
    expect(JSON.stringify(task.body)).toContain("career-coach");
  });
});
