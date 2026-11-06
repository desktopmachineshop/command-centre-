import { describe, expect, it } from "vitest";
import {
  createVoiceProviders,
  ElevenLabsSpeechToText,
  ElevenLabsTextToSpeech,
  FakeSpeechToText,
  FakeTextToSpeech,
  OpenAISpeechToText,
  OpenAITextToSpeech,
  parseElevenLabsVoices,
  redact,
  VoiceProviderError,
  wordsFromAlignment,
} from "../src/index";

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return Object.assign(fn, { calls });
}

const OPENAI_KEY = "sk-test-openai-0123456789abcdef";
const ELEVEN_KEY = "el-test-key-0123456789abcdef";
const audio = new Uint8Array([1, 2, 3, 4]);

describe("OpenAI speech to text", () => {
  it("posts multipart audio with model and language", async () => {
    const fetch = mockFetch(() => Response.json({ text: " Remind me at three. " }));
    const stt = new OpenAISpeechToText({ apiKey: OPENAI_KEY, fetch });
    const result = await stt.transcribe(audio, "audio/webm;codecs=opus", { language: "en-GB" });
    expect(result.text).toBe("Remind me at three.");

    const { url, init } = fetch.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it("redacts the key from error messages", async () => {
    const fetch = mockFetch(() =>
      Response.json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, { status: 401 }),
    );
    const stt = new OpenAISpeechToText({ apiKey: OPENAI_KEY, fetch });
    const err = (await stt.transcribe(audio, "audio/webm").catch((e) => e)) as VoiceProviderError;
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("openai 401");
    expect(err.message).not.toContain(OPENAI_KEY);
    expect(err.message).not.toContain("0123456789abcdef");
  });

  it("redacts the key from network errors", async () => {
    const fetch = mockFetch(() => {
      throw new Error(`connect failed for Bearer ${OPENAI_KEY}`);
    });
    const err = (await new OpenAISpeechToText({ apiKey: OPENAI_KEY, fetch }).transcribe(audio, "audio/ogg").catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect(err.message).not.toContain(OPENAI_KEY);
  });
});

describe("OpenAI text to speech", () => {
  it("posts JSON and returns the audio bytes", async () => {
    const fetch = mockFetch(() => new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    const tts = new OpenAITextToSpeech({ apiKey: OPENAI_KEY, fetch, instructions: "calm" });
    const result = await tts.synthesize("Hello Dave", { voice: "nova" });
    expect(result).toEqual({ audio: new Uint8Array([9, 9, 9]), mime: "audio/mpeg" });

    const { url, init } = fetch.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Hello Dave",
      voice: "nova",
      response_format: "mp3",
      instructions: "calm",
    });
  });

  it("leaves out instructions for tts-1 and uses the default voice", async () => {
    const fetch = mockFetch(() => new Response(new Uint8Array([1])));
    await new OpenAITextToSpeech({ apiKey: OPENAI_KEY, fetch, model: "tts-1", instructions: "calm" }).synthesize("Hi", { format: "opus" });
    const body = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(body).toEqual({ model: "tts-1", input: "Hi", voice: "fable", response_format: "opus" });
  });
});

describe("ElevenLabs", () => {
  it("synthesizes with the xi-api-key header and output format", async () => {
    const fetch = mockFetch(() => new Response(new Uint8Array([7, 7])));
    const tts = new ElevenLabsTextToSpeech({ apiKey: ELEVEN_KEY, fetch, voice: "voice123" });
    const result = await tts.synthesize("Hello");
    expect(result).toEqual({ audio: new Uint8Array([7, 7]), mime: "audio/mpeg" });
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(ELEVEN_KEY);
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello", model_id: "eleven_flash_v2_5" });
  });

  it("reads a voice's name, or null when ElevenLabs won't say", async () => {
    const fetch = mockFetch(({ url }) => (url.endsWith("/v1/voices/good") ? Response.json({ voice_id: "good", name: "Rachel" }) : new Response("{}", { status: 401 })));
    const tts = new ElevenLabsTextToSpeech({ apiKey: ELEVEN_KEY, fetch });
    expect(await tts.voiceName("good")).toBe("Rachel");
    expect((fetch.calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe(ELEVEN_KEY);
    expect(await tts.voiceName("missing")).toBeNull();
  });

  it("returns word timings from the with-timestamps endpoint", async () => {
    const chars = "Hi Dave".split("");
    const fetch = mockFetch(() =>
      Response.json({
        audio_base64: Buffer.from([5, 6]).toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i * 0.1),
          character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
        },
      }),
    );
    const result = await new ElevenLabsTextToSpeech({ apiKey: ELEVEN_KEY, fetch }).synthesize("Hi Dave", { timings: true });
    expect(fetch.calls[0]!.url).toContain("/with-timestamps?");
    expect(result.audio).toEqual(new Uint8Array([5, 6]));
    expect(result.words).toEqual([
      { word: "Hi", start: 0, end: 0.2 },
      { word: "Dave", start: 0.30000000000000004, end: 0.7000000000000001 },
    ]);
  });

  it("redacts the key from errors", async () => {
    const fetch = mockFetch(() => Response.json({ detail: { message: `bad xi-api-key ${ELEVEN_KEY}` } }, { status: 401 }));
    const err = (await new ElevenLabsTextToSpeech({ apiKey: ELEVEN_KEY, fetch }).synthesize("x").catch((e) => e)) as Error;
    expect(err.message).toContain("elevenlabs 401");
    expect(err.message).not.toContain(ELEVEN_KEY);
  });

  it("transcribes with Scribe", async () => {
    const fetch = mockFetch(() =>
      Response.json({ text: "has order 1042 shipped", language_code: "en", words: [{ text: "has", type: "word", start: 0, end: 0.3 }, { text: " ", type: "spacing" }] }),
    );
    const result = await new ElevenLabsSpeechToText({ apiKey: ELEVEN_KEY, fetch }).transcribe(audio, "audio/mp4", { language: "en" });
    expect(result).toMatchObject({ text: "has order 1042 shipped", language: "en", words: [{ word: "has", start: 0, end: 0.3 }] });
    const form = fetch.calls[0]!.init.body as FormData;
    expect(fetch.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect((form.get("file") as File).name).toBe("audio.mp4");
  });

  it("groups alignment characters into words", () => {
    expect(
      wordsFromAlignment({ characters: ["a", " ", " ", "b", "c"], character_start_times_seconds: [0, 1, 2, 3, 4], character_end_times_seconds: [1, 2, 3, 4, 5] }),
    ).toEqual([
      { word: "a", start: 0, end: 1 },
      { word: "bc", start: 3, end: 5 },
    ]);
  });
});

describe("createVoiceProviders", () => {
  it("is empty with nothing configured", () => {
    expect(createVoiceProviders({ stt: "auto", tts: "auto" })).toEqual({ stt: undefined, tts: undefined });
  });

  it("auto prefers OpenAI for STT and ElevenLabs for TTS", () => {
    const both = createVoiceProviders({ stt: "auto", tts: "auto", openaiApiKey: OPENAI_KEY, elevenlabsApiKey: ELEVEN_KEY });
    expect([both.stt?.provider, both.tts?.provider]).toEqual(["openai", "elevenlabs"]);
    const openaiOnly = createVoiceProviders({ stt: "auto", tts: "auto", openaiApiKey: OPENAI_KEY });
    expect([openaiOnly.stt?.provider, openaiOnly.tts?.provider]).toEqual(["openai", "openai"]);
  });

  it("honours off and rejects a provider without its key", () => {
    expect(createVoiceProviders({ stt: "off", tts: "off", openaiApiKey: OPENAI_KEY })).toEqual({ stt: undefined, tts: undefined });
    expect(() => createVoiceProviders({ stt: "openai", tts: "off" })).toThrow(/OPENAI_API_KEY/);
    expect(() => createVoiceProviders({ stt: "off", tts: "elevenlabs" })).toThrow(/ELEVENLABS_API_KEY/);
  });

  it("keeps ElevenLabs for picked voices when another provider is the default", () => {
    const p = createVoiceProviders({ stt: "auto", tts: "openai", openaiApiKey: OPENAI_KEY, elevenlabsApiKey: ELEVEN_KEY });
    expect([p.tts?.provider, p.elevenlabs?.provider]).toEqual(["openai", "elevenlabs"]);
    const same = createVoiceProviders({ stt: "auto", tts: "auto", elevenlabsApiKey: ELEVEN_KEY });
    expect(same.elevenlabs).toBe(same.tts);
    expect(createVoiceProviders({ stt: "off", tts: "off", elevenlabsApiKey: ELEVEN_KEY }).elevenlabs).toBeUndefined();
  });
});

describe("parseElevenLabsVoices", () => {
  it("reads 'Name = id', 'Name: id' and bare ids, skipping blanks, junk and repeats", () => {
    expect(parseElevenLabsVoices(["Rachel = 21m00Tcm4TlvDq8ikWAM", "  ", "George: JBFqnCBsd6RMkjVDRZzb", "pNInz6obpgDQGcFmaJgB", "21m00Tcm4TlvDq8ikWAM", "not a voice"])).toEqual([
      { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
      { id: "JBFqnCBsd6RMkjVDRZzb", label: "George" },
      { id: "pNInz6obpgDQGcFmaJgB", label: "pNInz6obpgDQGcFmaJgB" },
    ]);
  });
});

describe("fakes and redact", () => {
  it("fake providers record calls", async () => {
    const stt = new FakeSpeechToText().push("what's new");
    expect((await stt.transcribe(audio, "audio/webm")).text).toBe("what's new");
    expect((await stt.transcribe(audio, "audio/webm")).text).toBe("hello");
    const tts = new FakeTextToSpeech();
    const out = await tts.synthesize("two words", { timings: true });
    expect(new TextDecoder().decode(out.audio)).toBe("fake-voice:two words");
    expect(out.words).toHaveLength(2);
  });

  it("redacts given secrets and common key shapes", () => {
    expect(redact("key sk-abcdefghijkl and secret123", ["secret123"])).toBe("key [redacted] and [redacted]");
    expect(redact('{"xi-api-key": "abc"}')).toBe('{"xi-api-key": "[redacted]"}');
  });
});
