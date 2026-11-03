import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { playwrightRecorderInstalled, setPlaywrightLoader } from "@cc/video/node";
import { which } from "./capabilities";

/**
 * Screen capture (`video.capture`, the `browser` capability) needs three things on the PC:
 *
 * 1. Chrome, Edge or Chromium. `chromiumBin` in worker.json wins; otherwise the usual
 *    install locations are searched, so a normal Windows PC (which always has Edge) works.
 * 2. playwright-core. The desktop app ships it as a folder beside the worker
 *    (`playwright-core/`, copied in by scripts/build.mjs and bundled by Tauri). The worker is a
 *    Node single executable whose plain `require` only sees built-in modules, so it is loaded
 *    from disk with `createRequire`.
 * 3. Playwright's own ffmpeg build, which records the video. It is downloaded once (a few MB,
 *    into the usual ms-playwright cache) the first time the worker starts with 1 and 2.
 *
 * Only when all three are there does the node offer `browser`, so the server never hands it a
 * capture job it can't run.
 */

/** Chrome, Edge or Chromium in their usual places, in order of preference. */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const roots = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      ...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((r) => join(r, "Chromium", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
}

/** The browser to capture with: the configured one if it exists, else the first one installed. */
export function findBrowser(configured: string | null | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (configured) return which(configured, env, platform);
  for (const candidate of browserCandidates(env, platform)) {
    const found = which(candidate, env, platform);
    if (found) return found;
  }
  return null;
}

const isPlaywrightDir = (dir: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "playwright-core";
  } catch {
    return false;
  }
};

/**
 * playwright-core's folder: `CC_PLAYWRIGHT_DIR`, then beside the executable (the desktop app),
 * then the normal package resolution from the running script (development, `tsx src/main.ts`).
 */
export function findPlaywrightDir(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, script = process.argv[1]): string | null {
  const beside = [join(dirname(execPath), "playwright-core"), join(dirname(execPath), "binaries", "playwright-core"), join(dirname(execPath), "resources", "playwright-core")];
  for (const dir of [env.CC_PLAYWRIGHT_DIR, ...beside].filter(Boolean) as string[]) {
    if (isPlaywrightDir(dir)) return dir;
  }
  try {
    const dir = dirname(createRequire(resolve(script ?? "worker.js")).resolve("playwright-core/package.json"));
    return isPlaywrightDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Loads playwright-core from its folder (works inside a single executable too). */
export function loadPlaywrightFrom(dir: string): () => Promise<typeof import("playwright-core")> {
  return async () => createRequire(join(dir, "package.json"))("./index.js");
}

/**
 * Downloads Playwright's recorder with its own installer (`cli.js install ffmpeg`), in a child
 * process so its exit doesn't end the worker. Resolves true once it's there. Inside the single
 * executable, `process.execPath` is the worker itself: main.ts sees the Playwright script and
 * runs it (as it does for the download helper Playwright starts the same way).
 */
export function installRecorder(dir: string, options: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<RecorderInstall> {
  return new Promise((done) => {
    // Its last lines, so a failure can say why on the Devices page (the log isn't visible there).
    const tail: string[] = [];
    const keep = (line: string) => {
      if (/[■|]{3,}|\d+% of /.test(line)) return; // progress bars
      tail.push(line);
      if (tail.length > 4) tail.shift();
    };
    const detail = () => tail.join(" · ").slice(0, 240);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [join(dir, "cli.js"), "install", "ffmpeg"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return done({ ok: false, detail: `couldn't start it: ${(err as Error).message}` });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 5 * 60_000);
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        options.log?.(`[capture] ${line.trim()}`);
        keep(line.trim());
      }
    };
    child.stdout!.on("data", forward);
    child.stderr!.on("data", forward);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, detail: `couldn't start it: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && playwrightRecorderInstalled()) return done({ ok: true, detail: "" });
      const why = timedOut ? "timed out" : code === 0 ? "it finished but the recorder isn't there" : `exit code ${code}`;
      done({ ok: false, detail: [why, detail()].filter(Boolean).join(": ") });
    });
  });
}

export interface RecorderInstall {
  ok: boolean;
  /** Why it failed: exit code and the download's last lines. */
  detail: string;
}

/** Where Playwright looks for its recorder: `<cache>/ms-playwright/ffmpeg-<revision>/<exe>`. */
export function recorderPath(playwrightDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  let revision: string | undefined;
  try {
    const browsers = JSON.parse(readFileSync(join(playwrightDir, "browsers.json"), "utf8")) as { browsers: { name: string; revision: string }[] };
    revision = browsers.browsers.find((b) => b.name === "ffmpeg")?.revision;
  } catch {
    return null;
  }
  if (!revision) return null;
  const exe = platform === "win32" ? "ffmpeg-win64.exe" : platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux";
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0"
      ? env.PLAYWRIGHT_BROWSERS_PATH
      : platform === "win32"
        ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
        : platform === "darwin"
          ? join(homedir(), "Library", "Caches", "ms-playwright")
          : join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
  return join(cache, `ffmpeg-${revision}`, exe);
}

/**
 * When Playwright's own recorder can't be downloaded: use the ffmpeg already on this computer
 * (Media production installs it), copied to where Playwright looks. Playwright records VP8
 * WebM, which full ffmpeg builds (winget's Gyan.FFmpeg) include. Returns what it did, or null.
 */
export function useSystemFfmpeg(playwrightDir: string, ffmpegBin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const ffmpeg = which(ffmpegBin, env, platform);
  const target = recorderPath(playwrightDir, env, platform);
  if (!ffmpeg || !target) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(ffmpeg, target);
    writeFileSync(join(dirname(target), "INSTALLATION_COMPLETE"), "");
    return ffmpeg;
  } catch {
    return null;
  }
}

/**
 * The playwright-core folder a script belongs to, if the worker was started to run one
 * (`cc-worker <playwright-core>/cli.js install ffmpeg`, or a helper Playwright forks).
 */
export function playwrightScript(arg: string | undefined): string | null {
  if (!arg || !/\.js$/.test(arg) || !isAbsolute(arg)) return null;
  for (let dir = dirname(arg); dir !== dirname(dir); dir = dirname(dir)) {
    if (isPlaywrightDir(dir)) return dir;
  }
  return null;
}

/** Runs a Playwright script in this process, as `node <script> ...args` would. */
export function runPlaywrightScript(script: string, args: string[]): void {
  process.argv = [process.execPath, script, ...args];
  createRequire(script)(script);
}

export interface CaptureSetup {
  /** The browser to drive, when one was found (passed to the capture handler either way). */
  chromiumBin: string | null;
  /** Everything is in place: the node may offer `browser`. */
  ready: boolean;
  /** Why not, for the log. */
  why?: string;
}

export interface CaptureDeps {
  findBrowser: typeof findBrowser;
  findPlaywrightDir: () => string | null;
  recorderInstalled: () => boolean;
  installRecorder: (dir: string) => Promise<RecorderInstall | boolean>;
  /** Falls back to this computer's own ffmpeg; returns its path, or null. */
  useSystemFfmpeg?: (dir: string) => string | null;
  /** Loads playwright-core from the folder (throws if it can't) and makes capture use it. */
  usePlaywright: (dir: string) => Promise<void>;
}

const defaultDeps = (log?: (line: string) => void, ffmpegBin = "ffmpeg"): CaptureDeps => ({
  findBrowser,
  findPlaywrightDir: () => findPlaywrightDir(),
  recorderInstalled: () => playwrightRecorderInstalled(),
  installRecorder: (dir) => installRecorder(dir, { log }),
  useSystemFfmpeg: (dir) => useSystemFfmpeg(dir, ffmpegBin),
  usePlaywright: async (dir) => {
    const load = loadPlaywrightFrom(dir);
    await load();
    setPlaywrightLoader(load);
  },
});

/** Gets screen capture ready (installing the recorder if needed) and says whether it is. */
export async function prepareCapture(
  configured: string | null | undefined,
  options: { log?: (line: string) => void; deps?: Partial<CaptureDeps>; ffmpegBin?: string } = {},
): Promise<CaptureSetup> {
  const deps = { ...defaultDeps(options.log, options.ffmpegBin), ...options.deps };
  const chromiumBin = deps.findBrowser(configured);
  if (!chromiumBin) {
    return { chromiumBin, ready: false, why: configured ? `chromiumBin ${configured} wasn't found` : "no Chrome, Edge or Chromium found (install one, or set chromiumBin in worker.json)" };
  }
  const dir = deps.findPlaywrightDir();
  if (!dir) return { chromiumBin, ready: false, why: "playwright-core isn't installed beside the worker (update the desktop app, or set CC_PLAYWRIGHT_DIR)" };
  try {
    await deps.usePlaywright(dir);
  } catch (err) {
    return { chromiumBin, ready: false, why: `playwright-core in ${dir} couldn't be loaded: ${(err as Error).message}` };
  }
  if (!deps.recorderInstalled()) {
    options.log?.("[capture] downloading Playwright's video recorder (one time, a few MB)…");
    const result = await deps.installRecorder(dir);
    const install = typeof result === "boolean" ? { ok: result, detail: "" } : result;
    if (!install.ok) {
      const fallback = deps.useSystemFfmpeg?.(dir);
      if (fallback && deps.recorderInstalled()) {
        options.log?.(`[capture] recorder download failed (${install.detail}); recording with ${fallback} instead`);
      } else {
        const detail = install.detail ? ` (${install.detail})` : "";
        return {
          chromiumBin,
          ready: false,
          why: `Playwright's video recorder couldn't be downloaded${detail}, and there's no ffmpeg on this computer to record with instead. Install ffmpeg (Media production), then press Install again`,
        };
      }
    }
  }
  return { chromiumBin, ready: true };
}
