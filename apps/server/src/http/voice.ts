import { baseMime, UPLOAD_TYPES, VoiceProviderError } from "@cc/voice";
import { Hono } from "hono";
import { z } from "zod";
import { ChatFileIds, type ChatFiles } from "../chat-files";
import { ReplyStateError, type VoiceConversations } from "../voice/conversations";
import type { VoiceFront } from "../voice/front";
import type { VoiceService } from "../voice/service";
import { VoiceNotInstalledError } from "@cc/voice/local";

export interface VoiceApiDeps {
  service: VoiceService;
  conversations: VoiceConversations;
  /** Files attached to a reply in the chat box (see ../chat-files.ts). */
  chatFiles?: ChatFiles;
  /** Drive mode's fast voice front (null when off, e.g. with the echo runner). */
  front?: () => VoiceFront | null;
  /**
   * Creates the agent task for a handed-off request, as POST /api/chat with `voice: true` does.
   * `context`: what Dave had just heard in Drive mode, so the agent can tell what "that" means.
   */
  handOff?: (request: { text: string; vertical?: string; role?: string; context?: string }) => Promise<{ taskId: string | null }>;
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
 * - POST /tasks/:id/reply         {text, voice?, files?} continues a task's conversation (files: ids from POST /chat/files)
 * - POST /voice/warm              loads the speech engines and the voice front ahead of use
 * - POST /voice/turn              {text, ..., lastTaskId?, lastAnswer?} → NDJSON stream: {delta} chunks, then
 *                                 {done, handoff?: {taskId, continued}}; a follow-up continues lastTaskId
 * Live transcription is a WebSocket at /ws/voice (http/voice-listen.ts).
 */
/** What Dave had just heard, for a new task handed off from Drive mode. Pure. */
export function heardContext(lastSpoken?: string | null, lastAnswer?: string | null): string | undefined {
  const parts = [lastAnswer?.trim() ? `the agents' last answer: "${lastAnswer.trim().slice(0, 1500)}"` : null];
  if (lastSpoken?.trim() && lastSpoken.trim() !== lastAnswer?.trim()) parts.push(`the last thing he heard: "${lastSpoken.trim().slice(0, 600)}"`);
  const said = parts.filter(Boolean);
  return said.length ? said.join("; ") : undefined;
}

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

  app.get("/voice/voices", async (c) => c.json(await service.voices()));

  app.post("/voice/voices/:id/install", async (c) => {
    const id = c.req.param("id");
    // Answers at once: the download runs on, and GET /voice/voices shows its progress.
    const job = service.installVoice(id);
    job.catch((err) => console.error("[voice] install", id, (err as Error).message));
    return c.json(await service.voices(), 202);
  });

  app.post("/voice/speak", async (c) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(2000), voice: z.string().max(100).optional(), fallback: z.boolean().optional() })
      .parse(await c.req.json());
    if (!service.tts && !(body.voice && service.options.local)) return c.json({ error: "no text-to-speech provider configured; use the browser's speech synthesis" }, 503);
    try {
      const { audio, mime, cached, voice, fellBack } = await service.speak(body.text, body.voice, { fallback: body.fallback });
      return c.body(audio as Uint8Array<ArrayBuffer>, 200, {
        "content-type": mime,
        // A fallback isn't cached by the browser: the provider may work again on the next try.
        "cache-control": fellBack ? "no-store" : "private, max-age=86400",
        "x-cc-cache": cached ? "hit" : "miss",
        ...(voice ? { "x-cc-voice": voice } : {}),
        // Headers are ASCII only; the PWA shows this next to the voice picker.
        ...(fellBack ? { "x-cc-fallback": `${fellBack.provider}: ${fellBack.reason}`.replace(/[^\x20-\x7e]/g, " ").slice(0, 300) } : {}),
      });
    } catch (err) {
      if (err instanceof VoiceNotInstalledError) return c.json({ error: err.message, downloading: true, voice: err.voice.id }, 409);
      console.error("[voice] speak", err instanceof Error ? err.message : err);
      return c.json(providerError(err), 502);
    }
  });

  app.post("/voice/warm", async (c) => {
    const body = z.object({ front: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    void service.warm().catch((err) => console.error("[voice] warm", err));
    if (body.front) deps.front?.()?.warm();
    return c.json({ ok: true, front: Boolean(deps.front?.()) });
  });

  app.post("/voice/turn", async (c) => {
    const front = deps.front?.();
    if (!front || !deps.handOff) return c.json({ error: "the voice front is off" }, 503);
    const body = z
      .object({
        text: z.string().trim().min(1).max(4000),
        vertical: z.string().optional(),
        role: z.string().optional(),
        talkingTo: z.string().max(200).optional(),
        lastSpoken: z.string().max(2000).nullish(),
        /** The task whose answer Dave last heard in this Drive session, and that answer. */
        lastTaskId: z.string().max(100).nullish(),
        lastAnswer: z.string().max(4000).nullish(),
      })
      .parse(await c.req.json());
    const pending = await service.pendingLine().catch(() => undefined);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const line = (msg: object) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(msg)}\n`));
          } catch {
            // client went away
          }
        };
        try {
          const lastAnswer = body.lastTaskId ? body.lastAnswer : null;
          const result = await front.turn(
            { text: body.text, talkingTo: body.talkingTo, lastSpoken: body.lastSpoken, lastAnswer, pending },
            { onDelta: (delta) => line({ delta }) },
          );
          let handoff: { taskId: string | null; continued: boolean } | null = null;
          if (result.handoff) {
            // A follow-up goes back to the task that gave the answer, which resumes with everything it found.
            const continued = result.continues && body.lastTaskId ? await continueTask(body.lastTaskId, body.text) : null;
            handoff = continued
              ? { taskId: continued, continued: true }
              : { taskId: (await deps.handOff!({ text: body.text, vertical: body.vertical, role: body.role, context: heardContext(body.lastSpoken, lastAnswer) })).taskId, continued: false };
          }
          line({ done: true, text: result.text, handoff });
        } catch (err) {
          console.error("[voice] turn", err instanceof Error ? err.message : err);
          line({ error: (err as Error).message });
        } finally {
          controller.close();
        }
      },
    });
    return c.body(stream, 200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  });

  /** Dave's follow-up on a task: answered now if the task is done, or taken after its current run. Null: no such task. */
  async function continueTask(taskId: string, text: string): Promise<string | null> {
    try {
      const task = await conversations.reply(taskId, text, true);
      return task?.id ?? null;
    } catch (err) {
      if (!(err instanceof ReplyStateError)) throw err;
      // Still queued or running (only an existing task says so): the note waits, and the task
      // runs again with it once its current run is over.
      await conversations.report(taskId, "dave", text);
      return taskId;
    }
  }

  app.get("/voice/briefing", async (c) => c.json(await service.briefing()));

  app.get("/voice/approvals/next", async (c) => {
    const skip = (c.req.query("skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return c.json(await service.nextApproval(skip));
  });

  app.post("/tasks/:id/reply", async (c) => {
    const body = z.object({ text: z.string().trim().min(1).max(4000), voice: z.boolean().optional(), files: ChatFileIds.optional() }).parse(await c.req.json());
    try {
      if (body.files?.length && !deps.chatFiles) return c.json({ error: "file attachments are not available on this server" }, 400);
      const files = body.files?.length && deps.chatFiles ? await deps.chatFiles.context(body.files) : undefined;
      const task = await conversations.reply(c.req.param("id"), body.text, body.voice ?? false, files);
      if (task && files) await deps.chatFiles!.tag(files.files.map((f) => f.id), task.vertical); // storage by vertical
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
