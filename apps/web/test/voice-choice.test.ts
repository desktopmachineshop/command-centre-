import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceConfig } from "../src/api";
import { readVoiceChoice, speakerFor, writeVoiceChoice } from "../src/voice/choice";
import { BrowserSpeaker, ServerSpeaker } from "../src/voice/speech";
import { voiceLabel } from "../src/voice/VoicePicker";

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

describe("voice choice (per device)", () => {
  beforeEach(() => {
    Object.assign(globalThis, { localStorage: fakeStorage(), window: Object.assign(new EventTarget(), {}) });
    (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class extends Event {
      detail: unknown;
      constructor(t: string, o?: { detail?: unknown }) {
        super(t);
        this.detail = o?.detail;
      }
    };
  });
  afterEach(() => localStorage.clear());

  it("defaults to the server's voice, keeps Drive's old 'device voice' setting, and saves a choice", () => {
    expect(readVoiceChoice()).toBe("");
    localStorage.setItem("cc.drive.serverVoice", "0");
    expect(readVoiceChoice()).toBe("device");
    writeVoiceChoice("piper:alba");
    expect(readVoiceChoice()).toBe("piper:alba");
  });

  it("speaks with the chosen server voice, or the device's own", async () => {
    const asked: (string | undefined)[] = [];
    const api = { speak: async (_t: string, voice?: string) => (asked.push(voice), new Blob()) };
    const config = { tts: { provider: "local", model: "m", voice: "piper:cori" } } as VoiceConfig;
    const browser = {} as BrowserSpeaker;
    const chosen = speakerFor(api, config, "piper:alba", browser);
    expect(chosen).toBeInstanceOf(ServerSpeaker);
    await (chosen as unknown as { synthesize: (t: string) => Promise<Blob> }).synthesize("hi");
    expect(asked).toEqual(["piper:alba"]);
    expect(speakerFor(api, config, "device", browser)).toBe(browser);
    // No server voice at all: the device's.
    expect(speakerFor(api, { ...config, tts: null }, "piper:alba", browser)).toBe(browser);
  });

  it("labels a voice with what choosing it will do", () => {
    const v = { id: "piper:alba", label: "Alba", description: "Scottish female · fast", tier: "fast" as const, sizeMb: 64, error: null, isDefault: false };
    expect(voiceLabel({ ...v, status: "ready" })).toBe("Alba · Scottish female · fast");
    expect(voiceLabel({ ...v, status: "missing" })).toBe("Alba · Scottish female · fast (downloads 64 MB)");
    expect(voiceLabel({ ...v, status: "installing", isDefault: true })).toBe("Alba · Scottish female · fast · default (downloading…)");
  });
});
