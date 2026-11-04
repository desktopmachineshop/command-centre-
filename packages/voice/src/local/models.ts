import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Fetch } from "../types";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/** One open model, downloaded once from the sherpa-onnx releases into the models folder. */
export interface LocalModel {
  /** Folder name inside the release archive (and on disk). */
  dir: string;
  url: string;
  /** Files that must exist for the model to count as installed. */
  files: string[];
  /** Approximate download size, for the logs. */
  mb: number;
}

/**
 * Streaming English recognition (Kroko Zipformer: cased and punctuated, about 0.1x real time on
 * two CPU threads) and the Kokoro voice (British speakers, about 0.6x real time on four).
 */
export const LOCAL_MODELS = {
  asr: {
    dir: "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    url: `${RELEASES}/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2`,
    files: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
    mb: 57,
  },
  tts: {
    dir: "kokoro-en-v0_19",
    url: `${RELEASES}/tts-models/kokoro-en-v0_19.tar.bz2`,
    files: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    mb: 320,
  },
} satisfies Record<string, LocalModel>;

export type LocalModelName = keyof typeof LOCAL_MODELS;

/** Kokoro v0.19 speaker ids by voice name. */
export const KOKORO_VOICES: Record<string, number> = {
  af: 0,
  af_bella: 1,
  af_nicole: 2,
  af_sarah: 3,
  af_sky: 4,
  am_adam: 5,
  am_michael: 6,
  bf_emma: 7,
  bf_isabella: 8,
  bm_george: 9,
  bm_lewis: 10,
};

export function modelPath(root: string, model: LocalModel, file = ""): string {
  return join(root, model.dir, file);
}

export function isInstalled(root: string, model: LocalModel): boolean {
  return model.files.every((f) => existsSync(modelPath(root, model, f)));
}

/**
 * Downloads and unpacks `model` into `root` unless it is already there. Unpacks into a temporary
 * folder first, so a half-finished download never looks installed. Needs `tar` with bzip2.
 */
export async function installModel(root: string, model: LocalModel, fetch: Fetch = globalThis.fetch): Promise<void> {
  if (isInstalled(root, model)) return;
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.partial-${model.dir}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const res = await fetch(model.url);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xjf", "-", "-C", tmp], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      tar.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`))));
      const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("error", reject);
      body.pipe(tar.stdin);
    });
    await rm(join(tmp, model.dir, "test_wavs"), { recursive: true, force: true });
    await rm(modelPath(root, model), { recursive: true, force: true });
    await rename(join(tmp, model.dir), modelPath(root, model));
    if (!isInstalled(root, model)) throw new Error("archive is missing model files");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
