import { describe, expect, it } from "vitest";
import { lessonScript, minutesLeft } from "../src/learning/script";

const LESSON = `---
type: lesson
track: robotics
---

# How EtherCAT keeps axes in step

## Why this matters now
EtherCAT runs **most** of the world's fast motion.
It does it with one frame.

A second paragraph, with [a link](https://example.com).

## The big idea
- First point.
- Second point.

## Try it
\`\`\`
x = 1
\`\`\`
Work it out on paper.

## Quiz
1. What is a distributed clock?
   **Answer:** A shared time base.

## Sources
- [Beckhoff](https://beckhoff.com), 2026
`;

describe("lesson script (what the player speaks)", () => {
  it("speaks the title and teaching sections paragraph by paragraph, and skips Try it and Sources", () => {
    const s = lessonScript(LESSON, "How EtherCAT keeps axes in step");
    expect(s.sections.map((x) => x.title)).toEqual(["How EtherCAT keeps axes in step", "Why this matters now", "The big idea", "Quiz"]);
    const text = s.parts.map((p) => p.text);
    expect(text).toContain("EtherCAT runs most of the world's fast motion. It does it with one frame.");
    expect(text).toContain("A second paragraph, with a link.");
    expect(text).toContain("First point.");
    expect(text).toContain("Second point.");
    expect(text).toContain("Answer: A shared time base.");
    expect(text.join(" ")).not.toMatch(/Work it out|x = 1|Beckhoff|---|type: lesson/);
    expect(s.parts[s.sections[2]!.first]!.text).toBe("The big idea.");
    expect(minutesLeft(s.parts, 0)).toBeGreaterThan(0);
    expect(minutesLeft(s.parts, s.parts.length)).toBe(0);
  });
});

describe("recorded lessons (player helpers)", () => {
  const chapters = [{ at: 0 }, { at: 4.1 }, { at: 120 }];
  it("finds the chapter playing, and where 'previous' goes", async () => {
    const { chapterAt, clock, previousChapterStart } = await import("../src/learning/recording");
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 4.05)).toBe(1);
    expect(chapterAt(chapters, 500)).toBe(2);
    expect(previousChapterStart(chapters, 130)).toBe(120); // restart this chapter
    expect(previousChapterStart(chapters, 121)).toBe(4.1); // just started it: the one before
    expect(previousChapterStart(chapters, 1)).toBe(0);
    expect(clock(65)).toBe("1:05");
    expect(clock(3729)).toBe("1:02:09");
  });
});

describe("narrator names", () => {
  it("names a voice the server doesn't list", async () => {
    const { prettyVoice } = await import("../src/pages/Learning");
    expect(prettyVoice("kokoro:bf_emma")).toBe("Emma (Kokoro)");
    expect(prettyVoice("piper:jenny_dioco")).toBe("Jenny Dioco (Piper)");
  });
});

describe("this device's voice uses the pronunciation list", () => {
  it("pronounces with the list once the app has loaded it", async () => {
    const { pronounceForDevice, setSpeechLexicon } = await import("../src/voice/speech");
    expect(pronounceForDevice("TwinCAT on the Z axis")).toBe("TwinCAT on the zed axis");
    setSpeechLexicon([["TwinCAT", "Twin-cat"]]);
    expect(pronounceForDevice("TwinCAT on the Z axis")).toBe("Twin-cat on the zed axis");
    setSpeechLexicon([]);
  });
});

describe("picking up where you left off", () => {
  it("starts from this device's place or the server's, whichever is newer", async () => {
    const { startingPlace } = await import("../src/pages/Learning");
    const server = { audioSeconds: 600, audioAt: "2026-11-23T10:00:00Z", readPart: null, readAt: null };
    expect(startingPlace(null, server)).toBe(600);
    expect(startingPlace({ t: 120, at: Date.parse("2026-11-23T09:00:00Z") }, server)).toBe(600); // the phone listened later
    expect(startingPlace({ t: 700, at: Date.parse("2026-11-23T11:00:00Z") }, server)).toBe(700);
    expect(startingPlace({ t: 50, at: 0 }, null)).toBe(50);
    expect(startingPlace(null, null)).toBe(0);
  });
});

describe("lessons in Converse", () => {
  const lesson = (path: string, over: Record<string, unknown> = {}) =>
    ({ path, title: path, topic: "", summary: "", track: "ai", status: "ready", created: "2026-11-20", percent: 0, audio: { seconds: 1800 }, progress: null, ...over }) as never;

  it("hears lesson requests, and leaves other requests for the agent", async () => {
    const { parseCommand } = await import("../src/voice/commands");
    expect(parseCommand("What lessons have I got?")).toEqual({ kind: "lessons" });
    expect(parseCommand("lessons")).toEqual({ kind: "lessons" });
    expect(parseCommand("Play today's lesson")).toEqual({ kind: "playLesson", pick: { kind: "today" } });
    expect(parseCommand("play my lesson please")).toEqual({ kind: "playLesson", pick: { kind: "today" } });
    expect(parseCommand("Continue my lesson")).toEqual({ kind: "playLesson", pick: { kind: "continue" } });
    expect(parseCommand("play lesson two")).toEqual({ kind: "playLesson", pick: { kind: "number", n: 2 } });
    expect(parseCommand("play the second lesson")).toEqual({ kind: "playLesson", pick: { kind: "number", n: 2 } });
    expect(parseCommand("Play the lesson about carbide prices")).toEqual({ kind: "playLesson", pick: { kind: "topic", text: "carbide prices" } });
    expect(parseCommand("pause the lesson")).toEqual({ kind: "pauseLesson" });
    expect(parseCommand("stop")).toEqual({ kind: "stop" });
    expect(parseCommand("play the new video on the shop's instagram")).toMatchObject({ kind: "chat" });
  });

  it("offers today's lesson, then the ones started, then the rest, and says how far through each is", async () => {
    const { lessonsLine, lessonsToOffer, pickLesson } = await import("../src/learning/converse");
    const today = lesson("today");
    const started = lesson("started", { percent: 40, progress: { audioAt: "2026-11-22T10:00:00Z" } });
    const newer = lesson("newer", { percent: 10, progress: { audioAt: "2026-11-23T08:00:00Z" } });
    const carbide = lesson("carbide", { title: "Why carbide end mills cost more", audio: null });
    const done = lesson("done", { status: "done", title: "EtherCAT distributed clocks" });
    const view = { todays: today, lessons: [today, started, newer, carbide, done] } as never;
    const offered = lessonsToOffer(view);
    expect(offered.map((l: { path: string }) => l.path)).toEqual(["today", "newer", "started", "carbide"]);
    const line = lessonsLine(offered, 4);
    expect(line).toMatch(/^You've got 4 lessons\. One: today, not started\. Two: newer, 10 percent through\./);
    expect(line).toContain("Four: Why carbide end mills cost more, not recorded yet.");
    expect(pickLesson(view, { kind: "today" }, offered)!.path).toBe("today");
    expect(pickLesson(view, { kind: "continue" }, offered)!.path).toBe("newer");
    expect(pickLesson(view, { kind: "number", n: 3 }, offered)!.path).toBe("started");
    expect(pickLesson(view, { kind: "number", n: 9 }, offered)).toBeNull();
    expect(pickLesson(view, { kind: "topic", text: "carbide" }, offered)!.path).toBe("carbide");
    expect(pickLesson(view, { kind: "topic", text: "ethercat clocks" }, offered)!.path).toBe("done");
    expect(pickLesson(view, { kind: "topic", text: "knitting" }, offered)).toBeNull();
    expect(lessonsLine([], 0)).toMatch(/no lessons waiting/);
  });
});
