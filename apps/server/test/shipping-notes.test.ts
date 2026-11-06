import { MemoryOdooCheckpointStore, OdooClient } from "@cc/odoo";
import { eventModels, FakeOdoo } from "@cc/odoo/testing";
import { type SendcloudParcel, ShippingService } from "@cc/sendcloud";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ShippingNotes } from "../src/shipping-notes";

/** Sendcloud "DD-MM-YYYY HH:MM:SS" in Amsterdam time. */
function scDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

const T0 = new Date("2026-11-03T09:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

/** Parcels as Sendcloud has them now; `updated_after` filters like the real API. */
let parcels: SendcloudParcel[] = [];
const queries: string[] = [];
const sendcloudFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const after = url.searchParams.get("updated_after");
  queries.push(after ?? "");
  const since = after ? Date.parse(after) : 0;
  const { parseSendcloudDate } = await import("@cc/sendcloud");
  return Response.json({ parcels: parcels.filter((p) => (parseSendcloudDate(p.date_updated)?.getTime() ?? 0) > since), next: null });
}) as typeof fetch;

const parcel = (id: number, statusId: number, message: string, updatedH: number, extra: Partial<SendcloudParcel> = {}): SendcloudParcel => ({
  id,
  name: "Jane Doe",
  carrier: { code: "royal_mail" },
  status: { id: statusId, message },
  date_created: scDate(at(-24)),
  date_updated: scDate(at(updatedH)),
  ...extra,
});

describe("Sendcloud tracking notes on Odoo delivery orders", () => {
  const odoo = new FakeOdoo({ models: eventModels() });
  let client: OdooClient;
  let store: MemoryOdooCheckpointStore;
  let now: Date;
  let odooNotes: boolean | undefined;
  const notes = (picking = 5) =>
    odoo.models["mail.message"]!.records.filter((m) => m.model === "stock.picking" && m.res_id === picking).map((m) => ({ body: String(m.body), note: (m.subtype_id as [number, string])[1] }));
  const make = () =>
    new ShippingNotes({
      shipping: () => new ShippingService([{ id: "dms-sc", vertical: "dms", publicKey: "p", secretKey: "s", odooNotes }], { fetch: sendcloudFetch, baseUrl: "https://sc.test/api/v2" }),
      odoo: () => client,
      store,
      timeZone: "Europe/London",
      now: () => now,
      logger: { info: () => {}, error: () => {} },
    });

  beforeAll(async () => {
    await odoo.start();
    client = new OdooClient({ url: odoo.url, db: odoo.db, username: odoo.login, apiKey: odoo.apiKey });
  });
  afterAll(() => odoo.stop());
  beforeEach(() => {
    store = new MemoryOdooCheckpointStore();
    odoo.models["mail.message"]!.records = odoo.models["mail.message"]!.records.filter((m) => m.model !== "stock.picking");
    odooNotes = undefined;
    queries.length = 0;
  });

  it("starts quietly, then notes each change on the delivery order found by tracking number", async () => {
    // Picking 5 is WH/OUT/00017, tracking RM123456785GB.
    parcels = [parcel(1, 3, "En route to sorting center", 0, { tracking_number: "RM123456785GB", tracking_url: "https://track.test/RM1", order_number: "S00042" })];
    now = at(1);
    const sync = make();
    expect(await sync.pollOnce()).toEqual([{ account: "dms-sc", posted: 0, failed: 0, baseline: true }]);
    expect(notes()).toEqual([]);

    // A sorting step inside "in transit" is not worth a note.
    parcels = [parcel(1, 7, "Being sorted", 2, { tracking_number: "RM123456785GB", tracking_url: "https://track.test/RM1", order_number: "S00042" })];
    now = at(3);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 0, failed: 0 });

    // A failed delivery attempt is.
    parcels = [parcel(1, 8, "Delivery attempt failed", 4, { tracking_number: "RM123456785GB", tracking_url: "https://track.test/RM1", order_number: "S00042" })];
    now = at(5);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 1 });
    // Re-read in the overlap window: no second note.
    now = at(5.1);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 0 });

    parcels = [parcel(1, 11, "Delivered", 26, { tracking_number: "RM123456785GB", tracking_url: "https://track.test/RM1", order_number: "S00042" })];
    now = at(27);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 1 });

    const posted = notes();
    expect(posted.map((n) => n.note)).toEqual(["Note", "Note"]); // internal notes only, never emailed
    expect(posted[0]!.body).toContain("⚠️ <b>Delivery problem</b>: Delivery attempt failed.");
    expect(posted[0]!.body).toContain('Tracking: <a href="https://track.test/RM1">RM123456785GB</a>');
    expect(posted[1]!.body).toContain("✅ <b>Delivered</b> Wed 4 Nov, 11:00, 2 days after the label was made (Royal Mail: “Delivered”).");
    // Each message_post was a note (mail.mt_note), with HTML allowed.
    expect(odoo.callsTo("message_post").every((c) => c.params.subtype_xmlid === "mail.mt_note" && c.params.body_is_html === true)).toBe(true);
  });

  it("finds the delivery order by order number, and notes a parcel that stops moving once", async () => {
    const picking = odoo.add("stock.picking", { name: "WH/OUT/00020", state: "done", picking_type_code: "outgoing", origin: "S00050", carrier_tracking_ref: false });
    parcels = [];
    now = at(0);
    const sync = make();
    await sync.pollOnce(); // baseline: nothing yet

    parcels = [parcel(2, 22, "Shipment picked up by driver", 1, { tracking_number: "DPD9", order_number: "S00050", carrier: { code: "dpd" } })];
    now = at(2);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 1 });
    expect(notes(picking)[0]!.body).toContain("🚚 <b>On its way</b>: DPD has the parcel (“Shipment picked up by driver”).");

    for (const day of [1, 2, 3, 4]) {
      now = at(1 + 24 * day);
      expect((await sync.pollOnce())[0]).toMatchObject({ posted: 0 });
    }
    now = at(1 + 24 * 5 + 1);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 1 });
    now = at(1 + 24 * 6);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 0 });
    expect(notes(picking).map((n) => n.body.slice(0, 60))).toEqual([expect.stringContaining("On its way"), expect.stringContaining("⏳ <b>No tracking update for 5 days</b>")]);
  });

  it("checks at 8am, midday and 5pm business time", async () => {
    const sync = make();
    sync.start();
    try {
      const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(sync.nextCheck()!);
      expect(["08:00", "12:00", "17:00"]).toContain(hour);
    } finally {
      await sync.stop();
    }
    expect(sync.nextCheck()).toBeNull();
  });

  it("retries a note Odoo refused, and does nothing when switched off or without Odoo", async () => {
    parcels = [];
    now = at(0);
    const sync = make();
    await sync.pollOnce();
    parcels = [parcel(3, 12, "Awaiting customer pickup", 1, { tracking_number: "RM123456785GB" })];
    now = at(2);
    odoo.legacyMessagePost = false;
    const saved = odoo.models["mail.message"];
    delete odoo.models["mail.message"]; // message_post fails
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 0, failed: 1 });
    odoo.models["mail.message"] = saved!;
    now = at(3);
    expect((await sync.pollOnce())[0]).toMatchObject({ posted: 1, failed: 0 });
    expect(notes()[0]!.body).toContain("📍 <b>Waiting at a pickup point</b>");

    odooNotes = false;
    const calls = queries.length;
    expect(await make().pollOnce()).toEqual([]);
    expect(queries.length).toBe(calls);
    odooNotes = undefined;
    expect(await new ShippingNotes({ shipping: () => null, odoo: () => client, store, timeZone: "Europe/London" }).pollOnce()).toEqual([]);
  });
});
