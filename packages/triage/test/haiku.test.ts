import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defineVertical, type Event } from "@cc/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicTriager, type TriageUsage } from "../src";

const context = {
  verticals: [
    defineVertical({ id: "personal", name: "Personal", description: "Life admin", brainFolder: "personal", intents: ["admin"] }),
    defineVertical({ id: "dms", name: "Desktop Machine Shop", description: "CNC shop", brainFolder: "dms", intents: ["order-status", "spam"] }),
  ],
  defaultVertical: "personal",
};

const event = (over: Partial<Event> = {}): Event => ({
  id: "e1",
  source: "email",
  vertical: null,
  kind: "message",
  title: "Where is my order S01482?",
  payload: { from: "a@b.com", text: "No dispatch email yet." },
  dedupeKey: null,
  receivedAt: new Date().toISOString(),
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  vertical: "dms",
  intent: "order-status",
  urgency: 0.6,
  noise: 0.01,
  fyi: 0.05,
  simple: 0.3,
  confidence: 0.92,
  ...over,
});

const message = (text: string, over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 50 },
  ...over,
});

// A local stand-in for the Messages API: each test sets `reply`.
let server: Server;
let baseUrl: string;
let requests: { url: string; headers: IncomingHttpHeaders; body: any }[] = [];
let reply: (body: any) => { status: number; body: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url!, headers: req.headers, body });
      const r = reply(body);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      };
      r.delayMs ? setTimeout(send, r.delayMs) : send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  requests = [];
});

const triager = (over: Partial<ConstructorParameters<typeof AnthropicTriager>[0]> = {}) =>
  new AnthropicTriager({ apiKey: "sk-test", baseUrl, maxRetries: 0, ...over });

describe("AnthropicTriager", () => {
  it("sends a structured-output Messages request", async () => {
    reply = () => ({ status: 200, body: message(JSON.stringify(answer())) });
    await triager().triage(event(), context);

    expect(requests).toHaveLength(1);
    const { url, headers, body } = requests[0]!;
    expect(url).toBe("/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.effort).toBe("low");
    const schema = body.output_config.format.schema;
    expect(body.output_config.format.type).toBe("json_schema");
    expect(schema.properties.vertical.enum).toEqual(["personal", "dms"]);
    expect(schema.properties.intent.enum).toEqual(["admin", "other", "order-status", "spam"]);
    expect(schema.additionalProperties).toBe(false);
    expect(body.system).toContain("dms (Desktop Machine Shop)");
    expect(body.messages[0].content).toContain("Where is my order S01482?");
  });

  it("maps the answer to a TriageResult and reports usage", async () => {
    reply = () => ({ status: 200, body: message(JSON.stringify(answer())) });
    const usages: TriageUsage[] = [];
    const r = await triager({ onUsage: (u) => usages.push(u) }).triage(event(), context);
    expect(r).toEqual({ vertical: "dms", intent: "order-status", urgency: 0.6, route: "agent", confidence: 0.92, triager: "haiku" });
    expect(usages[0]).toMatchObject({ triager: "haiku", inputTokens: 1000, outputTokens: 50 });
    expect(usages[0]!.costUsd).toBeCloseTo((1000 * 0.1 + 50 * 0.5) / 1e6, 10);
  });

  it("picks routes from the signals and clamps out-of-range numbers", async () => {
    const run = async (over: Record<string, unknown>) => {
      reply = () => ({ status: 200, body: message(JSON.stringify(answer(over))) });
      return triager().triage(event(), context);
    };
    expect((await run({ intent: "spam", confidence: 0.95 }))?.route).toBe("drop");
    expect((await run({ fyi: 0.9 }))?.route).toBe("file");
    expect((await run({ simple: 0.85 }))?.route).toBe("cheap-agent");
    const r = await run({ urgency: 7, confidence: 1.5 });
    expect(r).toMatchObject({ urgency: 1, confidence: 1 });
  });

  it("treats an intent from another vertical as other, with lower confidence", async () => {
    reply = () => ({ status: 200, body: message(JSON.stringify(answer({ vertical: "personal", intent: "order-status" }))) });
    expect(await triager().triage(event(), context)).toMatchObject({ vertical: "personal", intent: "other", confidence: 0.5 });
  });

  it("only offers the known vertical when ingress set one", async () => {
    reply = () => ({ status: 200, body: message(JSON.stringify(answer())) });
    await triager().triage(event({ vertical: "dms" }), context);
    expect(requests[0]!.body.output_config.format.schema.properties.vertical.enum).toEqual(["dms"]);
  });

  it("returns null on API errors, refusals, bad JSON and timeouts", async () => {
    const errors: unknown[] = [];
    const t = triager({ timeoutMs: 100, onError: (e) => errors.push(e) });

    reply = () => ({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    expect(await t.triage(event(), context)).toBeNull();
    reply = () => ({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
    expect(await t.triage(event(), context)).toBeNull();
    reply = () => ({ status: 200, body: message("", { stop_reason: "refusal", content: [] }) });
    expect(await t.triage(event(), context)).toBeNull();
    reply = () => ({ status: 200, body: message("not json") });
    expect(await t.triage(event(), context)).toBeNull();
    reply = () => ({ status: 200, body: message(JSON.stringify({ vertical: "dms" })) });
    expect(await t.triage(event(), context)).toBeNull();
    reply = () => ({ status: 200, body: message(JSON.stringify(answer({ vertical: "nope" }))) });
    expect(await t.triage(event(), context)).toBeNull();

    reply = () => ({ status: 200, body: message(JSON.stringify(answer())), delayMs: 2000 });
    const started = Date.now();
    expect(await t.triage(event(), context)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);

    // The unknown-vertical case returns null without an error; the other six report one.
    expect(errors).toHaveLength(6);
  });
});
