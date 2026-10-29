import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserListener, chunkForSpeech, collapseRepeats, pickVoice } from "../src/voice/speech";

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

describe("collapseRepeats", () => {
  it("folds Android's repeat-the-sentence-so-far results into one", () => {
    expect(collapseRepeats(["draft", "draft a", "draft a note", "draft a note to remind me", "draft a note to remind me"])).toEqual(["draft a note to remind me"]);
  });

  it("keeps separate phrases, including ones that share a word", () => {
    expect(collapseRepeats(["order more collets", "from the usual supplier"])).toEqual(["order more collets", "from the usual supplier"]);
    expect(collapseRepeats(["order", "orders shipped"])).toEqual(["order", "orders shipped"]);
    expect(collapseRepeats(["Draft a note.", "draft a note to Sam"])).toEqual(["draft a note to Sam"]);
  });
});

/** A stand-in for the Web Speech API recognition object. */
class FakeRecognition {
  static last: FakeRecognition;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  results: { isFinal: boolean; 0: { transcript: string } }[] = [];
  constructor() {
    FakeRecognition.last = this;
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}
  say(transcript: string, isFinal = true) {
    const last = this.results[this.results.length - 1];
    if (last && !last.isFinal) this.results.pop();
    this.results.push({ isFinal, 0: { transcript } });
    this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
  }
}

describe("BrowserListener", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const setup = () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    return new BrowserListener();
  };

  it("keeps listening through a short pause and ends the turn after 2.5 s of quiet", async () => {
    const l = setup();
    let result: string | null | undefined;
    void l.listen({ lang: "en-GB", timeoutMs: 8000 }).then((r) => (result = r));
    FakeRecognition.last.say("order more collets");
    await vi.advanceTimersByTimeAsync(1000);
    FakeRecognition.last.say("from the usual supplier");
    await vi.advanceTimersByTimeAsync(2000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(result).toBe("order more collets from the usual supplier");
  });

  it("hears Android's word-by-word repeats as one sentence", async () => {
    const l = setup();
    const p = l.listen({ lang: "en-GB", timeoutMs: 8000 });
    const words = "draft a note to remind me that I need to change how the behaviour when an order is confirmed happens".split(" ");
    for (let i = 1; i <= words.length; i++) {
      FakeRecognition.last.say(words.slice(0, i).join(" "));
      FakeRecognition.last.say(words.slice(0, i).join(" ")); // sometimes twice
    }
    l.stop();
    expect(await p).toBe(words.join(" "));
  });

  it("shows interim words and replaces them when they become final", async () => {
    const l = setup();
    const seen: string[] = [];
    const p = l.listen({ lang: "en-GB", timeoutMs: 8000, onInterim: (t) => seen.push(t) });
    FakeRecognition.last.say("approve the");
    FakeRecognition.last.say("yes", false);
    FakeRecognition.last.say("yes approve", false);
    FakeRecognition.last.say("yes approve it");
    l.stop();
    expect(await p).toBe("approve the yes approve it");
    expect(seen).toEqual(["approve the", "approve the yes", "approve the yes approve", "approve the yes approve it"]);
  });

  it("Send ends the turn at once with what was heard", async () => {
    const l = setup();
    const p = l.listen({ lang: "en-GB", timeoutMs: 8000 });
    FakeRecognition.last.say("yes approve");
    l.stop();
    expect(await p).toBe("yes approve");
  });

  it("background chatter can't keep a turn open: it ends after a minute, and Send ends it any time", async () => {
    const l = setup();
    let result: string | null | undefined;
    void l.listen({ lang: "en-GB", timeoutMs: 8000 }).then((r) => (result = r));
    for (let i = 0; i < 30; i++) {
      FakeRecognition.last.say(`chatter ${i}`);
      await vi.advanceTimersByTimeAsync(2000); // never a 2.5 s pause
    }
    expect(result).toMatch(/^chatter 0 chatter 1 .* chatter 29$/);

    const p = l.listen({ lang: "en-GB", timeoutMs: 8000 });
    FakeRecognition.last.say("I'm done");
    FakeRecognition.last.say("radio noise");
    l.stop();
    expect(await p).toBe("I'm done radio noise");
  });

  it("gives up with nothing heard after the timeout, even if the engine stops early", async () => {
    const l = setup();
    let result: string | null | undefined;
    void l.listen({ lang: "en-GB", timeoutMs: 8000 }).then((r) => (result = r));
    FakeRecognition.last.onend?.(); // Android ends the session by itself: it restarts
    await vi.advanceTimersByTimeAsync(7000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1100);
    expect(result).toBeNull();
  });
});
