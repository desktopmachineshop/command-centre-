import { detectCapabilities, which } from "./capabilities";
import { WorkerClient, type WorkerStatus } from "./client";
import type { WorkerConfig } from "./config";
import { claudeHandler } from "./handlers/claude";
import { echoHandler } from "./handlers/echo";
import { ffmpegHandler } from "./handlers/ffmpeg";
import { HandlerRegistry } from "./handlers/registry";

export * from "./capabilities";
export * from "./client";
export * from "./config";
export * from "./handlers/registry";
export { claudeHandler, echoHandler, ffmpegHandler };

/** The built-in job kinds. Add new handlers here. */
export function defaultRegistry(config: Pick<WorkerConfig, "ffmpegBin" | "claudeBin" | "claudeDirs" | "workDir">): HandlerRegistry {
  return new HandlerRegistry()
    .register(echoHandler)
    .register(ffmpegHandler(which(config.ffmpegBin) ?? config.ffmpegBin))
    .register(claudeHandler({ bin: which(config.claudeBin) ?? config.claudeBin, allowedDirs: [config.workDir, ...config.claudeDirs] }));
}

/** Detects capabilities and builds a ready-to-start client from resolved config. */
export async function createWorker(config: WorkerConfig, options: { onStatus?: (s: WorkerStatus) => void; log?: (line: string) => void } = {}) {
  const capabilities =
    config.capabilities ??
    (await detectCapabilities({ ffmpegBin: config.ffmpegBin, claudeBin: config.claudeBin, overrides: config.capabilityOverrides }));
  return new WorkerClient({
    wsUrl: config.wsUrl,
    token: config.token,
    node: { id: config.nodeId, name: config.nodeName, capabilities },
    registry: defaultRegistry(config),
    workDir: config.workDir,
    ...options,
  });
}
