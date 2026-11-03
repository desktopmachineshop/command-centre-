import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createSendcloudMcpServer,
  parcelState,
  parseSendcloudDate,
  renderShippingDigest,
  SendcloudAuthError,
  SendcloudClient,
  type SendcloudParcel,
  sendcloudAccountFromEnv,
  ShippingService,
  shippingHeadline,
  summariseParcels,
} from "../src";

const BASE = "https://sendcloud.test/api/v2";

/** "DD-MM-YYYY HH:MM:SS" in Amsterdam time, as Sendcloud writes dates. */
function scDate(iso: string): string {
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function parcel(id: number, statusId: number, message: string, updated: string, extra: Partial<SendcloudParcel> = {}): SendcloudParcel {
  return {
    id,
    name: `Customer ${id}`,
    order_number: `S000${id}`,
    tracking_number: `TRK${id}`,
    tracking_url: `https://track.test/${id}`,
    carrier: { code: "royal_mail" },
    status: { id: statusId, message },
    date_created: scDate(extra.date_created ?? updated),
    date_updated: scDate(updated),
    ...extra,
    ...(extra.date_created ? { date_created: scDate(extra.date_created) } : {}),
  };
}

/** A fake Sendcloud: checks Basic auth, filters by tracking/order number, pages two at a time. */
function fakeSendcloud(parcels: SendcloudParcel[], keys = { pub: "pub", sec: "sec" }) {
  const calls: URL[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Basic ${Buffer.from(`${keys.pub}:${keys.sec}`).toString("base64")}`) return new Response("{}", { status: 401 });
    if (url.pathname.endsWith("/user")) return Response.json({ user: { username: "dave", company_name: "Desktop Machine Shop" } });
    let list = parcels;
    const t = url.searchParams.get("tracking_number");
    const o = url.searchParams.get("order_number");
    if (t) list = list.filter((p) => p.tracking_number === t);
    if (o) list = list.filter((p) => p.order_number === o);
    const at = Number(url.searchParams.get("cursor") ?? 0);
    const page = list.slice(at, at + 2);
    const next = at + 2 < list.length ? `${BASE}/parcels?cursor=${at + 2}${t ? `&tracking_number=${t}` : ""}${o ? `&order_number=${o}` : ""}` : null;
    return Response.json({ parcels: page, next, previous: null });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("parcelState", () => {
  it("sorts statuses by id, then by wording", () => {
    expect(parcelState({ status: { id: 11, message: "Delivered" } })).toBe("delivered");
    expect(parcelState({ status: { id: 3, message: "En route to sorting center" } })).toBe("in_transit");
    expect(parcelState({ status: { id: 1000, message: "Ready to send" } })).toBe("label");
    expect(parcelState({ status: { id: 12, message: "Awaiting customer pickup" } })).toBe("pickup_point");
    expect(parcelState({ status: { id: 8, message: "Delivery attempt failed" } })).toBe("problem");
    expect(parcelState({ status: { id: 2000, message: "Cancelled" } })).toBe("cancelled");
    expect(parcelState({ status: { id: 55555, message: "Returned to sender" } })).toBe("problem");
    expect(parcelState({ status: { id: 55555, message: "Parcel at the depot" } })).toBe("in_transit");
  });

  it("reads Sendcloud dates as Amsterdam time", () => {
    expect(parseSendcloudDate("15-07-2026 14:30:00")?.toISOString()).toBe("2026-07-15T12:30:00.000Z"); // CEST
    expect(parseSendcloudDate("15-01-2026 14:30:00")?.toISOString()).toBe("2026-01-15T13:30:00.000Z"); // CET
    expect(parseSendcloudDate("nope")).toBeNull();
  });
});

describe("SendcloudClient", () => {
  it("authenticates with the key pair and follows next pages", async () => {
    const all = [1, 2, 3, 4, 5].map((i) => parcel(i, 3, "En route", "2026-11-03T10:00:00Z"));
    const sc = fakeSendcloud(all);
    const client = new SendcloudClient({ publicKey: "pub", secretKey: "sec", baseUrl: BASE, fetch: sc.fetch });
    const since = new Date("2026-10-01T00:00:00Z");
    expect((await client.listParcels({ updatedAfter: since })).map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(sc.calls[0]!.searchParams.get("updated_after")).toBe(since.toISOString());
    expect(sc.calls).toHaveLength(3);
    expect(await client.user()).toEqual({ username: "dave", companyName: "Desktop Machine Shop" });
  });

  it("does not follow a next link to another host", async () => {
    const fetch = (async () => Response.json({ parcels: [parcel(1, 3, "x", "2026-11-03T10:00:00Z")], next: "https://evil.test/parcels?cursor=2" })) as typeof globalThis.fetch;
    const client = new SendcloudClient({ publicKey: "pub", secretKey: "sec", baseUrl: BASE, fetch });
    expect(await client.listParcels()).toHaveLength(1);
  });

  it("says when the keys are wrong", async () => {
    const client = new SendcloudClient({ publicKey: "pub", secretKey: "wrong", baseUrl: BASE, fetch: fakeSendcloud([]).fetch });
    await expect(client.user()).rejects.toBeInstanceOf(SendcloudAuthError);
  });
});

describe("shipping digest", () => {
  const start = new Date("2026-11-03T00:00:00Z");
  const end = new Date("2026-11-04T00:00:00Z");
  const now = new Date("2026-11-03T18:30:00Z");
  const parcels = [
    parcel(1, 11, "Delivered", "2026-11-03T11:00:00Z"),
    parcel(2, 11, "Delivered", "2026-11-01T11:00:00Z"), // delivered before today: not reported
    parcel(3, 3, "En route to sorting center", "2026-11-03T08:00:00Z"),
    parcel(4, 8, "Delivery attempt failed", "2026-11-02T15:00:00Z"),
    parcel(5, 5, "Sorted", "2026-10-27T09:00:00Z"), // stalled for 7 days
    parcel(6, 12, "Awaiting customer pickup", "2026-11-02T12:00:00Z"),
    parcel(7, 1000, "Ready to send", "2026-10-31T16:00:00Z"), // label 3 days old, not collected
    parcel(8, 1000, "Ready to send", "2026-11-03T09:00:00Z"), // label made today
    parcel(9, 2000, "Cancelled", "2026-11-03T09:00:00Z"),
  ];

  it("sorts parcels into delivered today, in transit, problems and waiting", () => {
    const d = summariseParcels(parcels, { start, end, now })!;
    expect(d.deliveredToday.map((p) => p.id)).toEqual([1]);
    expect(d.inTransit.map((p) => p.id)).toEqual([3]);
    expect(d.problems.map((p) => p.id)).toEqual([5, 4]);
    expect(d.problems[0]!.note).toBe("no tracking update for 7 days");
    expect(d.atPickupPoint.map((p) => p.id)).toEqual([6]);
    expect(d.notCollected.map((p) => p.id)).toEqual([7]);
    expect(d.labelsToday).toBe(1);
    expect(shippingHeadline(d)).toEqual(["1 delivered", "1 in transit", "2 shipping problems"]);
    const md = renderShippingDigest(d).join("\n");
    expect(md).toContain("## Shipping (Sendcloud)");
    expect(md).toContain("- Needs a look: 2");
    expect(md).toContain("S0004, Customer 4: royal_mail [TRK4](https://track.test/4), Delivery attempt failed");
    expect(md).toContain("no tracking update for 7 days (last: Sorted)");
    expect(md).toContain("- Not picked up by the carrier yet: 1");
  });

  it("is null on a quiet day", () => {
    expect(summariseParcels([parcel(2, 11, "Delivered", "2026-11-01T11:00:00Z")], { start, end, now })).toBeNull();
    expect(shippingHeadline(null)).toEqual([]);
  });

  it("reads each business's own accounts, and reports one that fails", async () => {
    const ok = fakeSendcloud(parcels);
    const service = new ShippingService(
      [
        { id: "dms-sc", vertical: "dms", publicKey: "pub", secretKey: "sec" },
        { id: "dms-old", vertical: "dms", publicKey: "pub", secretKey: "revoked" },
        { id: "3d-sc", vertical: "3dpandme", publicKey: "pub", secretKey: "sec" },
      ],
      { baseUrl: BASE, fetch: ok.fetch },
    );
    const d = (await service.digest("dms", start, end, now))!;
    expect(d.deliveredToday.map((p) => p.id)).toEqual([1]); // de-duplicated across accounts
    expect(d.errors).toEqual(["dms-old: Sendcloud rejected the API keys (HTTP 401)"]);
    expect(await service.digest("openv", start, end, now)).toBeNull();
  });
});

describe("sendcloud MCP server", () => {
  async function connect(vertical: string | null) {
    const service = new ShippingService(
      [
        { id: "dms-sc", vertical: "dms", publicKey: "pub", secretKey: "sec" },
        { id: "3d-sc", vertical: "3dpandme", publicKey: "pub", secretKey: "sec" },
      ],
      { baseUrl: BASE, fetch: fakeSendcloud([parcel(1, 11, "Delivered", new Date().toISOString()), parcel(4, 8, "Delivery attempt failed", new Date().toISOString())]).fetch },
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createSendcloudMcpServer(service, vertical).connect(serverT);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientT);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { isError: !!res.isError, text: res.content[0]!.text };
    };
  }

  it("finds a parcel by order number within the run's business", async () => {
    const call = await connect("dms");
    const found = JSON.parse((await call("find_parcel", { order_number: "S0004" })).text);
    expect(found.parcels).toEqual([expect.objectContaining({ id: 4, account: "dms-sc", state: "problem", tracking_url: "https://track.test/4" })]);
    expect((await call("find_parcel", {})).isError).toBe(true);
  });

  it("lists recent parcels filtered by state", async () => {
    const call = await connect(null);
    const res = JSON.parse((await call("recent_parcels", { state: "delivered" })).text);
    expect(res.parcels.map((p: { account: string }) => p.account).sort()).toEqual(["3d-sc", "dms-sc"]);
  });
});

describe("env account", () => {
  it("needs both keys", () => {
    expect(sendcloudAccountFromEnv({})).toEqual([]);
    expect(sendcloudAccountFromEnv({ SENDCLOUD_PUBLIC_KEY: "p", SENDCLOUD_SECRET_KEY: "s" })).toEqual([{ id: "sendcloud", vertical: "dms", publicKey: "p", secretKey: "s" }]);
    expect(() => sendcloudAccountFromEnv({ SENDCLOUD_PUBLIC_KEY: "p" })).toThrow(/both/);
  });
});
