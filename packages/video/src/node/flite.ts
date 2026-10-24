import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateWordTimings } from "../timeline";
import type { TextToSpeech } from "../tts/types";
import { wavDuration } from "../tts/wav";
import { runFfmpeg } from "./ffmpeg";

/**
 * Free, offline TTS through ffmpeg's `flite` filter (CMU Flite). Robotic, but
 * real speech: good for drafts and for checking timing before paying for a
 * voice. Needs an ffmpeg built with libflite (most Linux distro builds; the
 * common Windows builds don't have it, so Windows drafts use "silent").
 */
export function fliteProvider(options: { ffmpegBin: string; dir: string; voice?: "slt" | "kal" | "kal16" | "awb" | "rms" }): TextToSpeech {
  return {
    id: "flite",
    local: true,
    usdPerMinute: 0,
    async synthesize(text, req = {}) {
      await mkdir(options.dir, { recursive: true });
      const key = createHash("sha1").update(`${req.voiceId}|${req.speed}|${text}`).digest("hex").slice(0, 12);
      const textFile = `flite-${key}.txt`;
      const wavFile = `flite-${key}.wav`;
      await writeFile(join(options.dir, textFile), text);
      const voice = /^(slt|kal|kal16|awb|rms)$/.test(req.voiceId ?? "") ? req.voiceId! : (options.voice ?? "slt");
      const tempo = req.speed && req.speed !== 1 ? [`-af`, `atempo=${req.speed}`] : [];
      // The text goes in through a file, so nothing in it is parsed as filter syntax.
      await runFfmpeg(options.ffmpegBin, ["-f", "lavfi", "-i", `flite=textfile=${textFile}:voice=${voice}`, ...tempo, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", wavFile], {
        cwd: options.dir,
        signal: req.signal,
      });
      const audio = new Uint8Array(await readFile(join(options.dir, wavFile)));
      await rm(join(options.dir, textFile), { force: true });
      await rm(join(options.dir, wavFile), { force: true });
      const durationSec = Math.round(wavDuration(audio) * 1000) / 1000;
      return { audio, mime: "audio/wav", durationSec, words: estimateWordTimings(text, durationSec), alignedWords: false };
    },
  };
}
