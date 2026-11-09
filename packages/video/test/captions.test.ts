import { describe, expect, it } from "vitest";
import { assColour, assEscape, assTime, buildCues, cardEvents, estimateWordTimings, parseSpec, planTimeline, srtTime, toAss, toSrt, type WordTiming } from "../src";
import { minimalSpec } from "./helpers";

const words = (...list: [string, number, number][]): WordTiming[] => list.map(([word, start, end]) => ({ word, start, end }));

describe("timeline", () => {
  it("sizes each scene from its voice, clip and minimum, in whole frames, and places words on the video clock", () => {
    const spec = parseSpec(minimalSpec());
    const t = planTimeline(
      spec,
      {
        hook: { durationSec: 1.2, words: words(["Ship", 0, 0.3], ["docs", 0.35, 0.7], ["faster.", 0.75, 1.2]) },
        demo: { durationSec: 2, words: words(["Here", 0, 0.4]) },
        cta: { durationSec: 0.5, words: words(["Try", 0, 0.2]) },
      },
      { demo: 6.01 },
    );
    // hook: max(2.5 min, 0.3+1.2+0.4=1.9) = 2.5; demo: clip 6.01 → 6.033 (frame); cta: minimum 4 (the end card is held long enough to read)
    expect(t.scenes.map((s) => [s.id, s.start, s.duration])).toEqual([
      ["hook", 0, 2.5],
      ["demo", 2.5, 6.033],
      ["cta", 8.533, 4],
    ]);
    expect(t.total).toBe(12.533);
    expect(t.scenes[1]!.voiceStart).toBe(2.8);
    expect(t.words[0]).toEqual({ word: "Ship", start: 0.3, end: 0.6 });
    expect(t.words[3]).toEqual({ word: "Here", start: 2.8, end: 3.2 });
  });

  it("estimates word timings that fill the clip in order, with pauses at punctuation", () => {
    const est = estimateWordTimings("Hello there. This is OpenD, the docs tool.", 4);
    expect(est).toHaveLength(8);
    for (let i = 1; i < est.length; i++) expect(est[i]!.start).toBeGreaterThanOrEqual(est[i - 1]!.end);
    expect(est.at(-1)!.end).toBeLessThanOrEqual(4);
    expect(est[2]!.start - est[1]!.end).toBeGreaterThan(est[1]!.start - est[0]!.end); // pause after "there."
  });
});

describe("captions", () => {
  const sample = words(
    ["Spotted", 0, 0.4], ["a", 0.45, 0.5], ["mistake", 0.55, 0.9], ["in", 0.95, 1.0], ["your", 1.05, 1.2], ["docs?", 1.25, 1.6],
    ["Fix", 2.5, 2.7], ["it", 2.75, 2.8], ["right", 2.85, 3.1], ["now.", 3.15, 3.5],
  );

  it("breaks cues at sentence ends, pauses and the character limit, without overlaps", () => {
    const cues = buildCues(sample, { maxChars: 18 });
    expect(cues.map((c) => c.words.map((w) => w.word).join(" "))).toEqual(["Spotted a mistake", "in your docs?", "Fix it right now."]);
    expect(cues[0]!.start).toBe(0);
    expect(cues[0]!.end).toBe(0.95); // held until the next cue starts
    expect(cues[1]!.end).toBe(2.1); // held 0.5s, next starts later
    expect(cues[2]!.end).toBe(4);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  });

  it("formats SRT and ASS times", () => {
    expect(srtTime(3723.4567)).toBe("01:02:03,457");
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(assTime(3723.4567)).toBe("1:02:03.46");
    expect(toSrt(buildCues(sample.slice(0, 6), { maxChars: 40 }))).toBe("1\n00:00:00,000 --> 00:00:02,100\nSpotted a mistake in your docs?\n");
  });

  it("writes ASS with brand styles, card text and one event per spoken word", () => {
    const spec = parseSpec(minimalSpec());
    const timeline = planTimeline(spec, {});
    const cues = buildCues(sample.slice(0, 3));
    const ass = toAss(cues, cardEvents(spec, timeline), { format: "9:16", brand: spec.brand, style: "word" });
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toMatch(/^Style: Caption,Inter,77,/m);
    expect(ass).toContain(`Dialogue: 1,0:00:00.00,0:00:02.50,Heading,,0,0,0,,{\\pos(540,806)\\fad(200,150)}Docs that ship`);
    const captionLines = ass.split("\n").filter((l) => l.includes(",Caption,"));
    expect(captionLines).toHaveLength(3);
    expect(captionLines[1]).toContain(`Spotted {\\c${assColour(spec.brand.colours.accent)}}a{\\c&H00FFFFFF} mistake`);
  });

  it("escapes override blocks and converts colours", () => {
    expect(assEscape("{\\an8}hi\\N there")).toBe("(⧵an8)hi⧵N there");
    expect(assColour("#ffb703")).toBe("&H0003B7FF");
    expect(assColour("#000000", 0x80)).toBe("&H80000000");
  });
});
