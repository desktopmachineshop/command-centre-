import type { Capability } from "@cc/core";
import { prepareCapture } from "./browser";
import { detectCapabilities, which } from "./capabilities";
import { WorkerClient, type WorkerStatus } from "./client";
import type { WorkerConfig } from "./config";
import { claudeHandler } from "./handlers/claude";
import { echoHandler } from "./handlers/echo";
import { ffmpegHandler } from "./handlers/ffmpeg";
import { HandlerRegistry } from "./handlers/registry";
import { videoCaptureHandler, videoRenderHandler } from "./handlers/video";

export * from "./browser";
export * from "./capabilities";
export * from "./client";
export * from "./config";
export * from "./handlers/registry";
export * from "./storage";
export { claudeHandler, echoHandler, ffmpegHandler, videoCaptureHandler, videoRenderHandler };

/** The built-in job kinds. Add new handlers here. */
export function defaultRegistry(
  config: Pick<WorkerConfig, "ffmpegBin" | "claudeBin" | "claudeDirs" | "workDir"> & Partial<Pick<WorkerConfig, "chromiumBin" | "captureProfiles">>,
  capabilities: Capability[] = [],
): HandlerRegistry {
  const ffmpegBin = which(config.ffmpegBin) ?? config.ffmpegBin;
  const video = {
    ffmpegBin,
    chromiumBin: config.chromiumBin ? (which(config.chromiumBin) ?? config.chromiumBin) : undefined,
    captureProfiles: config.captureProfiles,
    gpu: capabilities.includes("gpu"),
  };
  return new HandlerRegistry()
    .register(echoHandler)
    .register(ffmpegHandler(ffmpegBin))
    .register(claudeHandler({ bin: which(config.claudeBin) ?? config.claudeBin, allowedDirs: [config.workDir, ...config.claudeDirs] }))
    .register(videoCaptureHandler(video))
    .register(videoRenderHandler(video));
}

/** Detects capabilities and builds a ready-to-start client from resolved config. */
export async function createWorker(config: WorkerConfig, options: { onStatus?: (s: WorkerStatus) => void; log?: (line: string) => void } = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  // Screen capture: find a browser and Playwright, and fetch its recorder once. `browser` is
  // only offered when all of it is in place (browser.ts), unless worker.json switches it off.
  const captureOff = config.capabilityOverrides.browser === false || (config.capabilities !== null && !config.capabilities.includes("browser"));
  const capture = captureOff ? { chromiumBin: null, ready: false, why: "switched off in the worker's settings" } : await prepareCapture(config.chromiumBin, { log });
  log(capture.ready ? `[capture] screen capture ready with ${capture.chromiumBin}` : `[capture] screen capture off: ${capture.why}`);
  const capabilities =
    config.capabilities ??
    (await detectCapabilities({
      ffmpegBin: config.ffmpegBin,
      claudeBin: config.claudeBin,
      chromiumBin: capture.ready ? capture.chromiumBin : null,
      overrides: config.capabilityOverrides,
    }));
  return new WorkerClient({
    wsUrl: config.wsUrl,
    token: config.token,
    node: { id: config.nodeId, name: config.nodeName, capabilities },
    registry: defaultRegistry({ ...config, chromiumBin: capture.chromiumBin ?? config.chromiumBin }, capabilities),
    workDir: config.workDir,
    ...options,
  });
}
