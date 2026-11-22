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
