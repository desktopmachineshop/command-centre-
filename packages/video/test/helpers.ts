import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BRANDS, type VideoSpecInput } from "../src";
import { playwrightRecorderInstalled } from "../src/node";

/** Chromium for capture tests: CC_CHROMIUM_BIN, or the sandbox's Playwright browser. */
export const CHROMIUM = process.env.CC_CHROMIUM_BIN ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);

export const FFMPEG = process.env.CC_FFMPEG_BIN ?? "ffmpeg";
export const HAS_FFMPEG = (() => {
  try {
    execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
    execFileSync(FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** playwright-core is installed and its video recorder is downloaded. */
export const HAS_PLAYWRIGHT = (() => {
  try {
    import.meta.resolve("playwright-core");
  } catch {
    return false;
  }
  return playwrightRecorderInstalled();
})();

export function minimalSpec(overrides: Partial<VideoSpecInput> = {}): VideoSpecInput {
  return {
    id: "test-video",
    title: "Test",
    product: "opend",
    type: "short",
    format: "9:16",
    brand: BRANDS.opend,
    scenes: [
      { id: "hook", kind: "title", heading: "Docs that ship", narration: "Ship docs faster." },
      { id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://docs.opend.app/" }], narration: "Here is the editor in action today." },
      { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it", narration: "Try OpenD." },
    ],
    ...overrides,
  };
}
