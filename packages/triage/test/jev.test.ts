import { defineVertical, type Event } from "@cc/core";
import { describe, expect, it } from "vitest";
import { JevTriager, type TriageUsage } from "../src";

const context = {
  verticals: [
    defineVertical({ id: "personal", name: "Personal", description: "Life admin", brainFolder: "personal", intents: ["admin"] }),
    defineVertical({
      id: "dms",
      name: "Desktop Machine Shop",
      description: "CNC accessories shop",
      brainFolder: "dms",
      intents: ["order-status", "spam"],
    }),
  ],
  defaultVertical: "personal",
};

const event = (over: Partial<Event> = {}): Event => ({
  id: "e1",
  source: "email",
  vertical: null,
  kind: "message",
  title: "Where is my order S01482?",
  payload: { from: "a@b.com", subject: "Order S01482", text: "No dispatch email yet." },
  dedupeKey: null,
  receivedAt: new Date().toISOString(),
  ...over,
});

interface Answers {
  vertical?: Record<string, number>;
  intent: Record<string, number>;
  urgency?: number;
  noise?: number;
  fyi?: number;
  simple?: number;
}

function jevBody(a: Answers) {
  const choice = (probabilities: Record<string, number>) => {
    const [choice] = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]!;
    return { type: "choice", choice, confidence: probabilities[choice], probabilities };
  };
  return {
    model: "jev-1.13.0",
    answers: {
      ...(a.vertical ? { vertical: choice(a.vertical) } : {}),
      intent: choice(a.intent),
      urgency: { type: "score", score: a.urgency ?? 2, confidence: 0.6, legend: {}, probabilities: {} },
      noise: { type: "noul", noul: a.noise ?? 0.02 },
      fyi: { type: "noul", noul: a.fyi ?? 0.05 },
      simple: { type: "noul", noul: a.simple ?? 0.2 },
    },
    usage: { input_tokens: 400, output_tokens: 60 },
  };
}

/** A fetch that records requests and answers with `respond`. */
function mockFetch(respond: (body: any) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), init: init!, body });
    return respond(body);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("JevTriager", () => {
  it("sends one System One request with typed questions", async () => {
    const http = mockFetch(() => json(jevBody({ vertical: { dms: 0.9, personal: 0.1 }, intent: { "dms/order-status": 0.95 } })));
    await new JevTriager({ apiKey: "k", fetch: http.fn }).triage(event(), context);

    expect(http.calls).toHaveLength(1);
    const { url, init, body } = http.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(body.model).toBe("jev-latest");
    expect(body.state).toMatchObject({ source: "email", title: "Where is my order S01482?", subject: "Order S01482" });

    const q = body.questions;
    expect(q.vertical.type).toBe("choice");
    expect(Object.keys(q.vertical.criteria)).toEqual(["personal", "dms"]);
    expect(q.vertical.criteria.dms).toContain("Desktop Machine Shop");
    expect(Object.keys(q.intent.criteria)).toEqual(["personal/admin", "personal/other", "dms/order-status", "dms/spam", "dms/other"]);
    expect(q.urgency.type).toBe("score");
    expect(q.urgency.criteria).toHaveLength(5);
    expect(q.noise.type).toBe("noul");
    expect(q.noise.criteria).toHaveProperty("true");
    expect(q.fyi.type).toBe("noul");
    expect(q.simple.type).toBe("noul");
  });

  it("maps answers to a TriageResult", async () => {
    const http = mockFetch(() =>
      json(jevBody({ vertical: { dms: 0.9, personal: 0.1 }, intent: { "dms/order-status": 0.8, "dms/other": 0.1, "personal/admin": 0.1 }, urgency: 3 })),
    );
    const usages: TriageUsage[] = [];
    const r = await new JevTriager({ apiKey: "k", fetch: http.fn, onUsage: (u) => usages.push(u) }).triage(event(), context);

    expect(r).toMatchObject({ vertical: "dms", intent: "order-status", route: "agent", triager: "jev" });
    expect(r!.urgency).toBeCloseTo(0.75);
    // P(intent | dms) = 0.8 / 0.9; confidence is the min with P(vertical) = 0.9.
    expect(r!.confidence).toBeCloseTo(0.8889, 3);
    expect(usages).toEqual([{ triager: "jev", model: "jev-1.13.0", inputTokens: 400, outputTokens: 60, costUsd: expect.closeTo(460 * 0.04e-6, 12) }]);
  });

  it("routes spam to drop, FYI to file and simple items to the cheap agent", async () => {
    const triage = async (a: Answers) => {
      const http = mockFetch(() => json(jevBody(a)));
      return new JevTriager({ apiKey: "k", fetch: http.fn }).triage(event(), context);
    };
    const v = { dms: 0.95, personal: 0.05 };
    expect((await triage({ vertical: v, intent: { "dms/spam": 0.9 } }))?.route).toBe("drop");
    expect((await triage({ vertical: v, intent: { "dms/other": 0.9 }, noise: 0.95 }))?.route).toBe("drop");
    expect((await triage({ vertical: v, intent: { "dms/spam": 0.6, "dms/other": 0.4 } }))?.route).toBe("agent");
    expect((await triage({ vertical: v, intent: { "dms/order-status": 0.9 }, fyi: 0.9 }))?.route).toBe("file");
    expect((await triage({ vertical: v, intent: { "dms/order-status": 0.9 }, simple: 0.8 }))?.route).toBe("cheap-agent");
  });

  it("asks only for the known vertical's intents when ingress set one", async () => {
    const http = mockFetch(() => json(jevBody({ intent: { "dms/order-status": 0.7, "dms/other": 0.3 } })));
    const r = await new JevTriager({ apiKey: "k", fetch: http.fn }).triage(event({ vertical: "dms" }), context);
    expect(http.calls[0]!.body.questions.vertical).toBeUndefined();
    expect(Object.keys(http.calls[0]!.body.questions.intent.criteria)).toEqual(["dms/order-status", "dms/spam", "dms/other"]);
    expect(r).toMatchObject({ vertical: "dms", intent: "order-status" });
    expect(r!.confidence).toBeCloseTo(0.7);
  });

  it("honours baseUrl and model", async () => {
    const http = mockFetch(() => json(jevBody({ vertical: { dms: 1 }, intent: { "dms/order-status": 1 } })));
    await new JevTriager({ apiKey: "k", fetch: http.fn, baseUrl: "http://proxy:4000/typesafe/", model: "jev-1.13.0" }).triage(event(), context);
    expect(http.calls[0]!.url).toBe("http://proxy:4000/typesafe/v1/systemone");
    expect(http.calls[0]!.body.model).toBe("jev-1.13.0");
  });

  it("truncates long event bodies", async () => {
    const http = mockFetch(() => json(jevBody({ vertical: { dms: 1 }, intent: { "dms/order-status": 1 } })));
    await new JevTriager({ apiKey: "k", fetch: http.fn, maxChars: 1000 }).triage(event({ payload: { text: "x".repeat(20_000) } }), context);
    expect(JSON.stringify(http.calls[0]!.body.state).length).toBeLessThanOrEqual(1100);
  });

  it("returns null on HTTP errors, bad bodies, network errors and timeouts", async () => {
    const errors: unknown[] = [];
    const run = (f: typeof fetch, timeoutMs = 1000) =>
      new JevTriager({ apiKey: "k", fetch: f, timeoutMs, onError: (e) => errors.push(e) }).triage(event(), context);

    expect(await run(mockFetch(() => json({ detail: "bad key" }, 401)).fn)).toBeNull();
    expect(await run(mockFetch(() => json({ detail: "busy" }, 529)).fn)).toBeNull();
    expect(await run(mockFetch(() => json({ answers: {} })).fn)).toBeNull();
    expect(await run(mockFetch(() => new Response("<html>oops</html>")).fn)).toBeNull();
    expect(await run((async () => { throw new TypeError("fetch failed"); }) as typeof fetch)).toBeNull();

    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    expect(await run(hang, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);

    expect(errors).toHaveLength(6);
    expect(String(errors[0])).toContain("401");
    expect(String(errors[5])).toContain("timed out");
  });

  it("returns null when Jev picks a vertical that does not exist", async () => {
    const http = mockFetch(() => json(jevBody({ vertical: { nope: 1 }, intent: { "dms/order-status": 1 } })));
    expect(await new JevTriager({ apiKey: "k", fetch: http.fn }).triage(event(), context)).toBeNull();
  });
});
