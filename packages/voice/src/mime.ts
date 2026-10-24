import type { AudioFormat } from "./types";

export const MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  pcm: "audio/L16",
};

/** Audio types the transcription endpoint accepts (what MediaRecorder produces on Chrome, Safari and Firefox, plus common files). */
export const UPLOAD_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/** The bare media type ("audio/webm;codecs=opus" → "audio/webm"), lower-cased. */
export function baseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

/** File extension providers use to sniff the container. */
export function extensionFor(mime: string): string {
  return UPLOAD_TYPES[baseMime(mime)] ?? "webm";
}
