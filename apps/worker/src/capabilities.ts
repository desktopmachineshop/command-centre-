import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Capability } from "@cc/core";

/** Finds an executable on PATH (honouring PATHEXT on Windows). Absolute paths are checked as-is. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  const candidates = isAbsolute(bin) ? [bin] : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const base of candidates) for (const ext of exts) if (existsSync(base + ext)) return base + ext;
  return null;
}

/** Runs a probe command without a shell; resolves to stdout, or null if it fails. */
function probe(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true, ...(env ? { env } : {}) }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function detectGpu(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<boolean> {
  const nvsmi =
    which("nvidia-smi", env, platform) ??
    (platform === "win32" ? which(join(env.ProgramFiles ?? "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"), env, platform) : null);
  if (nvsmi && (await probe(nvsmi, ["-L"]))?.includes("GPU")) return true;
  if (platform !== "win32") return false;
  // Non-NVIDIA cards on Windows: ask WMI for a real (not "Basic Display") adapter.
  const names = await probe("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]);
  return !!names && /nvidia|radeon|amd|intel\(r\) arc/i.test(names);
}

/** Known DaVinci Resolve install locations and its scripting module, per platform. */
export function davinciPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programData = env.PROGRAMDATA ?? "C:\\ProgramData";
    return [
      join(programFiles, "Blackmagic Design", "DaVinci Resolve", "Resolve.exe"),
      join(programData, "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting", "Modules", "DaVinciResolveScript.py"),
      ...(env.RESOLVE_SCRIPT_API ? [env.RESOLVE_SCRIPT_API] : []),
    ];
  }
  if (platform === "darwin") return ["/Applications/DaVinci Resolve/DaVinci Resolve.app"];
  return ["/opt/resolve/bin/resolve"];
}

/** The Python that runs davinci.render's script, unless worker.json sets `pythonBin`. */
export function defaultPython(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "python" : "python3";
}

/**
 * The environment Resolve's scripting module needs (Blackmagic's README, "Scripting"): where the
 * API and fusionscript library are, and the Modules folder on PYTHONPATH. Values already set win.
 */
export function resolveEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let api: string;
  let lib: string;
  if (platform === "win32") {
    api = join(env.PROGRAMDATA ?? "C:\\ProgramData", "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting");
    lib = join(env.ProgramFiles ?? "C:\\Program Files", "Blackmagic Design", "DaVinci Resolve", "fusionscript.dll");
  } else if (platform === "darwin") {
    api = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting";
    lib = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so";
  } else {
    api = "/opt/resolve/Developer/Scripting";
    lib = "/opt/resolve/libs/Fusion/fusionscript.so";
  }
  const scriptApi = env.RESOLVE_SCRIPT_API ?? api;
  const modules = join(scriptApi, "Modules");
  const pythonPath = env.PYTHONPATH ? `${env.PYTHONPATH}${delimiter}${modules}` : modules;
  return { ...env, RESOLVE_SCRIPT_API: scriptApi, RESOLVE_SCRIPT_LIB: env.RESOLVE_SCRIPT_LIB ?? lib, PYTHONPATH: pythonPath };
}

/**
 * `davinci`: Resolve is installed and Python can import its scripting module. Resolve itself
 * doesn't have to be running yet; a job started while it's closed fails and says so.
 */
async function detectDavinci(pythonBin: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!davinciPaths(platform, env).some((p) => existsSync(p))) return false;
  const python = which(pythonBin, env, platform);
  if (!python) return false;
  return (await probe(python, ["-c", "import DaVinciResolveScript; print('ok')"], resolveEnv(platform, env)))?.includes("ok") ?? false;
}

export interface DetectOptions {
  ffmpegBin: string;
  claudeBin: string;
  /** Python for davinci.render; defaults to defaultPython(). */
  pythonBin?: string;
  /** Configured Chromium; `browser` is detected when it exists. */
  chromiumBin?: string | null;
  overrides?: Partial<Record<Capability, boolean>>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Probes this machine for what it can do. Overrides from config win over detection. */
export async function detectCapabilities(options: DetectOptions): Promise<Capability[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const detected: Record<Capability, boolean> = {
    ffmpeg: which(options.ffmpegBin, env, platform) !== null,
    gpu: await detectGpu(platform, env),
    davinci: await detectDavinci(options.pythonBin ?? defaultPython(platform), platform, env),
    "claude-local": which(options.claudeBin, env, platform) !== null,
    browser: !!options.chromiumBin && which(options.chromiumBin, env, platform) !== null,
  };
  const merged = { ...detected, ...options.overrides };
  return (Object.keys(merged) as Capability[]).filter((c) => merged[c]);
}
