import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

/** Sendcloud "DD-MM-YYYY HH:MM:SS" in Amsterdam time. */
function scDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

const now = new Date();
const hoursAgo = (h: number) => scDate(new Date(now.getTime() - h * 3_600_000));
const daysAgo = (d: number) => hoursAgo(d * 24);
const AUTH = `Basic ${Buffer.from("pub-key:sec-key-0123456789").toString("base64")}`;

const PARCELS = [
  { id: 1, name: "Jane Smith", order_number: "S00042", tracking_number: "RM1", tracking_url: "https://track.test/RM1", carrier: { code: "royal_mail" }, status: { id: 3, message: "En route to sorting center" }, date_created: hoursAgo(2), date_updated: hoursAgo(1) },
  { id: 2, name: "Bob Jones", order_number: "S00040", tracking_number: "DPD2", carrier: { code: "dpd" }, status: { id: 8, message: "Delivery attempt failed" }, date_created: daysAgo(3), date_updated: daysAgo(1) },
];

const calls: string[] = [];
const sendcloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (new Headers(init?.headers).get("authorization") !== AUTH) return new Response("{}", { status: 401 });
  if (url.pathname.endsWith("/user")) return Response.json({ user: { username: "dave", company_name: "Desktop Machine Shop" } });
  return Response.json({ parcels: PARCELS, next: null, previous: null });
}) as typeof fetch;

describe.skipIf(!DB_URL)("Sendcloud (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { sendcloudFetch, sendcloudBaseUrl: "https://sendcloud.test/api/v2", integrationsFetch: sendcloudFetch } });
  });
  afterAll(async () => ctx?.server.stop());

  it("adds no Shipping section until an account is connected", async () => {
    const { body } = await ctx.api("/api/digest?vertical=dms");
    expect(body.digests[0].shipping).toBeNull();
    expect(calls).toEqual([]);
  });

  it("is set up from the Accounts page and tested against Sendcloud", async () => {
    const res = await ctx.api("/api/integrations/sendcloud/dms-sendcloud", {
      method: "PUT",
      json: { data: { vertical: "dms", publicKey: "pub-key" }, secrets: { secretKey: "sec-key-0123456789" } },
    });
    expect(res.status).toBe(200);
    expect(ctx.server.integrations.current().shipping.accounts).toEqual([{ id: "dms-sendcloud", vertical: "dms", publicKey: "pub-key", secretKey: "sec-key-0123456789", odooNotes: true }]);
    const list = await ctx.api("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain("sec-key-0123456789");
    const test = await ctx.api("/api/integrations/sendcloud/dms-sendcloud/test", { method: "POST" });
    expect(test.body).toMatchObject({ ok: true, message: "Sendcloud accepted the keys (Desktop Machine Shop)" });
  });

  it("puts parcels in the business's daily digest", async () => {
    const { body } = await ctx.api("/api/digest?vertical=dms");
    const d = body.digests[0];
    expect(d.shipping.inTransit.map((p: { order: string }) => p.order)).toEqual(["S00042"]);
    expect(d.shipping.problems.map((p: { order: string }) => p.order)).toEqual(["S00040"]);
    expect(d.headline).toContain("1 in transit, 1 shipping problem");
    expect(d.markdown).toContain("## Shipping (Sendcloud)");
    expect(d.markdown).toContain("S00040, Bob Jones: dpd DPD2, Delivery attempt failed");
    // Another business's digest doesn't read this account.
    expect((await ctx.api("/api/digest?vertical=3dpandme")).body.digests[0].shipping).toBeNull();
  });

  it("writes the digest note with the Shipping section", async () => {
    const delivered = await ctx.server.digests.deliver(undefined, { push: false });
    const dms = delivered.find((d) => d.vertical === "dms")!;
    expect(dms.shipping?.problems).toHaveLength(1);
  });
});
