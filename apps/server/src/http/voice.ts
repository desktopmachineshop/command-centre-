import { baseMime, UPLOAD_TYPES, VoiceProviderError } from "@cc/voice";
import { Hono } from "hono";
import { z } from "zod";
import { ReplyStateError, type VoiceConversations } from "../voice/conversations";
import type { VoiceService } from "../voice/service";

export interface VoiceApiDeps {
  service: VoiceService;
  conversations: VoiceConversations;
}

const providerError = (err: unknown) =>
  err instanceof VoiceProviderError ? { error: err.message, provider: err.provider } : { error: "speech provider failed" };

/**
 * Drive mode API, mounted under /api behind the same auth as the rest of it:
 * - GET  /voice/config            which server speech providers exist (none: the PWA uses browser speech)
 * - POST /voice/transcribe        audio (raw body or multipart "file") → {text}
 * - POST /voice/speak             {text, voice?} → audio
 * - GET  /voice/briefing          deterministic spoken summary
 * - GET  /voice/approvals/next    the next pending proposal, described for reading aloud
 * - POST /tasks/:id/reply         {text, voice?} continues a task's conversation
 */
export function voiceApiRoutes(deps: VoiceApiDeps) {
  const { service, conversations } = deps;
  const app = new Hono();

  app.get("/voice/config", (c) => c.json(service.config()));

  app.post("/voice/transcribe", async (c) => {
    const stt = service.stt;
    if (!stt) return c.json({ error: "no speech-to-text provider configured; use the browser's speech recognition" }, 503);
    const { maxUploadBytes, maxSeconds, language } = service.options;
    const tooLarge = () => c.json({ error: `recording is larger than ${Math.round(maxUploadBytes / 1024)} KB` }, 413);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxUploadBytes + 16 * 1024) return tooLarge();
    // The PWA declares the recording's length; Infinity/NaN mean it didn't.
    const seconds = Number(c.req.query("seconds") ?? c.req.header("x-cc-audio-seconds"));
    if (Number.isFinite(seconds) && seconds > maxSeconds) return c.json({ error: `recording is longer than ${maxSeconds} seconds` }, 413);

    let mime = baseMime(c.req.header("content-type") ?? "");
    let audio: Uint8Array;
    if (mime === "multipart/form-data") {
      const file = (await c.req.formData()).get("file");
      if (!(file instanceof File)) return c.json({ error: 'multipart upload needs a "file" field' }, 400);
      mime = baseMime(file.type);
      if (file.size > maxUploadBytes) return tooLarge();
      if (!UPLOAD_TYPES[mime]) return c.json({ error: `unsupported audio type ${mime || "(none)"}` }, 415);
      audio = new Uint8Array(await file.arrayBuffer());
    } else {
      if (!UPLOAD_TYPES[mime]) return c.json({ error: `unsupported audio type ${mime || "(none)"}` }, 415);
      const read = await readLimited(c.req.raw.body, maxUploadBytes);
      if (read === "too-large") return tooLarge();
      audio = read;
    }
    if (audio.byteLength === 0) return c.json({ error: "empty recording" }, 400);
    try {
      const result = await stt.transcribe(audio, mime, { language: c.req.query("language") || language });
      if (result.durationSeconds && result.durationSeconds > maxSeconds + 5) {
        return c.json({ error: `recording is longer than ${maxSeconds} seconds` }, 413);
      }
      return c.json({ text: result.text, language: result.language ?? null, provider: stt.provider });
    } catch (err) {
      console.error("[voice] transcribe", err instanceof Error ? err.message : err);
      return c.json(providerError(err), 502);
    }
  });

  app.post("/voice/speak", async (c) => {
    if (!service.tts) return c.json({ error: "no text-to-speech provider configured; use the browser's speech synthesis" }, 503);
    const body = z.object({ text: z.string().trim().min(1).max(2000), voice: z.string().max(100).optional() }).parse(await c.req.json());
    try {
      const { audio, mime, cached } = await service.speak(body.text, body.voice);
      return c.body(audio as Uint8Array<ArrayBuffer>, 200, {
        "content-type": mime,
        "cache-control": "private, max-age=86400",
        "x-cc-cache": cached ? "hit" : "miss",
      });
    } catch (err) {
      console.error("[voice] speak", err instanceof Error ? err.message : err);
      return c.json(providerError(err), 502);
    }
  });

  app.get("/voice/briefing", async (c) => c.json(await service.briefing()));

  app.get("/voice/approvals/next", async (c) => {
    const skip = (c.req.query("skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return c.json(await service.nextApproval(skip));
  });

  app.post("/tasks/:id/reply", async (c) => {
    const body = z.object({ text: z.string().trim().min(1).max(4000), voice: z.boolean().optional() }).parse(await c.req.json());
    try {
      const task = await conversations.reply(c.req.param("id"), body.text, body.voice ?? false);
      return task ? c.json(task, 202) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof ReplyStateError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  return app;
}

/** Reads a request body, giving up once it passes `max` bytes. */
async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | "too-large"> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
