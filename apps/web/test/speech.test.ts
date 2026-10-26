import { describe, expect, it } from "vitest";
import { chunkForSpeech, pickVoice } from "../src/voice/speech";

const v = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false });

describe("pickVoice", () => {
  it("prefers a good en-GB voice", () => {
    const voices = [v("Alex", "en-US"), v("Fred", "en-GB"), v("Google UK English Female", "en-GB", false), v("Thomas", "fr-FR")];
    expect(pickVoice(voices)?.name).toBe("Google UK English Female");
  });

  it("falls back to another English voice, never a novelty one or another language", () => {
    expect(pickVoice([v("Zarvox", "en-GB"), v("Samantha", "en-US")])?.name).toBe("Samantha");
    expect(pickVoice([v("Thomas", "fr-FR")])).toBeNull();
    expect(pickVoice([v("Daniel", "en_GB")])?.name).toBe("Daniel");
  });
});

describe("chunkForSpeech", () => {
  it("splits long text at sentences", () => {
    const text = "One two three. Four five six! Seven eight nine?";
    expect(chunkForSpeech(text, 20)).toEqual(["One two three.", "Four five six!", "Seven eight nine?"]);
    expect(chunkForSpeech(text)).toEqual([text]);
  });

  it("splits an overlong sentence at clauses, then words, and loses nothing", () => {
    const long = `${Array.from({ length: 12 }, (_, i) => `the order for customer number ${i} shipped today`).join(", ")} and that is all.`;
    const chunks = chunkForSpeech(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(160);
    expect(chunks.join(" ")).toBe(long);
    const words = chunkForSpeech("word ".repeat(100).trim(), 50);
    for (const c of words) expect(c.length).toBeLessThanOrEqual(50);
    expect(words.join(" ")).toBe("word ".repeat(100).trim());
  });
});
