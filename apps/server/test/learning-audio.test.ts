import { describe, expect, it } from "vitest";
import { addToCheck, compareHeard, PronunciationList, soundsOff, hasFfmpeg, MIX_RATE, PRONUNCIATION_PATH, PRONUNCIATION_TEMPLATE, recordLesson, spellOut, unknownAcronyms } from "../src/learning-audio";
import { spawnSync } from "node:child_process";
import { parseNote, serializeNote } from "@cc/brain";
import { parseLexicon } from "@cc/voice/lesson";
import { FakeTextToSpeech } from "@cc/voice";
import { VoiceService } from "../src/voice/service";

describe("checking a recording by ear (pure)", () => {
  it("scores what was heard against what should have been said", () => {
    // What Kokoro really did with "EtherCAT" unaided: flagged.
    expect(compareHeard("EtherCAT keeps the axes in step.", "ether cot keeps the axes in step")).toMatchObject({ missing: ["ethercat"], terms: ["ethercat"] });
    // Spacing isn't pronunciation.
    expect(compareHeard("EtherCAT keeps the axes in step.", "ether cat keeps the axes in step").missing).toEqual([]);
    expect(compareHeard("Twin-cat runs it.", "twincat runs it").missing).toEqual([]);
    expect(compareHeard("Ether-cat keeps the axes in step.", "ether cat keeps the axes in step")).toEqual({ score: 1, missing: [], terms: [] });
    // One misheard term is enough to count as off, however short the sentence.
    const one = compareHeard("The PLC speaks OPC to the cloud.", "the plc speaks opposite to the cloud");
    expect(one).toMatchObject({ missing: ["opc"], terms: ["opc"] });
    expect(soundsOff(one)).toBe(true);
    expect(soundsOff(compareHeard("It was a very good day for the whole team at the plant.", "it was a very good way for the whole team at the plant"))).toBe(false);
    // British and American spellings are the same word.
    expect(compareHeard("That determinism makes precise synchronisation possible, to a tenth of a millimetre.", "that determinism makes precise synchronization possible to a tenth of a millimeter").missing).toEqual([]);
    expect(compareHeard("The colour was analysed and catalogued, then travelled.", "the color was analyzed and cataloged then traveled").missing).toEqual([]);
    expect(compareHeard("Defence buyers need export licences for ninety tonnes.", "defense buyers need export licenses for ninety tons").missing).toEqual([]);
    // A British vowel heard by an American recogniser is an accent, not an error, for ordinary words...
    expect(compareHeard("That is a supply shock for machine shops restocking.", "that is a supply shark for machine sharps restarking").missing).toEqual([]);
    expect(compareHeard("Distributed clocks keep time.", "distributed clerks keep time").missing).toEqual([]);
    // ...but names and jargon must be heard as written.
    expect(compareHeard("Mining.com and Kitco reported highs.", "mining dart calm and kicko reported highs").terms).toEqual(["kitco"]);
    expect(compareHeard("The ore comes from scheelite.", "the aur comes from shelight").missing).toEqual(["scheelite"]);
    // Numbers and short words don't count: recognisers write them their own way.
    expect(compareHeard("It runs at 100 hertz on a bus.", "it runs at one hundred hertz on the bus").score).toBe(1);
    const bad = compareHeard("Beckhoff makes TwinCAT controllers.", "back off makes twin cat controllers");
    expect(bad.score).toBeLessThan(0.8);
    expect(bad.missing).toEqual(["beckhoff"]); // "twin cat" for TwinCAT is right
  });

  it("finds acronyms the lexicon doesn't cover, and spells them out", () => {
    const lex = new Map([["PLC", "P L C"]]);
    expect(unknownAcronyms("The PLC talks OPC UA to the MES over IEC links, not to Jo.", lex)).toEqual(["OPC", "UA", "MES", "IEC"]);
    expect(spellOut("OPC UA servers, and two MESs.", ["OPC", "UA", "MES"])).toBe("O P C U A servers, and two M E Ss.");
  });

  it("lists flagged words under To check once", () => {
    const once = addToCheck(PRONUNCIATION_TEMPLATE, [{ term: "kinematics", where: "lesson x" }]);
    const twice = addToCheck(once, [{ term: "Kinematics", where: "lesson y" }, { term: "harmonic", where: "lesson y" }]);
    expect(twice.match(/kinematics/gi)).toHaveLength(1);
    expect(twice).toContain("- harmonic — lesson y");
    // Still a valid lexicon: To check entries aren't used.
    expect(parseLexicon(twice).has("kinematics")).toBe(false);
    expect(parseLexicon(twice).get("EtherCAT")).toBe("Ether-cat");
  });
});

describe("the pronunciation list for everything spoken", () => {
  it("reads the list from the brain, keeps it a minute, and survives a failed read", async () => {
    let body = "## Say it like this\n- EtherCAT: Ether-cat\n";
    let reads = 0;
    let fail = false;
    const brain = {
      read: async () => {
        reads++;
        if (fail) throw new Error("db down");
        return { path: PRONUNCIATION_PATH, frontmatter: {}, body };
      },
    };
    let now = 0;
    const list = new PronunciationList(brain, 60_000, () => now);
    expect(await list.pronounce("EtherCAT on the Z axis")).toBe("Ether-cat on the zed axis");
    body = "## Say it like this\n- EtherCAT: Ether cat\n";
    expect(await list.pronounce("EtherCAT")).toBe("Ether-cat"); // still cached
    expect(reads).toBe(1);
    now = 61_000;
    expect(await list.pronounce("EtherCAT")).toBe("Ether cat");
    now = 130_000;
    fail = true;
    expect(await list.pronounce("EtherCAT")).toBe("Ether cat"); // the last good list
  });

  it("is applied to everything /voice/speak says, before the cache", async () => {
    const tts = new FakeTextToSpeech();
    const service = new VoiceService({} as never, {} as never, {} as never, {
      tts,
      pronounce: async (t) => t.replace("TwinCAT", "Twin-cat"),
      maxUploadBytes: 1024,
      maxSeconds: 60,
      language: "en-GB",
      timezone: "Europe/London",
    });
    await service.speak("Open TwinCAT.");
    await service.speak("Open TwinCAT.");
    expect(tts.calls.map((c) => c.text)).toEqual(["Open Twin-cat."]);
    // A failing list never stops the voice.
    const failing = new VoiceService({} as never, {} as never, {} as never, { tts, pronounce: async () => { throw new Error("x"); }, maxUploadBytes: 1, maxSeconds: 1, language: "en-GB", timezone: "Europe/London" });
    await failing.speak("Still speaks.");
    expect(tts.calls.at(-1)!.text).toBe("Still speaks.");
  });

  it("spells acronyms the British way when it retries one", () => {
    expect(spellOut("The ZDR rules.", ["ZDR"])).toBe("The zed D R rules.");
  });
});

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!ffmpeg)("recording a lesson (ffmpeg)", () => {
  /** A stand-in voice: a tone a tenth of a second per word, as MP3. */
  const tone = (text: string) => {
    const seconds = Math.max(0.2, text.split(/\s+/).length * 0.1);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-f", "mp3", "pipe:1"]);
    return new Uint8Array(r.stdout);
  };

  function memoryBrain(notes: Record<string, string>) {
    const store = new Map(Object.entries(notes).map(([p, raw]) => [p, parseNote(p, raw)]));
    return {
      store,
      read: async (p: string) => store.get(p) ?? null,
      write: async (p: string, c: { frontmatter?: Record<string, unknown>; body: string }) => {
        const n = parseNote(p, serializeNote({ frontmatter: c.frontmatter ?? {}, body: c.body }));
        store.set(p, n);
        return n;
      },
      list: async () => [...store.keys()],
    };
  }

  it("records with the lexicon and pauses, chapters per section, retries an acronym spelled out, flags what still sounds off", async () => {
    expect(await hasFfmpeg()).toBe(true);
    const path = "learning/lessons/2026-11-23-opc.md";
    const brain = memoryBrain({
      [path]: "---\ntype: lesson\ntrack: robotics\nstatus: ready\n---\n\n# OPC and friends\n\n## Why this matters now\nThe PLC speaks OPC to the cloud.\n\nBeckhoff makes the controller.\n\n## Try it\nNot spoken.\n\n## Quiz\n1. What is OPC?\n   **Answer:** A standard.\n",
      [PRONUNCIATION_PATH]: `---\ntype: playbook\n---\n\n${PRONUNCIATION_TEMPLATE}`,
    });
    const said: string[] = [];
    const stored: { name: string; bytes: number; folder?: string }[] = [];
    const deleted: string[] = [];
    // The listener hears acronyms only when spelled out, and never hears "Beckhoff" right.
    const transcribe = async (samples: Float32Array) => {
      expect(samples.length).toBeGreaterThan(0);
      const text = said[said.length - 1]!;
      return text.replace(/\bOPC\b/g, "opposite").replace(/Beckhoff/g, "back off");
    };
    const deps = {
      brain,
      storage: {
        put: async (src: AsyncIterable<Buffer>, o: { name: string; folder?: string }) => {
          let bytes = 0;
          for await (const chunk of src) bytes += chunk.length;
          stored.push({ name: o.name, bytes, folder: o.folder });
          return { id: `${"a".repeat(32)}.mp3` } as never;
        },
        delete: async (id: string) => {
          deleted.push(id);
          return true;
        },
      },
      narrate: async (text: string) => {
        said.push(text);
        return { audio: tone(text) };
      },
      transcribe: () => transcribe,
      mediaUrl: (id: string) => `/media/${id}`,
    };
    const progress: number[] = [];
    const audio = await recordLesson(deps as never, path, (done) => progress.push(done));

    expect(said).toContain("The P L C speaks OPC to the cloud.");
    expect(said).toContain("The P L C speaks O P C to the cloud."); // the retake, spelled out
    expect(said).toContain("Beckhoff makes the controller.");
    expect(said.join(" ")).not.toContain("Not spoken");
    expect(audio.chapters.map((c) => c.title)).toEqual(["OPC and friends", "Why this matters now", "Quiz"]);
    expect(audio.chapters[0]!.at).toBe(0);
    expect(audio.chapters[1]!.at).toBeGreaterThan(1.5); // the title, then a section's pause
    expect(audio.flagged.map((f) => f.missing)).toEqual([["beckhoff"]]);
    expect(audio.seconds).toBeGreaterThan(5);
    expect(stored).toEqual([{ name: "2026-11-23-opc.mp3", bytes: expect.any(Number), folder: "audio" }]);
    // 64 kbit/s: about 8 KB a second.
    expect(stored[0]!.bytes).toBeGreaterThan(audio.seconds * 6000);
    expect(progress.at(-1)).toBe(progress.length);

    const saved = brain.store.get(path)!;
    expect(saved.frontmatter.audio).toMatchObject({ url: `/media/${"a".repeat(32)}.mp3`, voice: "kokoro:bf_emma", checked: progress.length });
    expect(brain.store.get(PRONUNCIATION_PATH)!.body).toMatch(/## To check\n- beckhoff — sounded off in "OPC and friends"/);

    // Recording again replaces the earlier file.
    await recordLesson({ ...deps, storage: { ...deps.storage, put: async () => ({ id: `${"b".repeat(32)}.mp3` }) as never } } as never, path);
    expect(deleted).toEqual([`${"a".repeat(32)}.mp3`]);
    expect(MIX_RATE).toBe(24000);
  });
});
