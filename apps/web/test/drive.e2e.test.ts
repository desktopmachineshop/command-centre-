/**
 * Drive page in real Chromium with the speech APIs and the server mocked:
 * renders, runs local commands (briefing, approval with confirmation) and a
 * conversational chat that continues the same task. Skipped when no Chromium
 * is installed (set PW_CHROMIUM to point at one).
 */
import { existsSync } from "node:fs";
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
        : [{ delta: "Sure, I'll check " }, { delta: "where order ten forty-two is." }, { done: true, text: "", handoff: { taskId: "t1" } }];
      return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lines.map((l) => JSON.stringify(l)).join("\n") });
    }
    if (path === "/voice/config") return json({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 60, language: "en-GB", calendar: false });
    if (path === "/verticals") return json([{ id: "dms", name: "Desktop Machine Shop" }, { id: "personal", name: "Personal" }]);
    if (path === "/stats") return json({ pendingApprovals: 1, costTodayUsd: 0 });
    if (path === "/org") {
      const role = (id: string, title: string, vertical: string, aliases: string[], children: unknown[] = []) => ({ id, title, vertical, aliases, children });
      return json({
        root: {
          ...role("chief-of-staff", "Chief of Staff", "personal", ["cos", "chief"]),
          verticals: [{ id: "dms", name: "Desktop Machine Shop", lead: role("shop-lead", "Shop Lead", "dms", ["shop"], [role("customer-support", "Customer Support", "dms", ["support"])]) }],
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
    await page.goto(`${base}/#/drive`);

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
    await page.getByRole("button", { name: "Conversation" }).click();
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
    await page.goto(`${base}/#/drive`);
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
    await page.goto(`${base}/#/drive`);
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

    await pushToTalk("talk to the shop lead");
    await waitSpoken(/^You're talking to the Shop Lead at Desktop Machine Shop\. Go ahead\./);
    expect(await picker.inputValue()).toBe("dms/shop-lead");
    expect(await page.evaluate(() => localStorage.getItem("cc.drive.talkTo"))).toBe(JSON.stringify({ vertical: "dms", role: "shop-lead" }));
    await idle();

    await pushToTalk("what sold yesterday?");
    await expect.poll(() => chats().length, { timeout: 15_000 }).toBe(1);
    expect(chats()[0]).toEqual({ text: "what sold yesterday?", vertical: "dms", role: "shop-lead", voice: true });
    await waitSpoken(/^Which order/);
    // That answer was a question: end the conversation, so the next request isn't taken as the reply.
    await idle();
    await pushToTalk("that's all");
    await waitSpoken(/^Okay\. Talk later\./);
    await idle();

    // Once to another role, without changing who you're talking to.
    await pushToTalk("Ask customer support whether Jane's refund went through");
    await expect.poll(() => chats().length, { timeout: 15_000 }).toBe(2);
    expect(chats()[1]).toEqual({ text: "Jane's refund went through", vertical: "dms", role: "customer-support", voice: true });
    expect(await picker.inputValue()).toBe("dms/shop-lead");

    // The picker, and "who am I talking to?"; a reload keeps the choice.
    await page.reload();
    await picker.waitFor({ timeout: 20_000 });
    await expect.poll(() => picker.inputValue(), { timeout: 15_000 }).toBe("dms/shop-lead");
    await pushToTalk("who am I talking to?");
    await waitSpoken(/^You're talking to the Shop Lead at Desktop Machine Shop\./);
    await idle();
    // Back to the default: the Chief of Staff, by voice or the picker.
    await pushToTalk("back to chief of staff");
    await waitSpoken(/^You're talking to the Chief of Staff\. Go ahead\./);
    expect(await picker.inputValue()).toBe("");
    await idle();
    await picker.selectOption("dms/customer-support");
    await picker.selectOption("");
    await pushToTalk("who am I talking to?");
    await waitSpoken(/^You're talking to the Chief of Staff, who passes things to the right role/);
    await page.close();
  }, 90_000);

  it("speaks the voice front's reply as it streams, and follows a request it hands on", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(MOCK_SPEECH);
    const calls: Calls = [];
    await mockApi(page, calls, { front: true });
    await page.goto(`${base}/#/drive`);
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
    expect(turn?.body).toMatchObject({ text: "where is order 1042?", talkingTo: "the Chief of Staff" });
    expect(await spoken()).not.toContain("On it.");
    expect(calls.some((c) => c.path === "/chat")).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("keeps the screen awake while open inside the app shell, and lets it sleep after leaving", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
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
    await page.locator('a.tool[href="#/drive"]').click();
    await page.locator("button.drive-ptt").waitFor({ timeout: 20_000 });
    expect(await page.locator(".shell .topbar").count()).toBe(1);
    expect(await page.locator(".composer .composer-panel .drive").count()).toBe(1);
    expect(await page.locator(".composer textarea").count()).toBe(0);
    await expect.poll(async () => (await wake()).held).toBe(1);
    await page.locator("details.drive-more > summary").click();
    await expect.poll(() => page.locator(".drive-more").textContent()).toContain("Screen: kept on");

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
    await page.locator(".composer textarea").waitFor();
    expect(await page.locator(".drive").count()).toBe(0);
    await expect.poll(async () => (await wake()).held).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
