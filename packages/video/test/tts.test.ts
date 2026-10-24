import { describe, expect, it } from "vitest";
import { charactersToWords, cloudProvider, elevenLabsProvider, openAiProvider, silentProvider, silentWav, TtsError, wavDuration } from "../src";

describe("tts", () => {
  it("silent provider: deterministic WAV sized to the text, with word timings", async () => {
    const tts = silentProvider({ wordsPerSecond: 2 });
    const a = await tts.synthesize("one two three four");
    const b = await tts.synthesize("one two three four");
    expect(a.durationSec).toBe(2);
    expect(wavDuration(a.audio)).toBeCloseTo(2, 3);
    expect(Buffer.from(a.audio).equals(Buffer.from(b.audio))).toBe(true);
    expect(a.words!.map((w) => w.word)).toEqual(["one", "two", "three", "four"]);
    expect((await tts.synthesize("one two three four", { speed: 1.25 })).durationSec).toBe(1.6);
    expect(a.mime).toBe("audio/wav");
  });

  it("measures WAVs with placeholder sizes (streamed output)", () => {
    const wav = silentWav(1.5, 24_000);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDuration(wav)).toBeCloseTo(1.5, 3);
    expect(() => wavDuration(new Uint8Array(20))).toThrow(/not a WAV/);
  });

  it("turns ElevenLabs character alignment into words", () => {
    const text = "Hi  there, you.";
    const chars = [...text];
    const words = charactersToWords({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    });
    expect(words).toEqual([
      { word: "Hi", start: 0, end: 0.2 },
      { word: "there,", start: 0.4, end: 1 },
      { word: "you.", start: 1.1, end: 1.5 },
    ]);
  });

  it("calls ElevenLabs with-timestamps through the injected fetch", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tts = elevenLabsProvider({
      apiKey: "k",
      voiceId: "voice1",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          audio_base64: Buffer.from("mp3bytes").toString("base64"),
          alignment: { characters: [..."Go"], character_start_times_seconds: [0, 0.2], character_end_times_seconds: [0.2, 0.45] },
        });
      },
    });
    const out = await tts.synthesize("Go", { speed: 1.1 });
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice1/with-timestamps?output_format=mp3_44100_128");
    expect(calls[0]!.init?.headers).toMatchObject({ "xi-api-key": "k" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "Go", model_id: "eleven_multilingual_v2", voice_settings: { speed: 1.1 } });
    expect(out).toMatchObject({ mime: "audio/mpeg", durationSec: 0.45, alignedWords: true, words: [{ word: "Go", start: 0, end: 0.45 }] });
    expect(Buffer.from(out.audio).toString()).toBe("mp3bytes");

    const failing = elevenLabsProvider({ apiKey: "k", voiceId: "v", fetch: async () => new Response("quota", { status: 401 }) });
    await expect(failing.synthesize("x")).rejects.toThrow(TtsError);
  });

  it("calls OpenAI speech for WAV and estimates the words", async () => {
    let body: Record<string, unknown> = {};
    const tts = openAiProvider({
      apiKey: "k",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(silentWav(2).buffer as ArrayBuffer);
      },
    });
    const out = await tts.synthesize("two words");
    expect(out.mime).toBe("audio/wav");
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", response_format: "wav", input: "two words" });
    expect(out).toMatchObject({ durationSec: 2, alignedWords: false });
    expect(out.words).toHaveLength(2);
  });

  it("only builds cloud providers that have keys", () => {
    expect(cloudProvider("elevenlabs", {})).toBeNull();
    expect(cloudProvider("elevenlabs", { elevenlabs: { apiKey: "k", voiceId: "v" } })?.id).toBe("elevenlabs");
    expect(cloudProvider("nope", { openai: { apiKey: "k" } })).toBeNull();
  });
});
