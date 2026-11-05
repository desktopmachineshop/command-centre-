import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { type AsrWorkerMessage, findVoice, LOCAL_MODELS, LocalSpeech, type WorkerLike } from "@cc/voice/local";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heardContext, voiceApiRoutes } from "../src/http/voice";
import { ReplyStateError } from "../src/voice/conversations";
import { VoiceService } from "../src/voice/service";
import { CONTINUE, FrontStreamSplitter, HANDOFF, VoiceFront } from "../src/voice/front";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "./helpers";

describe("FrontStreamSplitter", () => {
  it("passes speech through and swallows the handoff marker, even split across deltas", () => {
    const s = new FrontStreamSplitter();
    expect(s.push("Sure, I'll check. [")).toBe("Sure, I'll check. ");
    expect(s.push("[hand")).toBe("");
    expect(s.push("off]]")).toBe("");
    expect(s.handoff).toBe(true);
    expect(s.push(" more")).toBe("");
    expect(s.flush()).toBe("");
  });

  it("tells a follow-up (continue) from a new request, even split across deltas", () => {
    const s = new FrontStreamSplitter();
    expect(s.push("Okay, I'll tell her. [[con")).toBe("Okay, I'll tell her. ");
    expect(s.push("tinue]]")).toBe("");
    expect(s).toMatchObject({ handoff: true, continues: true });
    const h = new FrontStreamSplitter();
    h.push(`On it. ${HANDOFF}`);
    expect(h).toMatchObject({ handoff: true, continues: false });
    expect(CONTINUE).toBe("[[continue]]");
  });

  it("releases a held-back bracket that wasn't the marker", () => {
    const s = new FrontStreamSplitter();
    expect(s.push("Pick [")).toBe("Pick ");
    expect(s.push("A] or B.")).toBe("[A] or B.");
    expect(s.push(" [")).toBe(" ");
    expect(s.flush()).toBe("[");
    expect(s.handoff).toBe(false);
  });
});

/** A stand-in `claude -p --input-format stream-json` process: answers each message with `reply(text)` as deltas. */
function fakeClaude(reply: (text: string) => string[], spawned: { args: string[] }[]) {
  return (_bin: string, args: string[]) => {
    spawned.push({ args });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), exitCode: null, killed: false, kill: () => ((child as { killed: boolean }).killed = true) });
    let buffer = "";
    stdin.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        const out = (o: object) => stdout.write(`${JSON.stringify(o)}\n`);
        out({ type: "system", subtype: "init" });
        for (const text of reply(msg.message.content)) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
        out({ type: "stream_event", event: { type: "message_stop" } });
        // The CLI's result line comes later; it must not end the next turn.
        setTimeout(() => out({ type: "result", subtype: "success", is_error: false, result: "" }), 5);
      }
    });
    return child;
  };
}

describe("VoiceFront", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-front-"));
  const now = () => new Date("2026-11-03T15:30:00Z");

  it("keeps one warm process, streams each turn, and spots a handoff", async () => {
    const spawned: { args: string[] }[] = [];
    const seen: string[] = [];
    const front = new VoiceFront({
      env: {},
      model: "haiku",
      cwd,
      timeZone: "Europe/London",
      now,
      log: () => {},
      spawn: fakeClaude((text) => {
        seen.push(text);
        if (/let Jane know/.test(text)) return ["Okay, I'll tell her.", " [[continue]]"];
        return /joke/.test(text) ? ["Why did ", "the lathe… never mind."] : ["Sure, I'll ", "check that.", ` [[hand`, `off]]`];
      }, spawned),
    });
    front.warm();
    const deltas: string[] = [];
    const joke = await front.turn({ text: "tell me a joke" }, { onDelta: (d) => deltas.push(d) });
    expect(joke).toEqual({ text: "Why did the lathe… never mind.", handoff: false });
    expect(deltas).toEqual(["Why did ", "the lathe… never mind."]);
    const work = await front.turn({ text: "where's order 1042?", talkingTo: "the Chief of Staff", pending: "2 approvals waiting", lastSpoken: "Done." }, { onDelta: () => {} });
    expect(work).toEqual({ text: "Sure, I'll check that.", handoff: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--include-partial-messages", "--model", "haiku", "--tools", ""]));
    expect(seen[1]).toBe(
      `[It is Tuesday 3 November at 3:30 pm; requests go to the Chief of Staff; 2 approvals waiting; last thing Dave heard: "Done."]\nwhere's order 1042?`,
    );
    // After an agent's answer: the front is told it in full, and spots a follow-up on it.
    const answer = "Order 1042 shipped on Monday with Royal Mail, tracking ending 4471.";
    const follow = await front.turn({ text: "great, let Jane know", lastAnswer: answer, lastSpoken: answer }, { onDelta: () => {} });
    expect(seen[2]).toBe(`[It is Tuesday 3 November at 3:30 pm; the agents' last answer to Dave: "${answer}"]\ngreat, let Jane know`);
    expect(follow).toEqual({ text: "Okay, I'll tell her.", handoff: true, continues: true });
    front.stop();
  });

  it("fails a turn that gets no first word in time", async () => {
    const front = new VoiceFront({ env: {}, model: "haiku", cwd, timeZone: "Europe/London", firstTokenMs: 30, log: () => {}, spawn: fakeClaude(() => [], []) });
    // The fake answers with no deltas but a result: that's a (blank) success, so make it hang instead.
    const hanging = new VoiceFront({
      env: {},
      model: "haiku",
      cwd,
      timeZone: "Europe/London",
      firstTokenMs: 30,
      log: () => {},
      spawn: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false, kill: () => true });
        return child;
      },
    });
    await expect(hanging.turn({ text: "hi" }, { onDelta: () => {} })).rejects.toThrow(/too slow/);
    expect(await front.turn({ text: "hi" }, { onDelta: () => {} })).toEqual({ text: "", handoff: false });
  });
});

describe("POST /voice/turn", () => {
  const service = { pendingLine: async () => "no approvals waiting", options: {} } as never;

  it("streams the reply as NDJSON and creates the agent task on a handoff", async () => {
    const handOffs: unknown[] = [];
    const front = {
      turn: async (_input: unknown, events: { onDelta: (d: string) => void }) => {
        events.onDelta("On it, ");
        events.onDelta("I'll check.");
        return { text: "On it, I'll check.", handoff: true };
      },
    } as unknown as VoiceFront;
    const app = voiceApiRoutes({
      service,
      conversations: {} as never,
      front: () => front,
      handOff: async (r) => {
        handOffs.push(r);
        return { taskId: "t1" };
      },
    });
    const res = await app.request("/voice/turn", { method: "POST", body: JSON.stringify({ text: "check order 1042", vertical: "dms" }), headers: { "content-type": "application/json" } });
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ delta: "On it, " }, { delta: "I'll check." }, { done: true, text: "On it, I'll check.", handoff: { taskId: "t1", continued: false } }]);
    expect(handOffs).toEqual([{ text: "check order 1042", vertical: "dms" }]);
  });

  /** A front that hands every turn off, as a follow-up (CONTINUE) or a new request; records what it was told. */
  const handingFront = (continues: boolean, told: unknown[] = []) =>
    ({
      turn: async (input: unknown) => {
        told.push(input);
        return { text: "Okay.", handoff: true, ...(continues ? { continues: true } : {}) };
      },
    }) as unknown as VoiceFront;
  const turn = async (app: ReturnType<typeof voiceApiRoutes>, body: Record<string, unknown>) => {
    const res = await app.request("/voice/turn", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return JSON.parse((await res.text()).trim().split("\n").at(-1)!);
  };

  it("sends a follow-up on the agents' last answer back to that task", async () => {
    const replies: unknown[] = [];
    const told: unknown[] = [];
    const conversations = { reply: async (taskId: string, text: string, voice: boolean) => (replies.push({ taskId, text, voice }), { id: taskId }) };
    const app = voiceApiRoutes({ service, conversations: conversations as never, front: () => handingFront(true, told), handOff: async () => ({ taskId: "new" }) });
    const done = await turn(app, { text: "great, let Jane know", lastTaskId: "t1", lastAnswer: "Order 1042 shipped on Monday." });
    expect(done.handoff).toEqual({ taskId: "t1", continued: true });
    expect(replies).toEqual([{ taskId: "t1", text: "great, let Jane know", voice: true }]);
    expect(told[0]).toMatchObject({ lastAnswer: "Order 1042 shipped on Monday." });
  });

  it("queues a follow-up on a task that is still working, to be taken after its run", async () => {
    const reports: unknown[] = [];
    const conversations = {
      reply: async () => {
        throw new ReplyStateError("task is running; reply once it has answered");
      },
      report: async (taskId: string, author: string, text: string) => (reports.push({ taskId, author, text }), null),
    };
    const app = voiceApiRoutes({ service, conversations: conversations as never, front: () => handingFront(true), handOff: async () => ({ taskId: "new" }) });
    expect((await turn(app, { text: "and the other one?", lastTaskId: "t1", lastAnswer: "Checking 1042." })).handoff).toEqual({ taskId: "t1", continued: true });
    expect(reports).toEqual([{ taskId: "t1", author: "dave", text: "and the other one?" }]);
  });

  it("starts a new task, with what Dave had just heard, for a new request or a follow-up whose task is gone", async () => {
    const handOffs: unknown[] = [];
    const handOff = async (r: unknown) => (handOffs.push(r), { taskId: "t2" });
    const gone = { reply: async () => null };
    const follow = voiceApiRoutes({ service, conversations: gone as never, front: () => handingFront(true), handOff });
    expect((await turn(follow, { text: "send it", lastTaskId: "deleted", lastAnswer: "Draft ready." })).handoff).toEqual({ taskId: "t2", continued: false });
    const fresh = voiceApiRoutes({ service, conversations: {} as never, front: () => handingFront(false), handOff });
    await turn(fresh, { text: "book the van for Friday", lastSpoken: "It's sunny on Friday." });
    expect(handOffs).toEqual([
      { text: "send it", context: `the agents' last answer: "Draft ready."` },
      { text: "book the van for Friday", context: `the last thing he heard: "It's sunny on Friday."` },
    ]);
  });

  it("only uses a last answer that comes with its task", async () => {
    const told: unknown[] = [];
    const app = voiceApiRoutes({ service, conversations: {} as never, front: () => handingFront(false, told), handOff: async () => ({ taskId: "t2" }) });
    await turn(app, { text: "hi", lastAnswer: "stale" });
    expect(told[0]).toMatchObject({ lastAnswer: null });
    expect(heardContext(null, null)).toBeUndefined();
    expect(heardContext("Done.", "Done.")).toBe(`the agents' last answer: "Done."`);
  });

  it("is 503 without a front, and reports a failed turn in the stream", async () => {
    const off = voiceApiRoutes({ service, conversations: {} as never, front: () => null, handOff: async () => ({ taskId: null }) });
    expect((await off.request("/voice/turn", { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "content-type": "application/json" } })).status).toBe(503);
    const broken = { turn: async () => Promise.reject(new Error("not signed in")) } as unknown as VoiceFront;
    const app = voiceApiRoutes({ service, conversations: {} as never, front: () => broken, handOff: async () => ({ taskId: null }) });
    const res = await app.request("/voice/turn", { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "content-type": "application/json" } });
    expect(JSON.parse((await res.text()).trim())).toEqual({ error: "not signed in" });
  });
});

/** Model folders with placeholder files, so LocalSpeech counts them as installed. */
function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-voice-"));
  for (const model of Object.values(LOCAL_MODELS)) {
    mkdirSync(join(root, model.dir), { recursive: true });
    for (const f of model.files) f.includes(".") ? writeFileSync(join(root, model.dir, f), "") : mkdirSync(join(root, model.dir, f), { recursive: true });
  }
  return root;
}

/** A recognition worker that hears "hello" then "there", and a pause after any silent frame. */
function fakeWorker(): WorkerLike {
  const handlers: ((m: AsrWorkerMessage) => void)[] = [];
  const emit = (m: AsrWorkerMessage) => setImmediate(() => handlers.forEach((h) => h(m)));
  const words = new Map<number, string[]>();
  emit({ type: "loaded", ms: 1 });
  return {
    on(event: string, h: (m: any) => void) {
      if (event === "message") handlers.push(h);
      return this;
    },
    postMessage(m: any) {
      if (m.type === "open") words.set(m.id, []);
      if (m.type === "audio") {
        const w = words.get(m.id)!;
        const silent = (m.samples as Float32Array).every((x) => x === 0);
        if (!silent) w.push(["hello", "there"][w.length] ?? "again");
        emit({ type: "text", id: m.id, text: w.join(" "), endpoint: silent && w.length > 0 });
      }
      if (m.type === "finish") emit({ type: "final", id: m.id, text: `${words.get(m.id)!.join(" ")}.` });
    },
    terminate() {},
  } as WorkerLike;
}

describe.skipIf(!DB_URL)("live transcription socket /ws/voice (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let served: Awaited<ReturnType<typeof serveServer>>;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { localSpeech: new LocalSpeech({ root: installedRoot(), engine: "kokoro", worker: fakeWorker, sherpa: () => ({}) as never, log: () => {} }) } });
    served = await serveServer(ctx.server);
  });
  afterAll(async () => {
    await served?.close();
    await ctx?.server.stop();
  });

  const pcm = (value: number) => new Int16Array(640).fill(value).buffer;
  const open = (hello: object) =>
    new Promise<{ ws: WebSocket; messages: { type: string; text?: string }[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`${served.url.replace("http", "ws")}/ws/voice`);
      ws.binaryType = "arraybuffer";
      const messages: { type: string; text?: string }[] = [];
      const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(String(e.data));
        messages.push(msg);
        if (msg.type === "ready") resolve({ ws, messages, closed });
      });
      ws.addEventListener("open", () => ws.send(JSON.stringify(hello)));
      closed.then(() => resolve({ ws, messages, closed }));
    });

  it("reports the self-hosted streaming transcription and voice in the config", async () => {
    const { body } = await ctx.api("/api/voice/config");
    expect(body).toMatchObject({ stt: { provider: "local", streaming: true }, tts: { provider: "local", voice: "kokoro:bf_emma" }, local: { stt: "ready", tts: "ready", voices: true } });
  });

  it("refuses a socket without a valid token", async () => {
    const { messages, closed } = await open({ type: "hello", token: "nope" });
    expect(await closed).toBe(4003);
    expect(messages).toEqual([]);
  });

  it("streams words as they're heard, ends an unlatched turn on a pause, and sends the final text", async () => {
    const { ws, messages, closed } = await open({ type: "hello", token: ADMIN });
    ws.send(pcm(1000));
    ws.send(pcm(1000));
    ws.send(pcm(0));
    await expect.poll(() => messages.some((m) => m.type === "endOfTurn")).toBe(true);
    ws.send(JSON.stringify({ type: "stop" }));
    expect(await closed).toBe(1000);
    expect(messages).toEqual([
      { type: "ready" },
      { type: "partial", text: "hello" },
      { type: "partial", text: "hello there" },
      { type: "endOfTurn", text: "hello there" },
      { type: "final", text: "hello there." },
    ]);
  });

  it("doesn't end a latched (push to talk) turn on a pause", async () => {
    const { ws, messages, closed } = await open({ type: "hello", token: ADMIN, latched: true });
    ws.send(pcm(1000));
    ws.send(pcm(0));
    await expect.poll(() => messages.some((m) => m.type === "partial")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "stop" }));
    await closed;
    expect(messages.map((m) => m.type)).toEqual(["ready", "partial", "final"]);
  });
});

describe("choosing a self-hosted voice (/voice/voices, /voice/speak)", () => {
  /** Cori downloaded; others download through `fetch` (held until `release`). */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "cc-voice-"));
    const cori = findVoice("piper:cori")!.model;
    mkdirSync(join(root, cori.dir, "espeak-ng-data"), { recursive: true });
    for (const f of cori.files.filter((f) => f.includes("."))) writeFileSync(join(root, cori.dir, f), "");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetch = (async () => {
      await held;
      return new Response("x");
    }) as typeof globalThis.fetch;
    const spoken: { text: string; sid: number }[] = [];
    const sherpa = () => ({
      OfflineTts: { createAsync: async () => ({ sampleRate: 22050, generateAsync: async (r: { text: string; sid: number }) => (spoken.push(r), { samples: new Float32Array(8), sampleRate: 22050 }) }) },
    });
    const local = new LocalSpeech({ root, fetch, sherpa: sherpa as never, log: () => {} });
    const service = new VoiceService({} as never, {} as never, {} as never, { local, maxUploadBytes: 1024, maxSeconds: 60, language: "en-GB", timezone: "Europe/London" });
    const app = voiceApiRoutes({ service, conversations: {} as never });
    const post = (path: string, body?: unknown) => app.request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
    return { app, post, release, spoken };
  }

  it("lists the voices with what's downloaded, and starts a download on request", async () => {
    const { app, post } = setup();
    const list = (await (await app.request("/voice/voices")).json()) as { default: string; voices: { id: string; status: string; tier: string }[] };
    expect(list.default).toBe("piper:cori");
    expect(list.voices.find((v) => v.id === "piper:cori")).toMatchObject({ status: "ready", tier: "fast" });
    expect(list.voices.find((v) => v.id === "kokoro:bf_emma")).toMatchObject({ status: "missing", tier: "natural" });
    const res = await post(`/voice/voices/${encodeURIComponent("piper:alba")}/install`);
    expect(res.status).toBe(202);
    const after = (await res.json()) as typeof list;
    expect(after.voices.find((v) => v.id === "piper:alba")?.status).toBe("installing");
  });

  it("speaks the default meanwhile for a voice still downloading, or says so for a preview", async () => {
    const { post } = setup();
    const res = await post("/voice/speak", { text: "Hello there.", voice: "piper:jenny_dioco" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cc-voice")).toBe("piper:cori");
    const preview = await post("/voice/speak", { text: "Hello there.", voice: "piper:jenny_dioco", fallback: false });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ downloading: true, voice: "piper:jenny_dioco" });
    // The fallback wasn't cached under Jenny: the same request synthesizes again.
    const again = await post("/voice/speak", { text: "Hello there.", voice: "piper:jenny_dioco" });
    expect(again.headers.get("x-cc-cache")).toBe("miss");
  });
});
