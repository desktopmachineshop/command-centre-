import type { NewEvent } from "@cc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatOdooDate,
  MemoryOdooCheckpointStore,
  OdooClient,
  OdooEventPoller,
  type OdooEventsConfig,
  type OdooEventSourceId,
  parseOdooEventsConfig,
  verticalForWebsite,
} from "../src";
import { demoModels, eventModels, FakeOdoo, type FakeModel } from "../src/testing";

const T0 = new Date("2026-10-23T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const odooAt = (minutes: number) => formatOdooDate(at(minutes));

describe("parseOdooEventsConfig", () => {
  it("defaults to every source, and can be switched off", () => {
    expect(parseOdooEventsConfig(undefined)).toMatchObject({
      sources: ["orders", "messages", "tickets", "stock", "deliveries", "reviews", "leads", "purchases"],
      pollIntervalMs: 300_000,
      lowStockThreshold: 3,
      defaultVertical: "dms",
      lateAfterHours: 24,
      messageTypes: ["comment"],
    });
    expect(parseOdooEventsConfig("on")?.sources).toHaveLength(8);
    for (const off of ["off", "false", "0", "none"]) expect(parseOdooEventsConfig(off)).toBeNull();
  });

  it("takes a comma list of sources or a JSON object", () => {
    expect(parseOdooEventsConfig("orders, stock")?.sources).toEqual(["orders", "stock"]);
    const c = parseOdooEventsConfig('{"sources":["orders"],"pollSeconds":60,"lowStockThreshold":5,"websites":{"2":"3dpandme"},"bigOrderThreshold":500}');
    expect(c).toMatchObject({ sources: ["orders"], pollIntervalMs: 60_000, lowStockThreshold: 5, websites: { "2": "3dpandme" }, bigOrderThreshold: 500 });
  });

  it("rejects unknown sources, options and bad JSON with a clear message", () => {
    expect(() => parseOdooEventsConfig("orders,invoices")).toThrow(/ODOO_EVENTS: sources/);
    expect(() => parseOdooEventsConfig('{"pollSecs":60}')).toThrow(/ODOO_EVENTS/);
    expect(() => parseOdooEventsConfig('{"pollSeconds":5}')).toThrow(/pollSeconds/);
    expect(() => parseOdooEventsConfig("{oops")).toThrow(/not valid JSON/);
  });

  it("maps websites to verticals by id, then name, else the default", () => {
    const c = { websites: { "1": "dms", "3DPandMe": "3dpandme" }, defaultVertical: "dms" };
    expect(verticalForWebsite(c, [1, "Desktop Machine Shop"])).toBe("dms");
    expect(verticalForWebsite(c, [2, "3dpandme"])).toBe("3dpandme");
    expect(verticalForWebsite(c, [9, "Other"])).toBe("dms");
    expect(verticalForWebsite(c, false)).toBe("dms");
  });
});

describe("OdooEventPoller", () => {
  let odoo: FakeOdoo;
  let now: Date;
  let events: NewEvent[];
  let logs: string[];
  let store: MemoryOdooCheckpointStore;
  let failIngest = false;

  const make = (sources: OdooEventSourceId[], options: Partial<OdooEventsConfig> = {}) => {
    const config = { ...parseOdooEventsConfig(sources.join(","))!, websites: { "2": "3dpandme" }, ...options };
    const client = new OdooClient({ url: odoo.url, db: odoo.db, username: odoo.login, apiKey: odoo.apiKey });
    return new OdooEventPoller({
      client,
      store,
      config,
      instance: odoo.db,
      baseUrl: "https://shop.example.com",
      now: () => now,
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) },
      ingest: async (e) => {
        if (failIngest) throw new Error("db down");
        events.push(e);
      },
    });
  };

  const start = async (models: Record<string, FakeModel> = eventModels()) => {
    odoo = new FakeOdoo({ models });
    await odoo.start();
  };

  beforeEach(() => {
    now = T0;
    events = [];
    logs = [];
    store = new MemoryOdooCheckpointStore();
    failIngest = false;
  });
  afterEach(async () => odoo?.stop());

  describe("orders", () => {
    beforeEach(() => start());

    const newOrder = (minutes: number, extra: Record<string, unknown> = {}) =>
      odoo.add("sale.order", {
        name: `S0${100 + Math.round(minutes)}`,
        partner_id: [10, "Jane Doe"],
        date_order: odooAt(minutes),
        state: "sale",
        amount_total: 84.5,
        amount_untaxed: 70.42,
        currency_id: [1, "GBP"],
        order_line: [1, 2],
        carrier_id: [2, "Royal Mail Tracked 48"],
        website_id: [1, "Desktop Machine Shop"],
        note: "<p>Please leave by the back door</p>",
        ...extra,
      });

    it("starts from now on the first run, without replaying existing orders", async () => {
      const poller = make(["orders"]);
      expect(await poller.pollOnce("orders")).toBe(0);
      expect(events).toEqual([]);
      expect(await store.getOdooCheckpoint("testdb:orders")).toMatchObject({ cursor: "2026-10-23 10:00:00" });
      expect(logs).toContain("orders: first run, starting from now (no backlog)");
    });

    it("emits each new confirmed order once, with the order details", async () => {
      const poller = make(["orders"]);
      await poller.pollOnce("orders");
      const id = newOrder(1);
      odoo.add("sale.order", { name: "S00199", partner_id: [10, "Jane Doe"], date_order: odooAt(1), state: "draft", amount_total: 5, currency_id: [1, "GBP"] });
      now = at(2);
      expect(await poller.pollOnce("orders")).toBe(1);
      expect(events[0]).toMatchObject({
        source: "odoo",
        vertical: "dms",
        kind: "order.created",
        title: "New order S0101 from Jane Doe: £84.50",
        dedupeKey: `odoo:sale.order:${id}:order.created`,
        payload: {
          model: "sale.order",
          id,
          name: "S0101",
          amount: 84.5,
          currency: "GBP",
          customer: { id: 10, name: "Jane Doe", email: "jane@example.com", city: "Leeds", country: "United Kingdom" },
          linesSummary: "1 × ER11 collet set (7 pcs), 1 × 300W spindle",
          lines: [{ product: "ER11 collet set (7 pcs)", sku: "ER11-7", qty: 1, subtotal: 24.5 }, expect.objectContaining({ sku: "SP-300W" })],
          deliveryMethod: "Royal Mail Tracked 48",
          website: "Desktop Machine Shop",
          notes: "Please leave by the back door",
          attention: [],
          link: `https://shop.example.com/web#id=${id}&model=sale.order&view_type=form`,
        },
      });

      // Polling again (or after a restart, from the stored checkpoint) does not repeat it.
      now = at(3);
      expect(await poller.pollOnce("orders")).toBe(0);
      expect(await make(["orders"]).pollOnce("orders")).toBe(0);
      expect(events).toHaveLength(1);
    });

    it("emits a quotation when it is confirmed, and maps its website to a vertical", async () => {
      const poller = make(["orders"]);
      await poller.pollOnce("orders");
      const id = newOrder(1, { state: "draft", website_id: [2, "3dpandme"] });
      now = at(2);
      expect(await poller.pollOnce("orders")).toBe(0);
      // Confirmation stamps date_order with the confirmation time.
      odoo.update("sale.order", id, { state: "sale", date_order: odooAt(30) });
      now = at(31);
      expect(await poller.pollOnce("orders")).toBe(1);
      expect(events[0]).toMatchObject({ vertical: "3dpandme", payload: { website: "3dpandme" } });
    });

    it("catches an order committed late with a date just before the cursor", async () => {
      const poller = make(["orders"]);
      await poller.pollOnce("orders");
      newOrder(5);
      now = at(6);
      await poller.pollOnce("orders");
      // A slow transaction stamped at minute 4 commits only now.
      newOrder(4);
      now = at(7);
      expect(await poller.pollOnce("orders")).toBe(1);
      expect(events.map((e) => e.payload!.name)).toEqual(["S0105", "S0104"]);
    });

    it("flags orders at or above bigOrderThreshold", async () => {
      const poller = make(["orders"], { bigOrderThreshold: 500 });
      await poller.pollOnce("orders");
      newOrder(1, { amount_total: 1250 });
      newOrder(2, { amount_total: 499 });
      now = at(3);
      await poller.pollOnce("orders");
      expect(events.map((e) => (e.payload!.attention as string[]).length)).toEqual([1, 0]);
      expect(events[0]!.payload!.attention).toEqual(["large order (1250.00 ≥ 500 threshold)"]);
    });

    it("keeps the checkpoint when an ingest fails, so the order comes back", async () => {
      const poller = make(["orders"]);
      await poller.pollOnce("orders");
      newOrder(1);
      now = at(2);
      failIngest = true;
      await expect(poller.pollOnce("orders")).rejects.toThrow(/db down/);
      failIngest = false;
      expect(await poller.pollOnce("orders")).toBe(1);
    });
  });

  describe("messages and tickets", () => {
    beforeEach(() => start());

    const message = (minutes: number, extra: Record<string, unknown>) =>
      odoo.add("mail.message", {
        model: "sale.order",
        res_id: 42,
        record_name: "S00042",
        create_date: odooAt(minutes),
        date: odooAt(minutes),
        message_type: "comment",
        is_internal: false,
        body: "<p>Can I add a second collet set?</p>",
        ...extra,
      });

    it("emits customer comments only: not staff, notes, notifications or other records", async () => {
      const poller = make(["messages"]);
      await poller.pollOnce("messages");
      const jane = message(1, { author_id: [10, "Jane Doe"] });
      message(1, { author_id: [3, "Dave"], body: "<p>staff reply</p>" });
      message(1, { author_id: [2, "OdooBot"], body: "<p>bot</p>" });
      message(1, { author_id: [10, "Jane Doe"], is_internal: true });
      message(1, { author_id: [10, "Jane Doe"], message_type: "notification" });
      message(1, { author_id: [10, "Jane Doe"], model: "blog.post", res_id: 1 });
      const visitor = message(2, { author_id: false, email_from: "Sam <sam@example.org>", model: "res.partner", res_id: 11, record_name: "Acme Robotics" });
      now = at(3);
      expect(await poller.pollOnce("messages")).toBe(2);
      expect(events.map((e) => e.dedupeKey)).toEqual([`odoo:mail.message:${jane}:message.received`, `odoo:mail.message:${visitor}:message.received`]);
      expect(events[0]).toMatchObject({
        vertical: "dms",
        kind: "message.received",
        title: "New message from Jane Doe on S00042",
        payload: { model: "sale.order", resId: 42, messageId: jane, author: "Jane Doe", email: "jane@example.com", body: "Can I add a second collet set?", website: "Desktop Machine Shop" },
      });
      expect(events[1]!.payload).toMatchObject({ author: "Sam <sam@example.org>", model: "res.partner", resId: 11 });
      now = at(4);
      expect(await poller.pollOnce("messages")).toBe(0);
    });

    it("emits new helpdesk tickets as message.received", async () => {
      const poller = make(["tickets"]);
      odoo.add("helpdesk.ticket", { name: "Old ticket", create_date: odooAt(-60), partner_id: [10, "Jane Doe"] });
      await poller.pollOnce("tickets");
      const id = odoo.add("helpdesk.ticket", {
        name: "Spindle makes a grinding noise",
        ticket_ref: "17",
        partner_id: false,
        partner_name: "Bob Smith",
        partner_email: "bob@example.net",
        description: "<p>Since yesterday</p>",
        team_id: [1, "Customer Care"],
        priority: "2",
        create_date: odooAt(1),
      });
      now = at(2);
      expect(await poller.pollOnce("tickets")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "message.received",
        title: "New helpdesk ticket from Bob Smith: Spindle makes a grinding noise",
        dedupeKey: `odoo:helpdesk.ticket:${id}:message.received`,
        payload: { model: "helpdesk.ticket", resId: id, email: "bob@example.net", body: "Since yesterday", ticket: { ref: "17", team: "Customer Care", priority: "2" } },
      });
    });
  });

  describe("missing modules", () => {
    it("disables a source whose app is missing, logging once, and keeps the others running", async () => {
      await start(demoModels()); // no helpdesk.ticket or rating.rating, no create_date on mail.message
      const poller = make(["tickets", "reviews", "orders"]);
      await poller.pollAll();
      await poller.pollAll();
      expect(poller.disabledSources()).toEqual({
        tickets: "Odoo has no helpdesk.ticket model (is the Helpdesk app installed?)",
        reviews: "Odoo has no rating.rating model (is the Rating module installed?)",
      });
      expect(logs.filter((l) => l.includes("disabled"))).toHaveLength(2);
      const id = odoo.add("sale.order", { name: "S00300", partner_id: [11, "Acme Robotics"], date_order: odooAt(1), state: "sale", amount_total: 10, currency_id: [1, "GBP"] });
      now = at(2);
      expect(await poller.pollOnce("orders")).toBe(1);
      expect(events[0]!.dedupeKey).toBe(`odoo:sale.order:${id}:order.created`);
    });

    it("disables a source when a field it needs is missing", async () => {
      const models = eventModels();
      models["sale.order"] = { ...models["sale.order"]!, fields: models["sale.order"]!.fields.filter((f) => f !== "date_order") };
      await start(models);
      const poller = make(["orders"]);
      expect(await poller.pollOnce("orders")).toBe(0);
      expect(poller.disabledSources()).toEqual({ orders: "sale.order has no date_order field" });
    });
  });

  describe("low stock", () => {
    beforeEach(() => start());

    it("emits once per crossing below the threshold, not every poll", async () => {
      const poller = make(["stock"]);
      // ER11 has 3 (not below 3); Milo has 0 already: that is the starting state, not news.
      await poller.pollOnce("stock");
      expect(events).toEqual([]);

      odoo.update("product.product", 1, { qty_available: 1 });
      expect(await poller.pollOnce("stock")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "stock.low",
        vertical: "dms",
        title: "Low stock: ER11 collet set (7 pcs) (ER11-7), 1 on hand (below 3)",
        dedupeKey: "odoo:product.product:1:stock.low",
        payload: { id: 1, templateId: 11, sku: "ER11-7", qtyAvailable: 1, threshold: 3, thresholdSource: "config", crossing: 1 },
      });
      expect(await poller.pollOnce("stock")).toBe(0);
      odoo.update("product.product", 1, { qty_available: 0 });
      expect(await poller.pollOnce("stock")).toBe(0);

      // Restocked, then low again: a second crossing with its own key.
      odoo.update("product.product", 1, { qty_available: 20 });
      expect(await poller.pollOnce("stock")).toBe(0);
      odoo.update("product.product", 1, { qty_available: 2 });
      expect(await poller.pollOnce("stock")).toBe(1);
      expect(events[1]!.dedupeKey).toBe("odoo:product.product:1:stock.low#2");
      // Services are never "low".
      expect(events.some((e) => e.payload!.id === 4)).toBe(false);
      // The checkpoint keeps everything low right now, for the digest's buying list.
      const current = (await store.getOdooCheckpoint(`${odoo.db}:stock`))!.state.current as { id: number; qtyAvailable: number }[];
      expect(current.map((c) => [c.id, c.qtyAvailable])).toEqual([[1, 2], [3, 0]]);
    });

    it("uses a reordering rule's min qty as the product's threshold", async () => {
      const poller = make(["stock"]);
      await poller.pollOnce("stock");
      odoo.add("stock.warehouse.orderpoint", { product_id: [2, "[SP-300W] 300W spindle"], product_min_qty: 15, product_max_qty: 30 });
      expect(await poller.pollOnce("stock")).toBe(1);
      expect(events[0]!.payload).toMatchObject({ id: 2, qtyAvailable: 12, threshold: 15, thresholdSource: "reorder-rule" });
    });
  });

  describe("late deliveries", () => {
    beforeEach(() => start());

    it("emits a delivery once when it passes its scheduled date plus the grace period", async () => {
      const poller = make(["deliveries"]);
      await poller.pollOnce("deliveries");
      now = new Date("2026-10-25T08:00:00Z"); // 23h after the 09:00 schedule: within the 24h grace
      expect(await poller.pollOnce("deliveries")).toBe(0);
      now = new Date("2026-10-25T10:00:00Z");
      expect(await poller.pollOnce("deliveries")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "delivery.late",
        vertical: "dms",
        title: "Late delivery WH/OUT/00017 for S00042 (Jane Doe): due 2026-10-24",
        dedupeKey: "odoo:stock.picking:5:delivery.late",
        payload: { name: "WH/OUT/00017", hoursLate: 25, carrier: "Royal Mail Tracked 48", trackingRef: "RM123456785GB", order: { id: 42, name: "S00042" }, customer: { name: "Jane Doe", email: "jane@example.com" } },
      });
      now = new Date("2026-10-26T10:00:00Z");
      expect(await poller.pollOnce("deliveries")).toBe(0);
      expect((await store.getOdooCheckpoint(`${odoo.db}:deliveries`))!.state.current).toEqual([
        { id: 5, name: "WH/OUT/00017", state: "assigned", scheduledDate: "2026-10-24 09:00:00", order: "S00042", customer: "Jane Doe", vertical: "dms" },
      ]);
      // Done pickings and receipts are never late.
      odoo.add("stock.picking", { name: "WH/IN/00003", state: "assigned", picking_type_code: "incoming", scheduled_date: "2026-10-20 09:00:00" });
      expect(await poller.pollOnce("deliveries")).toBe(0);
    });

    it("does not report deliveries that were already late on the first run", async () => {
      now = new Date("2026-11-01T10:00:00Z");
      const poller = make(["deliveries"]);
      expect(await poller.pollOnce("deliveries")).toBe(0);
      expect(await poller.pollOnce("deliveries")).toBe(0);
    });
  });

  describe("reviews", () => {
    beforeEach(() => start());

    it("emits a rating once the customer has submitted it", async () => {
      const poller = make(["reviews"]);
      await poller.pollOnce("reviews");
      const id = odoo.add("rating.rating", { rating: 0, consumed: false, res_model: "product.template", res_id: 12, res_name: "300W spindle", partner_id: [10, "Jane Doe"], create_date: odooAt(1), write_date: odooAt(1) });
      now = at(2);
      expect(await poller.pollOnce("reviews")).toBe(0);
      odoo.update("rating.rating", id, { rating: 5, consumed: true, feedback: "Runs quiet, great value", write_date: odooAt(10) });
      now = at(11);
      expect(await poller.pollOnce("reviews")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "review.received",
        vertical: "dms",
        title: "New review 5/5 from Jane Doe on 300W spindle",
        dedupeKey: `odoo:rating.rating:${id}:review.received`,
        payload: { rating: 5, feedback: "Runs quiet, great value", resModel: "product.template", resId: 12, website: "Desktop Machine Shop", replied: false },
      });
      now = at(12);
      expect(await poller.pollOnce("reviews")).toBe(0);
    });
  });

  describe("leads (incoming RFQs)", () => {
    beforeEach(() => start());

    const lead = (minutes: number, extra: Record<string, unknown> = {}) =>
      odoo.add("crm.lead", {
        name: "Quote for 20 ER11 collet sets",
        type: "lead",
        contact_name: "Sam Lee",
        partner_name: "Lee Engineering",
        email_from: "sam@lee.example",
        phone: "01234 567890",
        description: "<p>Please quote 20 sets, delivered to Leeds.</p>",
        create_uid: [1, "OdooBot"],
        create_date: odooAt(minutes),
        ...extra,
      });

    it("emits leads from the website or mail gateway, not ones staff typed in", async () => {
      const poller = make(["leads"]);
      lead(-5); // already there on the first run: not news
      await poller.pollOnce("leads");
      expect(events).toEqual([]);

      const id = lead(1);
      lead(2, { name: "Dave's own note", create_uid: [7, "Command Centre"] });
      now = at(3);
      expect(await poller.pollOnce("leads")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "rfq.received",
        vertical: "dms",
        title: "New RFQ from Lee Engineering: Quote for 20 ER11 collet sets",
        dedupeKey: `odoo:crm.lead:${id}:rfq.received`,
        payload: { customer: { name: "Sam Lee", email: "sam@lee.example" }, phone: "01234 567890", body: "Please quote 20 sets, delivered to Leeds." },
      });
      expect(events[0]!.payload!.summary).toBe(
        `Sam Lee <sam@lee.example> 01234 567890\nPlease quote 20 sets, delivered to Leeds.\nhttps://shop.example.com/web#id=${id}&model=crm.lead&view_type=form`,
      );
      now = at(4);
      expect(await poller.pollOnce("leads")).toBe(0);
    });
  });

  describe("purchases (supplier replies)", () => {
    beforeEach(() => start());

    const reply = (minutes: number, extra: Record<string, unknown> = {}) =>
      odoo.add("mail.message", {
        model: "purchase.order",
        res_id: 70,
        record_name: "P00070",
        create_date: odooAt(minutes),
        date: odooAt(minutes),
        message_type: "email",
        is_internal: false,
        author_id: [30, "Spindle Supplies Ltd"],
        subject: "Re: RFQ P00070",
        body: "<p>Confirmed, 20 units shipping 5 Nov.</p>",
        ...extra,
      });

    it("emits suppliers' replies on RFQs and POs, not Dave's own messages or notes", async () => {
      const poller = make(["purchases"]);
      await poller.pollOnce("purchases");
      const id = reply(1);
      reply(2, { author_id: [3, "Dave"], body: "<p>Please confirm.</p>" });
      reply(3, { is_internal: true, author_id: [30, "Spindle Supplies Ltd"], body: "<p>note</p>" });
      reply(4, { model: "sale.order", res_id: 42 });
      now = at(5);
      expect(await poller.pollOnce("purchases")).toBe(1);
      expect(events[0]).toMatchObject({
        kind: "purchase.reply",
        vertical: "dms",
        title: "Spindle Supplies Ltd replied on RFQ P00070: Re: RFQ P00070",
        dedupeKey: `odoo:mail.message:${id}:purchase.reply`,
        payload: { recordName: "P00070", orderState: "sent", supplier: "Spindle Supplies Ltd", amount: 820, body: "Confirmed, 20 units shipping 5 Nov." },
      });
      expect(events[0]!.payload!.summary).toContain("P00070 (RFQ, £820.00)\nConfirmed, 20 units shipping 5 Nov.");

      odoo.update("purchase.order", 70, { state: "purchase" });
      reply(6, { subject: false });
      now = at(7);
      expect(await poller.pollOnce("purchases")).toBe(1);
      expect(events[1]!.title).toBe("Spindle Supplies Ltd replied on PO P00070");
    });
  });

  it("runs every source in the background between start and stop", async () => {
    await start();
    const poller = make(["orders", "stock"], { pollIntervalMs: 50 });
    poller.start();
    await until(async () => (await store.getOdooCheckpoint("testdb:stock")) !== null && (await store.getOdooCheckpoint("testdb:orders")) !== null);
    odoo.update("product.product", 2, { qty_available: 1 });
    await until(async () => events.length === 1);
    await poller.stop();
    expect(events[0]!.kind).toBe("stock.low");
  });
});

async function until(check: () => Promise<boolean>, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
