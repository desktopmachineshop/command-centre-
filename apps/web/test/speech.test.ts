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
});
