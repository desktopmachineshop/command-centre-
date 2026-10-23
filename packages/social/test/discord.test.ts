import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterContext, InboundItem, SocialAccount } from "../src";
import { createDiscordAdapter } from "../src/adapters/discord";
import { BOT_INTENTS, type GatewaySocket } from "../src/adapters/discord/gateway";

const TOKEN = "SECRET.bot.token";
const BOT_ID = "900000000000000001";

const account = (options: Record<string, unknown> = {}): SocialAccount => ({
  id: "dms-discord",
  platform: "discord",
  vertical: "dms",
  inbound: true,
  credentials: { botToken: TOKEN },
  options,
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(responses: (Response | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
    return typeof next === "function" ? next(call) : next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function makeCtx(fetch: typeof globalThis.fetch): AdapterContext & { errors: string[] } {
  const errors: string[] = [];
  return {
    fetch,
    now: () => new Date("2026-10-23T12:00:00Z"),
    log: { info: () => {}, error: (m: string, e?: unknown) => errors.push(`${m} ${e instanceof Error ? e.message : ""}`) },
    errors,
  };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: "111",
  channel_id: "222",
  guild_id: "333",
  author: { id: "444", username: "machinist", global_name: "Mach Inist" },
  content: "hello",
  timestamp: "2026-10-23T11:59:00.000Z",
  mentions: [],
  ...over,
});

describe("discord REST", () => {
  it("publishes to content.target with image embeds and the link", async () => {
    const { fetch, calls } = mockFetch([json(message({ id: "555", channel_id: "777" }))]);
    const adapter = createDiscordAdapter({ sleep: async () => {} });
    const res = await adapter.publish(
      account(),
      { text: "New spindle mount", link: "https://desktopmachineshop.com/x", target: "777", media: [{ url: "https://cdn/x.png", type: "image" }] },
      makeCtx(fetch),
    );
    expect(res).toEqual({ id: "555", url: "https://discord.com/channels/333/777/555" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/777/messages");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(calls[0]!.headers["User-Agent"]).toMatch(/^DiscordBot \(/);
    expect(calls[0]!.body).toEqual({
      content: "New spindle mount\nhttps://desktopmachineshop.com/x",
      embeds: [{ image: { url: "https://cdn/x.png" } }],
      allowed_mentions: { parse: ["users", "roles"] },
    });
  });

  it("falls back to announceChannelId and validates limits", async () => {
    const { fetch, calls } = mockFetch([json(message({ channel_id: "888" }))]);
    const adapter = createDiscordAdapter();
    await adapter.publish(account({ announceChannelId: "888" }), { text: "hi" }, makeCtx(fetch));
    expect(calls[0]!.url).toContain("/channels/888/messages");

    expect(adapter.validate(account(), { text: "hi" })).toContain(
      "a target channel id is required (or set options.announceChannelId on the account)",
    );
    expect(adapter.validate(account({ announceChannelId: "1" }), { text: "x".repeat(2001) })).toEqual(["text is longer than 2000 characters"]);
    expect(adapter.validate(account(), { text: "ok", target: "1", media: [{ url: "v", type: "video" }] })).toEqual(["video media is not supported"]);
  });

  it("replies with message_reference", async () => {
    const { fetch, calls } = mockFetch([json(message({ id: "999" }))]);
    const res = await createDiscordAdapter().reply(
      account(),
      { platform: "discord", kind: "mention", id: "111", channelId: "222", guildId: "333" },
      "On it!",
      makeCtx(fetch),
    );
    expect(res.id).toBe("999");
    expect(calls[0]!.url).toContain("/channels/222/messages");
    expect(calls[0]!.body).toMatchObject({
      content: "On it!",
      message_reference: { message_id: "111", fail_if_not_exists: false },
    });
  });

  it("sends a DM by opening a DM channel first", async () => {
    const { fetch, calls } = mockFetch([json({ id: "dm-chan" }), json({ id: "m1", channel_id: "dm-chan" })]);
    const res = await createDiscordAdapter().sendDm!(account(), "444", "Thanks for your order", makeCtx(fetch));
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/users/@me/channels");
    expect(calls[0]!.body).toEqual({ recipient_id: "444" });
    expect(calls[1]!.url).toContain("/channels/dm-chan/messages");
    expect(res).toEqual({ id: "m1", url: "https://discord.com/channels/@me/dm-chan/m1" });
  });

  it("retries after a 429 using retry_after", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch([
      json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429),
      json(message({ id: "ok" })),
    ]);
    const adapter = createDiscordAdapter({ sleep: async (ms) => void sleeps.push(ms) });
    const res = await adapter.publish(account(), { text: "hi", target: "222" }, makeCtx(fetch));
    expect(res.id).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1500]);
  });

  it("waits for a bucket that X-RateLimit-Remaining says is empty", async () => {
    const sleeps: number[] = [];
    const { fetch } = mockFetch([
      json(message({ id: "a" }), 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" }),
      json(message({ id: "b" })),
    ]);
    const adapter = createDiscordAdapter({ sleep: async (ms) => void sleeps.push(ms) });
    const ctx = makeCtx(fetch);
    await adapter.publish(account(), { text: "1", target: "222" }, ctx);
    await adapter.publish(account(), { text: "2", target: "222" }, ctx);
    expect(sleeps).toEqual([2000]);
  });

  it("gives clear errors without the token", async () => {
    const { fetch } = mockFetch([json({ message: "Missing Permissions", code: 50013 }, 403)]);
    const err = await createDiscordAdapter().publish(account(), { text: "x", target: "222" }, makeCtx(fetch)).catch((e) => e);
    expect(err.message).toContain("Missing Permissions");
    expect(err.message).toContain("missing a permission");
    expect(err.message).not.toContain(TOKEN);
  });
});

class FakeSocket implements GatewaySocket {
  sent: { op: number; d: any }[] = [];
  closed: number | null = null;
  onopen: GatewaySocket["onopen"] = null;
  onmessage: GatewaySocket["onmessage"] = null;
  onclose: GatewaySocket["onclose"] = null;
  onerror: GatewaySocket["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  /** Server -> client frame. */
  push(op: number, d: unknown, t?: string, s?: number) {
    this.onmessage?.({ data: JSON.stringify({ op, d, t: t ?? null, s: s ?? null }) });
  }
  /** Server closes the connection. */
  serverClose(code: number) {
    this.onclose?.({ code, reason: "" });
  }
}

function fakeGateway() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    connect: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    get last() {
      return sockets[sockets.length - 1]!;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function connected(options: Record<string, unknown> = {}) {
  const gw = fakeGateway();
  const { fetch } = mockFetch([json({ url: "wss://gw.example", shards: 1 })]);
  const items: InboundItem[] = [];
  const ctx = makeCtx(fetch);
  const adapter = createDiscordAdapter({ connect: gw.connect, random: () => 0.5 });
  const listening = adapter.inbound!.listen!(account(options), async (i) => void items.push(i), ctx);
  await flush();
  const socket = gw.last;
  socket.push(10, { heartbeat_interval: 40_000 });
  socket.push(0, { session_id: "sess", resume_gateway_url: "wss://resume.example", user: { id: BOT_ID, username: "shopbot", bot: true } }, "READY", 1);
  const stop = await listening;
  return { gw, socket, items, stop, ctx };
}

describe("discord gateway", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("identifies with guild message, DM and message content intents", async () => {
    const { socket, stop } = await connected();
    expect(socket.url).toBe("wss://gw.example/?v=10&encoding=json");
    const identify = socket.sent.find((p) => p.op === 2)!;
    expect(identify.d.token).toBe(TOKEN);
    expect(identify.d.intents).toBe(BOT_INTENTS);
    expect(BOT_INTENTS).toBe(1 | 512 | 4096 | 32768);
    await stop();
    expect(socket.closed).toBe(1000);
  });

  it("turns mentions, DMs and watched-channel messages into items and ignores bots and itself", async () => {
    const { socket, items, stop } = await connected({ channelIds: ["222"] });
    const dispatch = (m: Record<string, unknown>, s: number) => socket.push(0, message(m), "MESSAGE_CREATE", s);

    dispatch({ id: "m1", channel_id: "999", content: `<@${BOT_ID}> do you ship to NZ?`, mentions: [{ id: BOT_ID, username: "shopbot" }] }, 2);
    dispatch({ id: "m2", guild_id: undefined, channel_id: "dm1", content: "hi in DM" }, 3);
    dispatch({ id: "m3", channel_id: "222", content: "watched channel" }, 4);
    dispatch({ id: "m4", channel_id: "999", content: "unwatched, no mention" }, 5);
    dispatch({ id: "m5", channel_id: "222", author: { id: "777", username: "otherbot", bot: true } }, 6);
    dispatch({ id: "m6", channel_id: "222", author: { id: BOT_ID, username: "shopbot" } }, 7);
    await flush();

    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["m1", "mention"],
      ["m2", "dm"],
      ["m3", "message"],
    ]);
    expect(items[0]).toMatchObject({
      author: { id: "444", name: "Mach Inist", handle: "machinist" },
      url: "https://discord.com/channels/333/999/m1",
      createdAt: "2026-10-23T11:59:00.000Z",
      replyTarget: { platform: "discord", kind: "mention", id: "m1", channelId: "999", guildId: "333" },
      context: { channel: "999" },
    });
    expect(items[1]!.replyTarget).toMatchObject({ kind: "dm", channelId: "dm1" });
    expect(JSON.parse(JSON.stringify(items))).toEqual(items);
    await stop();
  });

  it("only takes mentions in watched channels when respondToMentionsOnly, and honours guildIds", async () => {
    const { socket, items, stop } = await connected({ channelIds: ["222"], respondToMentionsOnly: true, guildIds: ["333"] });
    socket.push(0, message({ id: "a", channel_id: "222" }), "MESSAGE_CREATE", 2);
    socket.push(0, message({ id: "b", channel_id: "222", mentions: [{ id: BOT_ID, username: "shopbot" }] }), "MESSAGE_CREATE", 3);
    socket.push(0, message({ id: "c", guild_id: "other", mentions: [{ id: BOT_ID, username: "shopbot" }] }), "MESSAGE_CREATE", 4);
    await flush();
    expect(items.map((i) => i.id)).toEqual(["b"]);
    await stop();
  });

  it("heartbeats, and resumes on the resume url after a missed ACK", async () => {
    vi.useFakeTimers();
    const { gw, socket, stop } = await connected();
    await vi.advanceTimersByTimeAsync(20_000); // first beat at interval * jitter(0.5)
    expect(socket.sent.filter((p) => p.op === 1)).toEqual([{ op: 1, d: 1 }]);
    socket.push(11, null);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socket.sent.filter((p) => p.op === 1)).toHaveLength(2);
    // no ACK this time: zombied connection -> close and resume
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socket.closed).toBe(4900);
    await vi.advanceTimersByTimeAsync(10);
    expect(gw.sockets).toHaveLength(2);
    const next = gw.last;
    expect(next.url).toBe("wss://resume.example/?v=10&encoding=json");
    next.push(10, { heartbeat_interval: 40_000 });
    expect(next.sent.find((p) => p.op === 6)).toEqual({ op: 6, d: { token: TOKEN, session_id: "sess", seq: 1 } });
    await stop();
  });

  it("answers op 1 heartbeat requests and reconnects on op 7", async () => {
    vi.useFakeTimers();
    const { gw, socket, stop } = await connected();
    socket.push(1, null);
    expect(socket.sent.at(-1)).toEqual({ op: 1, d: 1 });
    socket.push(7, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(gw.sockets).toHaveLength(2);
    gw.last.push(10, { heartbeat_interval: 40_000 });
    expect(gw.last.sent[0]!.op).toBe(6);
    await stop();
  });

  it("identifies afresh after a non-resumable invalid session", async () => {
    vi.useFakeTimers();
    const { gw, socket, stop } = await connected();
    socket.push(9, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.last.url).toBe("wss://gw.example/?v=10&encoding=json");
    gw.last.push(10, { heartbeat_interval: 40_000 });
    expect(gw.last.sent.find((p) => p.op === 2)).toBeTruthy();
    await stop();
  });

  it("backs off on repeated drops and stops on fatal close codes", async () => {
    vi.useFakeTimers();
    const { gw, socket, ctx } = await connected();
    socket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.sockets).toHaveLength(2); // first reconnect is immediate
    gw.last.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gw.sockets).toHaveLength(2); // waiting out the backoff
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gw.sockets).toHaveLength(3);
    gw.last.serverClose(4004);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gw.sockets).toHaveLength(3);
    expect(ctx.errors.join("\n")).toContain("authentication failed");
    expect(ctx.errors.join("\n")).not.toContain(TOKEN);
  });

  it("rejects listen when the gateway refuses the intents", async () => {
    const gw = fakeGateway();
    const { fetch } = mockFetch([json({ url: "wss://gw.example" })]);
    const listening = createDiscordAdapter({ connect: gw.connect }).inbound!.listen!(account(), async () => {}, makeCtx(fetch));
    await flush();
    gw.last.push(10, { heartbeat_interval: 40_000 });
    gw.last.serverClose(4014);
    await expect(listening).rejects.toThrow(/Message Content intent/);
  });
});
