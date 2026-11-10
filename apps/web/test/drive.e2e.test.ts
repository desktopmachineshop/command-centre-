/**
 * Drive page in real Chromium with the speech APIs and the server mocked:
 * renders, runs local commands (briefing, approval with confirmation) and a
 * conversational chat that continues the same task. Skipped when no Chromium
 * is installed (set PW_CHROMIUM to point at one).
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

/** Fake SpeechRecognition (answers from window.__transcripts) and speechSynthesis (records into window.__spoken). */
const MOCK_SPEECH = () => {
  const w = window as unknown as Record<string, unknown> & { __spoken: string[]; __transcripts: string[] };
  w.__spoken = [];
  w.__transcripts = [];
  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onspeechstart: (() => void) | null = null;
    private done = false;
    start() {
      setTimeout(() => {
        if (this.done) return;
        const text = w.__transcripts.shift();
        if (text) {
          this.onspeechstart?.();
          const result = Object.assign([{ transcript: text }], { isFinal: true });
          this.onresult?.({ resultIndex: 0, results: [result] });
        }
        this.end();
      }, 80);
    }
    private end() {
      if (this.done) return;
      this.done = true;
      this.onend?.();
    }
    stop() {
      setTimeout(() => this.end(), 0);
    }
    abort() {
      this.end();
    }
  }
  w.SpeechRecognition = FakeRecognition;
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      speak(u: { text: string; onend?: () => void }) {
        w.__spoken.push(u.text);
        setTimeout(() => u.onend?.(), 20);
      },
      cancel() {},
      getVoices: () => [],
      addEventListener() {},
    },
  });
  // No live server: a socket that never connects (the page polls instead).
  w.WebSocket = class {
    send() {}
    close() {}
  };
  localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
  // These tests start in push to talk (Converse's default is off; the wake-lock test checks that).
  if (!sessionStorage.getItem("cc.test.freshMode")) localStorage.setItem("cc.drive.mode", "push");
};

type Calls = { method: string; path: string; body: unknown }[];

async function mockApi(page: Page, calls: Calls, options: { front?: boolean; batch?: boolean } = {}) {
  let approved = false;
  let taskReads = 0;
  let replied = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ method: req.method(), path: `${path}${url.search}`, body });
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const now = new Date().toISOString();
    const task = (status: string) => ({ id: "t1", eventId: "e1", vertical: "dms", intent: "other", route: "agent", urgency: 0.3, status, prompt: "x", createdAt: now, updatedAt: now });
    const run = (id: string, text: string, type: "converse" | "final") => ({
      id, taskId: "t1", runner: "test", status: "succeeded", result: text, error: null, costUsd: 0, sessionId: "s1", startedAt: now, finishedAt: now, messages: [],
      response: { text, type, structured: true },
    });

    if (path === "/voice/warm") return options.front ? json({ ok: true, front: true }) : json({ error: "off" }, 503);
    if (path === "/voice/turn") {
      // The voice front: a joke it answers itself; anything else it hands on to an agent (task t1).
      const own = /joke/i.test(body.text);
      const lines = own
        ? [{ delta: "Why did the lathe " }, { delta: "go to therapy? " }, { delta: "Too many turns." }, { done: true, text: "", handoff: null }]
        : body.lastTaskId
          ? [{ delta: "Okay, I'll tell her." }, { done: true, text: "", handoff: { taskId: body.lastTaskId, continued: true } }]
          : [{ delta: "Sure, I'll check " }, { delta: "where order ten forty-two is." }, { done: true, text: "", handoff: { taskId: "t1" } }];
      return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lines.map((l) => JSON.stringify(l)).join("\n") });
    }
    if (path === "/voice/config") return json({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 60, language: "en-GB", calendar: false });
    if (path === "/verticals") return json([{ id: "dms", name: "Desktop Machine Shop" }, { id: "3dpandme", name: "3dpandme" }, { id: "personal", name: "Personal" }]);
    if (path === "/stats") return json({ pendingApprovals: 1, costTodayUsd: 0 });
    if (path === "/org") {
      const role = (id: string, title: string, vertical: string, aliases: string[]) => ({ id, title, vertical, aliases });
      return json({
        root: {
          ...role("chief-of-staff", "Assistant", "personal", ["assistant", "cos", "chief", "chief-of-staff"]),
          verticals: [
            { id: "dms", name: "Desktop Machine Shop", specialists: [] },
            {
              id: "3dpandme",
              name: "3dpandme",
              specialists: [role("video-producer", "Video Producer", "3dpandme", ["video", "youtube"]), role("blog-writer", "Blog Writer", "3dpandme", ["blog"])],
            },
          ],
        },
      });
    }
    if (path === "/voice/briefing") return json({ text: "You have 1 approval waiting. Today's spend is 42 cents.", approvals: { count: 1 }, cost: { todayUsd: 0.42 } });
    if (path === "/voice/approvals/next" && options.batch) {
      return approved
        ? json({ proposal: null, position: 0, remaining: 0, text: "Nothing is waiting for approval." })
        : json({
            proposal: { id: "p1", vertical: "dms", actionType: "odoo.message.post", summary: "Delivery update to the 3 open delivery orders", createdAt: now, batchId: "b1", batchSize: 3 },
            position: 1,
            remaining: 0,
            text: "Approval 1 of 1, for Desktop Machine Shop: a batch of 3, odoo message post. Delivery update to the 3 open delivery orders. 1: Delivery update to Jane (S00041). 2: Delivery update to Bob (S00042). 3: Delivery update to Ann (S00043). Say approve to approve all 3, reject to reject all 3, or next.",
          });
    }
    if (path === "/batches/b1/approve") {
      approved = true;
      return json(["p1", "p2", "p3"].map((id) => ({ id, status: "executed" })));
    }
    if (path === "/voice/approvals/next") {
      return approved
        ? json({ proposal: null, position: 0, remaining: 0, text: "Nothing is waiting for approval." })
        : json({
            proposal: { id: "p1", vertical: "dms", actionType: "email.reply", summary: "Reply to Jane about order 1042", createdAt: now },
            position: 1,
            remaining: 0,
            text: "Approval 1 of 1, for Desktop Machine Shop: email reply. Reply to Jane about order 1042. Say approve, reject, or next.",
          });
    }
    if (path === "/proposals/p1/approve") {
      approved = true;
      return json({ id: "p1", status: "executed" });
    }
    if (path === "/chat") return json({ event: { id: "e1" }, task: task("queued") }, 201);
    if (path === "/tasks/t1/reply") {
      replied = true;
      return json(task("queued"), 202);
    }
    if (path === "/tasks/t1") {
      taskReads++;
      if (!replied) return json({ task: task("done"), event: null, proposals: [], runs: [run("r1", "Which order, 1042 or 1043?", "converse")] });
      return json({
        task: task("done"),
        event: null,
        proposals: [],
        runs: [run("r1", "Which order, 1042 or 1043?", "converse"), run("r2", "Order 1042 shipped on Monday.", "final")],
      });
    }
    return json({ error: `unmocked ${path}` }, 404);
  });
  return { reads: () => taskReads };
}

describe.skipIf(!existsSync(CHROMIUM))("Drive page (Playwright, mocked speech)", () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    process.env.CC_SERVER_URL ??= "http://127.0.0.1:9";
    vite = await createServer({
      root: fileURLToPath(new URL("..", import.meta.url)),
      logLevel: "error",
      server: { port: 0, host: "127.0.0.1" },
    });
    await vite.listen();
    base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it("renders, runs local commands and a conversational chat", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls);
    await page.goto(`${base}/#/converse`);

    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    expect(await page.locator(".drive-state").textContent()).toContain("Tap to talk");
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
    const sayNext = (text: string) => page.evaluate((t) => (window as unknown as { __transcripts: string[] }).__transcripts.push(t), text);
    /** Push to talk is latched: tap, speak, then tap Send. */
    const pushToTalk = async (text: string) => {
      await sayNext(text);
      await talk.click();
      await page.locator(".drive-caption", { hasText: text }).waitFor({ timeout: 15_000 });
      await talk.click();
    };
    const waitSpoken = async (pattern: RegExp) => {
      try {
        await expect.poll(async () => (await spoken()).some((s) => pattern.test(s)), { timeout: 15_000 }).toBe(true);
      } catch (err) {
        throw new Error(`${pattern} not spoken; spoken: ${JSON.stringify(await spoken())}; status: ${await page.locator(".drive-state").textContent()}; calls: ${calls.map((c) => c.path).join(" ")}`);
      }
    };

    // Briefing, parsed locally.
    await pushToTalk("What's new?");
    await waitSpoken(/You have 1 approval waiting/);
    expect(calls.some((c) => c.path === "/voice/briefing")).toBe(true);
    await page.getByText("Tap to talk").waitFor();

    // Approvals: read, approve, confirm.
    await pushToTalk("read approvals");
    await waitSpoken(/^Approval 1 of 1/);
    await page.locator(".drive-state").getByText("Tap to talk").waitFor();
    await pushToTalk("approve");
    await waitSpoken(/^To approve: Reply to Jane about order 1042\. Say "yes, approve"/);
    expect(calls.some((c) => c.path.endsWith("/approve"))).toBe(false); // nothing without confirmation
    await page.getByRole("button", { name: "Yes, approve" }).waitFor();
    await page.locator(".drive-state").getByText("Tap to talk").waitFor();
    await pushToTalk("yes, approve");
    await waitSpoken(/^Approved\. Nothing is waiting for approval\./);
    expect(calls.filter((c) => c.path === "/proposals/p1/approve")).toHaveLength(1);

    // Conversational chat: the question is answered without a button press, into the same task.
    await page.getByRole("switch", { name: "Push to talk" }).click();
    expect(await page.getByRole("switch", { name: "Push to talk" }).getAttribute("aria-checked")).toBe("false");
    expect(await page.evaluate(() => localStorage.getItem("cc.drive.mode"))).toBe("conversational");
    await sayNext("shop: has order 1042 shipped?");
    await sayNext("the one for Jane");
    await talk.click();
    await waitSpoken(/^On it\./);
    await waitSpoken(/^Which order, 1042 or 1043\?/);
    await waitSpoken(/^Order 1042 shipped on Monday\./);
    const chat = calls.find((c) => c.path === "/chat");
    expect(chat?.body).toEqual({ text: "Has order 1042 shipped?", vertical: "dms", voice: true });
    const reply = calls.find((c) => c.path === "/tasks/t1/reply");
    expect(reply?.body).toEqual({ text: "the one for Jane", voice: true });
    expect(calls.filter((c) => c.path === "/chat")).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("reads a batch out in full and approves all of it with one 'yes, approve'", async () => {
    const page = await browser.newPage();
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls, { batch: true });
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
    const pushToTalk = async (text: string) => {
      await page.evaluate((t) => (window as unknown as { __transcripts: string[] }).__transcripts.push(t), text);
      await talk.click();
      await page.locator(".drive-caption", { hasText: text }).waitFor({ timeout: 15_000 });
      await talk.click();
    };
    const waitSpoken = async (pattern: RegExp) => {
      try {
        await expect.poll(async () => (await spoken()).some((s) => pattern.test(s)), { timeout: 15_000 }).toBe(true);
      } catch {
        throw new Error(`${pattern} not spoken; spoken: ${JSON.stringify(await spoken())}; calls: ${calls.map((c) => c.path).join(" ")}`);
      }
    };

    await pushToTalk("read approvals");
    // Every item is read out (speech may split it into chunks).
    await expect.poll(async () => (await spoken()).join(" "), { timeout: 15_000 }).toMatch(/a batch of 3.*1: Delivery update to Jane.*2: Delivery update to Bob.*3: Delivery update to Ann/);
    await page.locator(".drive-state").getByText("Tap to talk").waitFor();
    await pushToTalk("approve");
    await waitSpoken(/^To approve all 3: Delivery update to the 3 open delivery orders\. Say "yes, approve"/);
    expect(calls.some((c) => c.path.endsWith("/approve"))).toBe(false);
    await page.locator(".drive-state").getByText("Tap to talk").waitFor();
    await pushToTalk("yes, approve");
    await waitSpoken(/^Approved all 3\. Nothing is waiting for approval\./);
    // One call for the whole batch, none per item.
    expect(calls.filter((c) => c.path.endsWith("/approve")).map((c) => c.path)).toEqual(["/batches/b1/approve"]);
    await page.close();
   }, 90_000);

  it("talks to a chosen role: by voice or the picker, remembered, and once with 'ask'", async () => {
    const page = await browser.newPage();
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls);
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    const picker = page.getByLabel("Talking to");
    await picker.waitFor({ timeout: 20_000 });
    expect(await picker.inputValue()).toBe("");
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
    const sayNext = (text: string) => page.evaluate((t) => (window as unknown as { __transcripts: string[] }).__transcripts.push(t), text);
    /** Push to talk is latched: tap, speak, then tap Send. */
    const pushToTalk = async (text: string) => {
      await sayNext(text);
      await talk.click();
      await page.locator(".drive-caption", { hasText: text }).waitFor({ timeout: 15_000 });
      await talk.click();
    };
    const waitSpoken = (pattern: RegExp) => expect.poll(async () => (await spoken()).some((s) => pattern.test(s)), { timeout: 15_000 }).toBe(true);
    const idle = () => page.locator(".drive-state").getByText("Tap to talk").waitFor();
    const chats = () => calls.filter((c) => c.path === "/chat").map((c) => c.body);

    await pushToTalk("talk to the video producer");
    await waitSpoken(/^You're talking to the Video Producer at 3dpandme\. Go ahead\./);
    expect(await picker.inputValue()).toBe("3dpandme/video-producer");
    expect(await page.evaluate(() => localStorage.getItem("cc.drive.talkTo"))).toBe(JSON.stringify({ vertical: "3dpandme", role: "video-producer" }));
    await idle();

    await pushToTalk("what is the next video about?");
    await expect.poll(() => chats().length, { timeout: 15_000 }).toBe(1);
    expect(chats()[0]).toEqual({ text: "what is the next video about?", vertical: "3dpandme", role: "video-producer", voice: true });
    await waitSpoken(/^Which order/);
    // That answer was a question: end the conversation, so the next request isn't taken as the reply.
    await idle();
    await pushToTalk("that's all");
    await waitSpoken(/^Okay\. Talk later\./);
    await idle();

    // Once to another role, without changing who you're talking to.
    await pushToTalk("Ask the blog writer whether the printer review is drafted");
    await expect.poll(() => chats().length, { timeout: 15_000 }).toBe(2);
    expect(chats()[1]).toEqual({ text: "The printer review is drafted", vertical: "3dpandme", role: "blog-writer", voice: true });
    expect(await picker.inputValue()).toBe("3dpandme/video-producer");

    // The picker, and "who am I talking to?"; a reload keeps the choice.
    await page.reload();
    await picker.waitFor({ timeout: 20_000 });
    await expect.poll(() => picker.inputValue(), { timeout: 15_000 }).toBe("3dpandme/video-producer");
    await pushToTalk("who am I talking to?");
    await waitSpoken(/^You're talking to the Video Producer at 3dpandme\./);
    await idle();
    // Back to the default: the assistant, by voice or the picker.
    await pushToTalk("back to the assistant");
    await waitSpoken(/^You're talking to your assistant\. Go ahead\./);
    expect(await picker.inputValue()).toBe("");
    await idle();
    await pushToTalk("talk to the blog writer");
    await waitSpoken(/^You're talking to the Blog Writer at 3dpandme\. Go ahead\./);
    expect(await picker.inputValue()).toBe("3dpandme/blog-writer");
    await idle();
    // The old name still means the assistant.
    await pushToTalk("back to chief of staff");
    await expect.poll(() => picker.inputValue(), { timeout: 15_000 }).toBe("");
    await idle();
    // Someone it doesn't know.
    await pushToTalk("talk to the shop lead");
    await waitSpoken(/^I don't know who shop lead is\. Say assistant, or a specialist, like video producer\./);
    await idle();
    expect(await picker.locator("option").first().textContent()).toBe("Assistant");
    await picker.selectOption("3dpandme/blog-writer");
    await picker.selectOption("");
    await pushToTalk("who am I talking to?");
    await waitSpoken(/^You're talking to your assistant, which works across all your businesses\./);
    await page.close();
  }, 90_000);

  it("with live transcription, keeps the microphone open between turns and releases it on Fold", async () => {
    // A browser with a fake microphone (a steady tone, from a WAV), and a fake /ws/voice that measures the audio.
    const rate = 48000;
    const samples = rate * 20;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 300 * i) / rate)), 44 + i * 2);
    const tone = join(mkdtempSync(join(tmpdir(), "cc-mic-")), "tone.wav");
    writeFileSync(tone, wav);
    const mic = await chromium.launch({
      executablePath: CHROMIUM,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`, "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await mic.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("cc.test.freshMode", "1")); // push to talk off
    await page.addInitScript(MOCK_SPEECH);
    await page.addInitScript(() => {
      const w = window as unknown as { __streams: MediaStream[] };
      w.__streams = [];
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await open(c);
        w.__streams.push(s);
        return s;
      };
    });
    await page.routeWebSocket(/\/ws$/, () => {});
    const listens: { loud: number }[] = [];
    await page.routeWebSocket(/\/ws\/voice/, (ws) => {
      const turn = { loud: 0 };
      listens.push(turn);
      let answered = false;
      ws.onMessage((m) => {
        if (typeof m === "string") {
          const msg = JSON.parse(m) as { type: string };
          if (msg.type === "hello") ws.send(JSON.stringify({ type: "ready" }));
          if (msg.type === "stop") ws.send(JSON.stringify({ type: "final", text: "tell me a joke" }));
          return;
        }
        const bytes = m as unknown as Uint8Array; // a Node Buffer: copy out its own bytes as 16-bit samples
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        let sum = 0;
        for (const v of pcm) sum += v * v;
        if (Math.sqrt(sum / pcm.length) / 32768 > 0.01) turn.loud++;
        // Like the server: words, then the end of the turn once speech has gone on a while.
        if (!answered && turn.loud > 20) {
          answered = true;
          ws.send(JSON.stringify({ type: "partial", text: "tell me a joke" }));
          ws.send(JSON.stringify({ type: "endOfTurn", text: "tell me a joke" }));
        }
      });
    });
    await mockApi(page, [], { front: true });
    await page.route("**/api/voice/config", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ stt: { provider: "local", model: "x", streaming: true }, tts: null, maxUploadBytes: 0, maxSeconds: 30, language: "en-GB", calendar: false }) }),
    );
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await talk.click();
    // One tap, then it goes round by itself: three turns, each hearing the microphone.
    await expect.poll(() => listens.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => listens.slice(0, 3).every((l) => l.loud > 20), { timeout: 15_000 }).toBe(true);
    const opened = () => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);
    expect(await opened()).toBe(1); // opened once, kept open between turns
    // Folding Converse releases it.
    await page.locator('a.tool[href="#/chat"]').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.every((s) => s.getTracks().every((t) => t.readyState === "ended"))))
      .toBe(true);
    expect(errors).toEqual([]);
    await context.close();
    await mic.close();
  }, 90_000);

  it("in conversation (push to talk off, the default), it listens again after the voice front's answer", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("cc.test.freshMode", "1"));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls, { front: true });
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    expect(await page.getByRole("switch", { name: "Push to talk" }).getAttribute("aria-checked")).toBe("false");
    await expect.poll(() => calls.some((c) => c.path === "/voice/warm"), { timeout: 15_000 }).toBe(true);
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" | "));
    await page.evaluate(() => (window as unknown as { __transcripts: string[] }).__transcripts.push("tell me a joke"));
    // One tap, then just talk: the turn ends on the pause, no Send.
    await talk.click();
    await expect.poll(spoken, { timeout: 15_000 }).toContain("Too many turns.");
    // ... and it's listening again for the next thing, without a tap.
    await page.locator(".drive-state", { hasText: "Listening" }).waitFor({ timeout: 10_000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("hands a follow-up on the agent's answer back to the same task, with the answer", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("cc.test.freshMode", "1"));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls, { front: true });
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    await expect.poll(() => calls.some((c) => c.path === "/voice/warm"), { timeout: 15_000 }).toBe(true);
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" | "));
    // Hands free: the request, the answer to the agent's question, then a follow-up on its answer.
    await page.evaluate(() => (window as unknown as { __transcripts: string[] }).__transcripts.push("where is order 1042?", "the one for Jane", "great, let Jane know"));
    await talk.click();
    await expect.poll(spoken, { timeout: 20_000 }).toContain("Order 1042 shipped on Monday.");
    await expect.poll(spoken, { timeout: 20_000 }).toContain("Okay, I'll tell her.");
    const turns = calls.filter((c) => c.path === "/voice/turn").map((c) => c.body as Record<string, unknown>);
    // The first request had no earlier answer; the follow-up carries the task and what it said.
    expect(turns[0]).toMatchObject({ text: "where is order 1042?", lastTaskId: null, lastAnswer: null });
    expect(turns[1]).toMatchObject({ text: "great, let Jane know", lastTaskId: "t1", lastAnswer: "Order 1042 shipped on Monday." });
    expect(calls.filter((c) => c.path === "/chat")).toHaveLength(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("speaks the voice front's reply as it streams, and follows a request it hands on", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls, { front: true });
    await page.goto(`${base}/#/converse`);
    const talk = page.locator("button.drive-ptt");
    await talk.waitFor({ timeout: 20_000 });
    await expect.poll(() => calls.some((c) => c.path === "/voice/warm"), { timeout: 15_000 }).toBe(true);
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
    const sayNext = (text: string) => page.evaluate((t) => (window as unknown as { __transcripts: string[] }).__transcripts.push(t), text);
    const pushToTalk = async (text: string) => {
      await sayNext(text);
      await talk.click();
      await page.locator(".drive-caption", { hasText: text }).waitFor({ timeout: 15_000 });
      await talk.click();
    };
    const waitSpoken = (pattern: RegExp) => expect.poll(async () => (await spoken()).some((s) => pattern.test(s)), { timeout: 15_000 }).toBe(true);

    // Answered by the front itself, sentence by sentence; no agent task.
    await pushToTalk("tell me a joke");
    await waitSpoken(/^Why did the lathe go to therapy\?$/);
    await waitSpoken(/^Too many turns\.$/);
    await page.locator(".drive-caption", { hasText: "Too many turns." }).waitFor();
    expect(calls.some((c) => c.path === "/chat")).toBe(false);
    await page.locator(".drive-state").getByText("Tap to talk").waitFor();

    // Handed on: the front's own line instead of "On it.", then the agent's answer when it comes.
    await pushToTalk("where is order 1042?");
    await waitSpoken(/^Sure, I'll check where order ten forty-two is\.$/);
    await waitSpoken(/^Which order, 1042 or 1043\?/);
    const turn = calls.find((c) => c.path === "/voice/turn" && (c.body as { text: string }).text === "where is order 1042?");
    expect(turn?.body).toMatchObject({ text: "where is order 1042?", talkingTo: "the assistant" });
    expect(await spoken()).not.toContain("On it.");
    expect(calls.some((c) => c.path === "/chat")).toBe(false);

    // Both exchanges are in the chat's log, as said in Converse: the joke with the front's answer,
    // and the request it handed on with its line and the agent's task.
    await page.locator('a.tool[href="#/chat"]').click();
    await expect.poll(() => page.locator(".drive").count()).toBe(0);
    const said = page.locator(".turn .bubble.me.is-voice");
    await expect.poll(() => said.count()).toBe(2);
    await page.locator(".turn", { hasText: "tell me a joke" }).getByText("Too many turns.").waitFor();
    const handed = page.locator(".turn", { hasText: "where is order 1042?" });
    await handed.getByText("Sure, I'll check where order ten forty-two is.").waitFor();
    await handed.locator('a.status[href="#/task/t1"]').waitFor({ timeout: 10_000 });
    // ... and they're kept with the chat, like typed ones.
    await page.reload();
    await expect.poll(() => page.locator(".turn .bubble.me.is-voice").count(), { timeout: 20_000 }).toBe(2);
    await page.locator(".turn", { hasText: "tell me a joke" }).getByText("Too many turns.").waitFor();
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("Read aloud is off in Chat until switched on, reads this chat's replies only, follows Converse on and off", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    // A live feed the test can push messages into (window.__feed). A choice kept by an earlier version is ignored.
    await page.addInitScript(() => {
      // Every socket opened (in development React builds the feed twice and keeps one).
      const sockets: { onmessage?: (e: { data: string }) => void }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.WebSocket = class {
        onmessage?: (e: { data: string }) => void;
        constructor() {
          sockets.push(this);
        }
        send() {}
        close() {}
      };
      w.__feed = (m: unknown) => sockets.forEach((s) => s.onmessage?.({ data: JSON.stringify(m) }));
      localStorage.setItem("cc.readAloud", "1");
    });
    await mockApi(page, []);
    const feed = (taskId: string, text: string) =>
      page.evaluate(([t, x]) => (window as unknown as { __feed: (m: unknown) => void }).__feed({ type: "run.message", taskId: t, message: { type: "text", text: x } }), [taskId, text]);
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" | "));

    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });
    await box.fill("has order 1042 shipped?");
    await box.press("Enter");
    await page.locator(".turn").first().waitFor();

    // Chat is quiet by default, whatever was chosen before.
    const toggle = page.getByRole("button", { name: /read replies aloud|read aloud/i }).first();
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    await feed("t1", "Said while quiet.");
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");

    // Another task's message isn't this chat's: not read. The chat's own reply is.
    await feed("someone-else", "Not this one.");
    await feed("t1", "It shipped on Monday.");
    await expect.poll(spoken, { timeout: 5_000 }).toContain("It shipped on Monday."); // after waiting up to 1.5 s for the browser's voices
    expect(await spoken()).not.toContain("Not this one.");

    // With Converse open, Converse does the talking: Read aloud keeps quiet.
    await page.locator('a.tool[href="#/converse"]').click();
    await page.locator(".composer.is-open .drive").waitFor({ timeout: 10_000 });
    await feed("t1", "A second reply while conversing.");
    await page.waitForTimeout(2_500);
    expect(await spoken()).not.toContain("A second reply while conversing.");
    expect(await spoken()).not.toContain("Said while quiet.");

    // Folding back to Chat switches Read aloud off again; opening Converse had switched it on.
    await page.locator('a.tool[href="#/chat"]').click();
    await page.locator(".composer.is-open").waitFor({ state: "detached", timeout: 10_000 });
    expect(await page.getByRole("button", { name: /read replies aloud|read aloud/i }).first().getAttribute("aria-pressed")).toBe("false");
    await feed("t1", "Back in chat, quiet again.");
    await page.waitForTimeout(1_500);
    expect(await spoken()).not.toContain("Back in chat, quiet again.");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("on a touch screen, swipe up from the strip on the chat box's right edge opens Converse, and down folds it", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    await mockApi(page, []);
    await page.goto(`${base}/#/chat`);
    const box = page.locator(".composer");
    await box.waitFor({ timeout: 20_000 });
    const cdp = await context.newCDPSession(page);
    /** A quick one-finger swipe from (x, y) by dy, as the touch screen sends it. */
    const swipe = async (x: number, y: number, dy: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 5; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / 5 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const strip = page.locator(".composer-swipe");
    expect(await strip.isVisible()).toBe(true);
    // A swipe up elsewhere on the box (here, its bottom row) is left alone: only the strip swipes.
    let r = (await page.locator(".composer button.send").boundingBox())!;
    await swipe(r.x - 60, r.y + r.height / 2, -160);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => location.hash)).toBe("#/chat");
    // Swipe up from the strip on the right-hand edge: Converse opens.
    r = (await strip.boundingBox())!;
    await swipe(r.x + r.width / 2, r.y + r.height / 2, -120);
    await page.locator(".composer.is-open .drive").waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => location.hash)).toBe("#/converse");
    // Swipe down from the strip on the grown box: back to chat.
    r = (await strip.boundingBox())!;
    await swipe(r.x + r.width / 2, r.y + r.height / 3, 200);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/chat");
    await expect.poll(() => page.locator(".drive").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("on a computer, Space is the orb: hold to talk, or tap; not while typing", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls);
    await page.goto(`${base}/#/converse`);
    await page.locator("button.drive-ptt").waitFor({ timeout: 20_000 });
    await page.locator(".drive-hint", { hasText: "or hold Space" }).waitFor();
    const spoken = () => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" | "));
    const sayNext = (text: string) => page.evaluate((t) => (window as unknown as { __transcripts: string[] }).__transcripts.push(t), text);
    const idle = () => page.locator(".drive-state").getByText("Tap to talk").waitFor({ timeout: 15_000 });

    // Hold Space: it listens while held, and letting go sends.
    await sayNext("What's new?");
    await page.keyboard.down("Space");
    await page.locator(".drive-caption", { hasText: "What's new?" }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.keyboard.up("Space");
    await expect.poll(spoken, { timeout: 15_000 }).toContain("You have 1 approval waiting");
    await idle();

    // Tap Space like the orb: once to talk, again to send.
    await sayNext("read approvals");
    await page.keyboard.press("Space");
    await page.locator(".drive-caption", { hasText: "read approvals" }).waitFor({ timeout: 15_000 });
    await page.keyboard.press("Space");
    await expect.poll(spoken, { timeout: 15_000 }).toContain("Approval 1 of 1");
    await idle();

    // In the text box, Space is just a space.
    const box = page.locator(".composer textarea");
    await box.click();
    await page.keyboard.type("a b");
    expect(await box.inputValue()).toBe("a b");
    expect(await page.locator(".drive-state").textContent()).toContain("Tap to talk");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("keeps the screen awake while open inside the app shell, and lets it sleep after leaving", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // A device that never chose: Converse starts with push to talk off.
    await page.addInitScript(() => sessionStorage.setItem("cc.test.freshMode", "1"));
    await page.addInitScript(MOCK_SPEECH);
    // A recording Screen Wake Lock: counts requests, and how many are still held.
    await page.addInitScript(() => {
      const w = window as unknown as { __wake: { requests: number; held: number; sentinels: { release(): Promise<void> }[] } };
      w.__wake = { requests: 0, held: 0, sentinels: [] };
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async (type: string) => {
            if (type !== "screen") throw new Error(type);
            w.__wake.requests++;
            w.__wake.held++;
            const listeners: (() => void)[] = [];
            let released = false;
            const sentinel = {
              release: async () => {
                if (released) return;
                released = true;
                w.__wake.held--;
                listeners.forEach((f) => f());
              },
              addEventListener: (_t: string, f: () => void) => listeners.push(f),
            };
            w.__wake.sentinels.push(sentinel);
            return sentinel;
          },
        },
      });
    });
    await mockApi(page, []);
    const wake = () => page.evaluate(() => (window as unknown as { __wake: { requests: number; held: number } }).__wake);

    // Opened from the chat composer: Drive grows inside the composer, in the shell (top bar and tab bar still there).
    await page.goto(`${base}/#/chat`);
    await page.locator('a.tool[href="#/converse"]').click();
    await page.locator("button.drive-ptt").waitFor({ timeout: 20_000 });
    expect(await page.locator(".shell .topbar").count()).toBe(1);
    expect(await page.locator(".composer .composer-panel .drive").count()).toBe(1);
    // The text box stays, as another way to give Drive a command; Drive's options are in Settings now.
    expect(await page.locator(".composer textarea").count()).toBe(1);
    expect(await page.locator(".drive details").count()).toBe(0);
    expect(await page.getByRole("switch", { name: "Push to talk" }).getAttribute("aria-checked")).toBe("false");
    await expect.poll(async () => (await wake()).held).toBe(1);
    // Typed in the chat box while driving: Drive handles it (here, the briefing) instead of the chat.
    await page.locator(".composer textarea").fill("what's new");
    await page.locator(".composer button.send").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(" "))).toContain("1 approval waiting");

    // The system takes the lock back (e.g. the screen was switched off), then the page comes back: re-acquired.
    const before = (await wake()).requests;
    await page.evaluate(async () => {
      const w = window as unknown as { __wake: { sentinels: { release(): Promise<void> }[] } };
      await w.__wake.sentinels.at(-1)!.release();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(async () => (await wake()).requests).toBe(before + 1);
    expect((await wake()).held).toBe(1);

    // Leaving Drive (the composer's Drive button again) shrinks it back to the text box and lets the screen sleep.
    await page.locator('a.tool[href="#/chat"]').click();
    await expect.poll(() => page.locator(".drive").count()).toBe(0);
    await expect.poll(async () => (await wake()).held).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
