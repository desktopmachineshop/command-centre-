import { FallbackRunner, type AgentRunner, type AgentRunRequest, type AgentRunResult } from "@cc/agent-runtime";
import type { OutboundMessage } from "@cc/core";
import { FakeSpeechToText, FakeTextToSpeech, voiceResponseLine } from "@cc/voice";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { voiceApiRoutes } from "../src/http/voice";
import { VoiceService } from "../src/voice/service";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

/** Answers each request with the next scripted result (default: a plain echo), recording requests. */
class VoiceRunner implements AgentRunner {
  readonly name = "voice-test";
  readonly requests: AgentRunRequest[] = [];
  readonly next: Partial<AgentRunResult>[] = [];
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    return { status: "succeeded", result: `echo: ${request.prompt}`, error: null, costUsd: 0.01, sessionId: null, ...this.next.shift() };
  }
}

describe.skipIf(!DB_URL)("voice API (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new VoiceRunner();
  const stt = new FakeSpeechToText();
  const tts = new FakeTextToSpeech();
  const frames: OutboundMessage[] = [];
  const calendar = {
    upcoming: async () => [{ title: "Call the supplier", start: new Date(Date.now() + 3600_000).toISOString() }],
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      runner,
      env: { VOICE_MAX_UPLOAD_KB: "1", VOICE_MAX_SECONDS: "30" },
      overrides: { voiceProviders: { stt, tts }, voiceCalendar: calendar },
    });
    ctx.server.hub.addClient({ send: (f) => frames.push(JSON.parse(f)) });
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    runner.requests.length = 0;
    runner.next.length = 0;
    frames.length = 0;
  });

  const raw = (path: string, body: RequestInit["body"], headers: Record<string, string> = {}) =>
    ctx.server.app.request(path, { method: "POST", body, headers: { authorization: `Bearer ${ADMIN}`, ...headers } });

  it("needs auth", async () => {
    for (const path of ["/api/voice/config", "/api/voice/briefing", "/api/voice/approvals/next"]) {
      expect((await ctx.api(path, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    }
    expect((await ctx.server.app.request("/api/voice/transcribe", { method: "POST", body: "x", headers: { "content-type": "audio/webm" } })).status).toBe(401);
  });

  it("reports the configured providers", async () => {
    const { body } = await ctx.api("/api/voice/config");
    expect(body).toMatchObject({
      stt: { provider: "fake", model: "fake-stt" },
      tts: { provider: "fake", voice: "fake-voice" },
      maxUploadBytes: 1024,
      maxSeconds: 30,
      language: "en-GB",
      calendar: true,
    });
  });

  it("transcribes a raw or multipart upload", async () => {
    stt.push("what's new", "read approvals");
    const res = await raw("/api/voice/transcribe?seconds=2", new Uint8Array(300), { "content-type": "audio/webm;codecs=opus" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "what's new", provider: "fake" });
    expect(stt.calls.at(-1)).toMatchObject({ bytes: 300, mime: "audio/webm", opts: { language: "en-GB" } });

    const form = new FormData();
    form.append("file", new File([new Uint8Array(10)], "a.m4a", { type: "audio/mp4" }));
    const multi = await raw("/api/voice/transcribe", form);
    expect(await multi.json()).toMatchObject({ text: "read approvals" });
    expect(stt.calls.at(-1)?.mime).toBe("audio/mp4");
  });

  it("caps upload size and duration and checks the type", async () => {
    expect((await raw("/api/voice/transcribe", new Uint8Array(2048), { "content-type": "audio/webm" })).status).toBe(413);
    expect((await raw("/api/voice/transcribe?seconds=31", new Uint8Array(10), { "content-type": "audio/webm" })).status).toBe(413);
    expect((await raw("/api/voice/transcribe", new Uint8Array(10), { "content-type": "image/png" })).status).toBe(415);
    expect((await raw("/api/voice/transcribe", new Uint8Array(0), { "content-type": "audio/webm" })).status).toBe(400);
  });

  it("speaks text and caches short phrases", async () => {
    const first = await ctx.server.app.request("/api/voice/speak", {
      method: "POST",
      body: JSON.stringify({ text: "Working on it." }),
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("x-cc-cache")).toBe("miss");
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe("fake-voice:Working on it.");
    const calls = tts.calls.length;
    const second = await ctx.server.app.request("/api/voice/speak", {
      method: "POST",
      body: JSON.stringify({ text: "Working on it." }),
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
    expect(second.headers.get("x-cc-cache")).toBe("hit");
    expect(tts.calls.length).toBe(calls);
    expect((await ctx.api("/api/voice/speak", { method: "POST", json: { text: "" } })).status).toBe(400);
  });

  it("passes voice mode into the prompt only when asked", async () => {
    const voiced = (await ctx.api("/api/chat", { method: "POST", json: { text: "dms: has order 1042 shipped?", voice: true } })).body.task;
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: has order 1043 shipped?" } });
    await ctx.queue.drain();
    // The task keeps just what Dave said: the voice rules go to the agent, not into the app.
    expect((await ctx.api(`/api/tasks/${voiced.id}`)).body.task.prompt).toBe("dms: has order 1042 shipped?");
    expect(runner.requests[0]!.prompt).toMatch(/^dms: has order 1042 shipped\?\n\nVOICE MODE/);
    expect(runner.requests[0]!.prompt).toContain('"type":"final"');
    expect(runner.requests[1]!.prompt).toBe("dms: has order 1043 shipped?");
  });

  it("stores and broadcasts the structured response, and a reply resumes the same session", async () => {
    runner.next.push({ result: `Looked it up.\n${voiceResponseLine("Which supplier, Arc or Cutwel?", "converse")}`, sessionId: "sess-1" });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "order more ER11 collets", voice: true } });
    const taskId = body.task.id;
    await ctx.queue.drain();

    expect(frames).toContainEqual({
      type: "run.response",
      taskId,
      runId: expect.any(String),
      response: { text: "Which supplier, Arc or Cutwel?", type: "converse", structured: true },
    });
    let detail = (await ctx.api(`/api/tasks/${taskId}`)).body;
    expect(detail.task.status).toBe("done");
    expect(detail.runs[0].response).toEqual({ text: "Which supplier, Arc or Cutwel?", type: "converse", structured: true });

    runner.next.push({ result: voiceResponseLine("Done. I've drafted the order to Cutwel for approval.", "final"), sessionId: "sess-1" });
    const reply = await ctx.api(`/api/tasks/${taskId}/reply`, { method: "POST", json: { text: "Cutwel", voice: true } });
    expect(reply.status).toBe(202);
    expect(reply.body.status).toBe("queued");
    // A second reply while the first is still queued is refused.
    expect((await ctx.api(`/api/tasks/${taskId}/reply`, { method: "POST", json: { text: "again" } })).status).toBe(409);
    await ctx.queue.drain();

    const resumed = runner.requests.at(-1)!;
    expect(resumed.resumeSessionId).toBe("sess-1");
    expect(resumed.prompt).toMatch(/^Dave replies: Cutwel\n\nVOICE MODE/);
    detail = (await ctx.api(`/api/tasks/${taskId}`)).body;
    expect(detail.task.status).toBe("done");
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[1].response).toMatchObject({ type: "final", text: "Done. I've drafted the order to Cutwel for approval." });
    expect(detail.runs[1].messages[0]).toEqual({ type: "system", text: "Dave replied: Cutwel" });
    expect(await ctx.server.store.pool.query("select count(*)::int as n from task_replies where task_id = $1 and consumed_at is not null", [taskId]))
      .toMatchObject({ rows: [{ n: 1 }] });
  });

  it("carries context in the prompt when the earlier run has no session", async () => {
    runner.next.push({ result: voiceResponseLine("For which date?", "converse") });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "book the van", voice: true } });
    await ctx.queue.drain();
    await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "Friday", voice: true } });
    await ctx.queue.drain();
    const prompt = runner.requests.at(-1)!.prompt;
    expect(runner.requests.at(-1)!.resumeSessionId).toBeUndefined();
    expect(prompt).toContain("Original request: book the van\n");
    expect(prompt).toContain("Your last answer:");
    expect(prompt).toContain("Dave replies: Friday");
    expect(prompt.match(/VOICE MODE/g)).toHaveLength(1);
  });

  it("does not parse responses for non-voice tasks; 404 for unknown tasks", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "plain chat" } });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0].response).toBeNull();
    expect(frames.some((f) => f.type === "run.response")).toBe(false);
    expect((await ctx.api("/api/tasks/00000000-0000-0000-0000-000000000000/reply", { method: "POST", json: { text: "hi" } })).status).toBe(404);
  });

  it("reads approvals out one at a time, oldest first", async () => {
    const store = ctx.server.store;
    const a = await store.insertProposal({ taskId: null, vertical: "dms", actionType: "email.reply", summary: "Reply to Jane about order 1042", payload: { to: "jane@example.com" }, policy: "draft" });
    const b = await store.insertProposal({ taskId: null, vertical: "3dpandme", actionType: "social.post", summary: "Post the **new** video", payload: {}, policy: "draft" });

    const first = (await ctx.api("/api/voice/approvals/next")).body;
    expect(first.proposal.id).toBe(a.id);
    expect(first).toMatchObject({ position: 1, remaining: 1 });
    expect(first.text).toBe(
      "Approval 1 of 2, for Desktop Machine Shop: email reply. Reply to Jane about order 1042. To jane@example.com. Say approve, reject, or next.",
    );
    const second = (await ctx.api(`/api/voice/approvals/next?skip=${a.id}`)).body;
    expect(second.proposal.id).toBe(b.id);
    expect(second.text).toContain("Approval 2 of 2, for 3dpandme: social post. Post the new video.");
    const none = (await ctx.api(`/api/voice/approvals/next?skip=${a.id},${b.id}`)).body;
    expect(none).toMatchObject({ proposal: null, remaining: 0 });
    expect(none.text).toMatch(/That's all the approvals/);
  });

  it("builds a deterministic spoken briefing", async () => {
    const { body } = await ctx.api("/api/voice/briefing");
    expect(body.approvals.count).toBe(2);
    expect(body.cost.todayUsd).toBeGreaterThan(0);
    expect(body.calendar).toHaveLength(1);
    expect(body.text).toMatch(/^You have 2 approvals waiting\. First, for Desktop Machine Shop: Reply to Jane about order 1042\. Second, for 3dpandme: Post the new video\./);
    expect(body.text).toMatch(/Today's spend is \d+ cents\./);
    expect(body.text).toMatch(/Next on your calendar: today at .+, Call the supplier\.$|Next on your calendar: tomorrow at .+, Call the supplier\.$/);
    expect(body.text).not.toMatch(/[*#|]/);
  });
});

describe("voice API without server providers", () => {
  const service = new VoiceService({} as never, {} as never, {} as never, { maxUploadBytes: 1024, maxSeconds: 60, language: "en-GB", timezone: "Europe/London" });
  const app = voiceApiRoutes({ service, conversations: {} as never });

  it("reports none and refuses server speech, so the PWA uses the browser", async () => {
    expect(await (await app.request("/voice/config")).json()).toEqual({ stt: null, tts: null, maxUploadBytes: 1024, maxSeconds: 60, language: "en-GB", calendar: false });
    expect((await app.request("/voice/transcribe", { method: "POST", body: "x", headers: { "content-type": "audio/webm" } })).status).toBe(503);
    expect((await app.request("/voice/speak", { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "content-type": "application/json" } })).status).toBe(503);
  });
});

describe.skipIf(!DB_URL)("a reply that falls back to the API-key runner", () => {
  class Primary implements AgentRunner {
    readonly name = "sub";
    n = 0;
    async run(_r: AgentRunRequest): Promise<AgentRunResult> {
      if (++this.n === 1) return { status: "succeeded", result: "Which supplier do you mean?", error: null, costUsd: 0, sessionId: "sess-1" };
      return { status: "failed", result: null, error: "Claude usage limit reached", costUsd: 0, sessionId: null };
    }
  }
  class Api implements AgentRunner {
    readonly name = "api";
    readonly requests: AgentRunRequest[] = [];
    async run(r: AgentRunRequest): Promise<AgentRunResult> {
      this.requests.push(r);
      return { status: "succeeded", result: "ok", error: null, costUsd: 0, sessionId: "sess-2" };
    }
  }
  const primary = new Primary();
  const api = new Api();
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner: new FallbackRunner("claude-code", primary, api) });
  });
  afterAll(async () => ctx?.server.stop());

  it("keeps the conversation's context when the session can't be resumed", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "Order more 6mm end mills from the usual supplier", vertical: "dms" } });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "Yes, the second one" } })).status).toBe(202);
    await ctx.queue.drain();
    const req = api.requests.at(-1)!;
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.prompt).toContain("end mills");
    expect(req.prompt).toContain("Which supplier do you mean?");
    expect(req.prompt).toContain("Dave replies: Yes, the second one");
  });
});
