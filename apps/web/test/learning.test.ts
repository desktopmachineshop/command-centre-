import { describe, expect, it } from "vitest";
import { lessonScript, minutesLeft } from "../src/learning/script";
import { freeVoiceDefault } from "../src/voice/choice";

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

  it("defaults lessons to the server's own free voice, else the device's", () => {
    const v = (id: string, tier: string, status = "ready", isDefault = false) => ({ id, tier, status, isDefault });
    expect(freeVoiceDefault([v("eleven:a", "elevenlabs"), v("kokoro:bf_emma", "natural"), v("piper:cori", "fast", "ready", true)])).toBe("piper:cori");
    expect(freeVoiceDefault([v("eleven:a", "elevenlabs"), v("piper:alba", "fast", "missing")])).toBe("device");
    expect(freeVoiceDefault([v("kokoro:bf_emma", "natural")])).toBe("kokoro:bf_emma");
  });
});
