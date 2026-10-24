import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Capability } from "@cc/core";
import { z } from "zod";

/** Config file shape. The desktop app writes the same file, so unknown keys are kept on save. */
const FileConfig = z.looseObject({
  serverUrl: z.string().optional(),
  token: z.string().optional(),
  nodeId: z.string().optional(),
  nodeName: z.string().optional(),
  workDir: z.string().optional(),
  /** Force a capability on or off, overriding detection. */
  capabilities: z.partialRecord(Capability, z.boolean()).optional(),
  ffmpegBin: z.string().optional(),
  claudeBin: z.string().optional(),
  /** Chromium or Chrome for video.capture (turns on the `browser` capability when it exists). */
  chromiumBin: z.string().optional(),
  /** Signed-in browser profiles for capture, by name: paths to Playwright storage-state JSON files. */
  captureProfiles: z.record(z.string(), z.string()).optional(),
  /** Directories `claude.local` jobs may run in (besides the work dir). */
  claudeDirs: z.array(z.string()).optional(),
});
type FileConfig = z.infer<typeof FileConfig>;

export interface WorkerConfig {
  configPath: string;
  /** WebSocket URL of the server's `/ws` endpoint. */
  wsUrl: string;
  token: string;
  nodeId: string;
  nodeName: string;
  workDir: string;
  /** Exact capability list (from flags/env), skipping detection. */
  capabilities: Capability[] | null;
  capabilityOverrides: Partial<Record<Capability, boolean>>;
  ffmpegBin: string;
  claudeBin: string;
  claudeDirs: string[];
  chromiumBin: string | null;
  captureProfiles: Record<string, string>;
  /** Print machine-readable `CC_STATUS {...}` lines for the desktop app. */
  statusJson: boolean;
}

/** Per-user app-data directory: %APPDATA%\CommandCentre on Windows. */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "CommandCentre");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "CommandCentre");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "command-centre");
}

/** Turns `https://cc.example.com` (or a ws URL, with or without `/ws`) into the WebSocket endpoint. */
export function toWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`Unsupported server URL: ${serverUrl}`);
  if (!url.pathname.endsWith("/ws")) url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

export function readConfigFile(path: string): FileConfig {
  if (!existsSync(path)) return {};
  return FileConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Merges new keys into the config file, keeping everything else in it. */
export function updateConfigFile(path: string, patch: Partial<FileConfig>): void {
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

/**
 * Resolves config from CLI flags, then env vars, then the config file. A node
 * id is generated on first run and saved so the server sees the same node.
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const { values: flags } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      server: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      "work-dir": { type: "string" },
      capabilities: { type: "string" },
      "status-json": { type: "boolean" },
    },
    strict: true,
  });

  const configPath = resolve(flags.config ?? env.CC_WORKER_CONFIG ?? join(appDataDir(env), "worker.json"));
  const file = readConfigFile(configPath);

  const serverUrl = flags.server ?? env.CC_SERVER_URL ?? file.serverUrl;
  const token = flags.token ?? env.CC_WORKER_TOKEN ?? file.token;
  if (!serverUrl) throw new Error(`No server URL. Set serverUrl in ${configPath}, CC_SERVER_URL or --server.`);
  if (!token) throw new Error(`No worker token. Set token in ${configPath}, CC_WORKER_TOKEN or --token.`);

  let nodeId = env.CC_NODE_ID ?? file.nodeId;
  if (!nodeId) {
    nodeId = randomUUID();
    updateConfigFile(configPath, { nodeId });
  }

  const capsList = flags.capabilities ?? env.CC_CAPABILITIES;
  return {
    configPath,
    wsUrl: toWsUrl(serverUrl),
    token,
    nodeId,
    nodeName: flags.name ?? env.CC_NODE_NAME ?? file.nodeName ?? hostname(),
    workDir: resolve(flags["work-dir"] ?? env.CC_WORK_DIR ?? file.workDir ?? join(dirname(configPath), "work")),
    capabilities: capsList === undefined ? null : z.array(Capability).parse(capsList.split(",").map((c) => c.trim()).filter(Boolean)),
    capabilityOverrides: file.capabilities ?? {},
    ffmpegBin: env.CC_FFMPEG_BIN ?? file.ffmpegBin ?? "ffmpeg",
    claudeBin: env.CC_CLAUDE_BIN ?? file.claudeBin ?? "claude",
    claudeDirs: (file.claudeDirs ?? []).map((d) => resolve(d)),
    chromiumBin: env.CC_CHROMIUM_BIN ?? file.chromiumBin ?? null,
    captureProfiles: Object.fromEntries(Object.entries(file.captureProfiles ?? {}).map(([name, path]) => [name, resolve(path)])),
    statusJson: flags["status-json"] ?? false,
  };
}
