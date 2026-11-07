import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOdooExecutors, createOdooMcpServer, OdooClient } from "../src";
import { dailyModels, FakeOdoo } from "../src/testing";

let odoo: FakeOdoo;
let executors: ReturnType<typeof createOdooExecutors>;
let call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;

async function start() {
  odoo?.stop();
  odoo = new FakeOdoo({ models: dailyModels() });
  await odoo.start();
  const client = new OdooClient({ url: odoo.url, db: "testdb", username: "bot@example.com", apiKey: "test-api-key" });
  executors = createOdooExecutors(client);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createOdooMcpServer(client).connect(serverT);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientT);
  call = async (name, args = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
  };
}
afterAll(() => odoo.stop());

const run = (type: string, payload: Record<string, unknown>) => executors[type]!.execute(payload) as Promise<any>;
const prepare = (type: string, payload: Record<string, unknown>) => executors[type]!.prepare!(payload);
const record = (model: string, id: number) => odoo.models[model]!.records.find((r) => r.id === id)!;
const writes = () => odoo.calls.filter((c) => !["search_read", "read", "search_count", "fields_get", "search"].includes(c.method));

describe("odoo day-to-day reads", () => {
  beforeAll(start);

  it("never writes", async () => {
    for (const [name, args] of [
      ["search_invoices", {}], ["get_invoice", { id: 9 }], ["aged_balances", { as_of: "2026-11-07" }], ["search_payments", {}], ["search_deliveries", {}],
      ["get_delivery", { id: 5 }], ["stock_by_location", { sku: "SP-300W" }], ["search_purchase_orders", {}], ["get_purchase_order", { name: "P00070" }],
      ["product_suppliers", { product_id: 2 }], ["sales_summary", { date_from: "2026-10-01", date_to: "2026-10-31" }], ["search_leads", {}], ["search_tickets", {}],
      ["search_activities", {}], ["search_records", { model: "crm.stage", fields: ["name"] }],
    ] as const) {
      expect((await call(name, args)).isError, name).toBe(false);
    }
    expect(writes()).toEqual([]);
  });

  it("finds invoices by type, partner and overdue", async () => {
    expect((await call("search_invoices", { partner: "acme" })).json.map((i: any) => i.name)).toEqual(["INV/2026/00009"]);
    expect((await call("search_invoices", { overdue: true })).json.map((i: any) => i.name)).toEqual(["INV/2026/00009"]);
    expect((await call("search_invoices", { type: "vendor_bill" })).json.map((i: any) => i.name)).toEqual(["BILL/2026/00003"]);
    expect((await call("search_invoices", { state: "draft" })).json.map((i: any) => i.id)).toEqual([11]);
    const inv = (await call("get_invoice", { name: "inv/2026/00009" })).json;
    expect(inv).toMatchObject({ name: "INV/2026/00009", partner: { id: 11, name: "Acme Robotics" }, untaxed: 1250, tax: 250, outstanding: 1500 });
    expect(inv.lines).toEqual([{ id: 1, product: "[MILO-V2] Milo v2 CNC kit", description: "Milo v2 CNC kit", qty: 1, unit_price: 1250, discount: 0, subtotal: 1250, total: 1500 }]);
    expect((await call("get_invoice", { name: "NOPE" })).isError).toBe(true);
  });

  it("ages what customers owe and what we owe", async () => {
    const r = (await call("aged_balances", { as_of: "2026-11-07" })).json;
    expect(r.totals).toMatchObject({ total: 1600, overdue: 1500, over_90: 0, "61_90": 1500, not_due: 100 });
    expect(r.partners.map((p: any) => [p.partner.name, p.total])).toEqual([["Acme Robotics", 1500], ["Jane Doe", 100]]);
    expect(r.oldest_overdue[0]).toMatchObject({ name: "INV/2026/00009", days_overdue: 68, owed: 1500 });
    const payable = (await call("aged_balances", { kind: "payable", as_of: "2026-11-07" })).json;
    expect(payable.totals).toMatchObject({ total: 820, "1_30": 820 });
  });

  it("lists payments with what they paid", async () => {
    expect((await call("search_payments", { partner: 10 })).json).toEqual([
      { id: 1, name: "PBNK/2026/00001", date: "2026-10-20", partner: { id: 10, name: "Jane Doe" }, amount: 113.5, currency: "GBP", direction: "inbound", journal: "Bank", state: "paid", memo: "S00042", paid: ["INV/2026/00008"] },
    ]);
  });

  it("finds deliveries and receipts, with their moves", async () => {
    expect((await call("search_deliveries", { query: "S00042" })).json.map((d: any) => d.name)).toEqual(["WH/OUT/00017"]);
    expect((await call("search_deliveries", { type: "incoming", late: true })).json.map((d: any) => d.name)).toEqual(["WH/IN/00004"]);
    const d = (await call("get_delivery", { name: "WH/OUT/00017" })).json;
    expect(d).toMatchObject({ partner: { id: 10, name: "Jane Doe" }, from: "WH/Stock", to: "Partners/Customers", tracking_ref: "RM123456785GB", moves: [{ product: "[SP-300W] 300W spindle", demand: 1, done: 1 }] });
  });

  it("shows stock per internal location", async () => {
    expect((await call("stock_by_location", { sku: "sp-300w" })).json).toEqual({
      product: { id: 2, sku: "SP-300W", name: "300W spindle" },
      on_hand: 12,
      reserved: 1,
      locations: [
        { id: 1, location: "WH/Stock", quantity: 9, reserved: 1 },
        { id: 2, location: "WH/Stock/Shelf 2", quantity: 3, reserved: 0 },
      ],
    });
  });

  it("reads purchase orders and vendor prices", async () => {
    expect((await call("search_purchase_orders", { vendor: "spindle" })).json.map((p: any) => p.name)).toEqual(["P00070"]);
    const po = (await call("get_purchase_order", { id: 70 })).json;
    expect(po).toMatchObject({ vendor: { id: 30, name: "Spindle Supplies Ltd" }, receipt_status: "partial", lines: [{ qty: 10, received: 6, billed: 10 }], receipts: [{ name: "WH/IN/00004" }], bills: [{ name: "BILL/2026/00003" }] });
    expect((await call("product_suppliers", { product_id: 2 })).json).toEqual([
      { id: 1, vendor: { id: 30, name: "Spindle Supplies Ltd" }, vendor_code: "SS-300", vendor_name: null, price: 41, currency: "GBP", min_qty: 5, lead_days: 7, valid_from: null, valid_to: null },
    ]);
  });

  it("sums sales for a period", async () => {
    const r = (await call("sales_summary", { date_from: "2026-10-01", date_to: "2026-10-31" })).json;
    expect(r).toMatchObject({ orders: 1, total: 113.5, top_customers: [{ customer: { id: 10, name: "Jane Doe" }, orders: 1 }] });
    expect(r.top_products.map((p: any) => p.product.name)).toEqual(["[SP-300W] 300W spindle", "[ER11-7] ER11 collet set (7 pcs)"]);
  });

  it("finds leads, tickets and activities", async () => {
    expect((await call("search_leads", { query: "leeds" })).json[0]).toMatchObject({ title: "School makerspace: 6 Milo kits", stage: "Qualified", expected_revenue: 7500 });
    expect((await call("search_tickets", { partner: 10 })).json[0]).toMatchObject({ subject: "Spindle runs hot", stage: "New", description: "After 10 minutes it is too hot to touch." });
    expect((await call("search_activities", { when: "overdue" })).json.map((a: any) => a.summary)).toEqual(["Chase Acme on the Milo quote"]);
    expect((await call("search_activities", { model: "res.partner" })).json[0]).toMatchObject({ on: "res.partner,10", type: "To-Do", note: "PDF from the brain" });
  });

  it("reads any model, dropping unknown fields", async () => {
    const r = (await call("search_records", { model: "crm.stage", domain: [["is_won", "=", false]], fields: ["name", "nope"] })).json;
    expect(r).toEqual({ count: 3, records: [{ id: 1, name: "New" }, { id: 2, name: "Qualified" }, { id: 3, name: "Proposition" }], unknown_fields: ["nope"] });
    expect((await call("search_records", { model: "no.such", fields: ["name"] })).isError).toBe(true);
    expect((await call("search_records", { model: "Bad Model", fields: ["name"] })).isError).toBe(true);
  });
});

describe("odoo day-to-day writes", () => {
  beforeEach(start);

  it("confirms, changes and cancels orders", async () => {
    const changed = await run("odoo.quote.update", { id: 41, add_lines: [{ product_id: 3, qty: 1 }], validity_date: "2026-12-01" });
    expect(changed).toMatchObject({ name: "S00041", untaxed: 1250, total: 1500 });
    const line = (record("sale.order", 41).order_line as number[])[0]!;
    expect((await run("odoo.quote.update", { id: 41, update_lines: [{ line_id: line, qty: 2 }] })).untaxed).toBe(2500);
    await expect(run("odoo.quote.update", { id: 41, remove_line_ids: [1] })).rejects.toThrow(/Line 1 is not on S00041/);
    await expect(run("odoo.quote.update", { id: 41 })).rejects.toThrow(/nothing to change/);
    expect(await run("odoo.order.confirm", { id: 41 })).toEqual({ id: 41, name: "S00041", state: "sale" });
    await expect(run("odoo.order.confirm", { id: 41 })).rejects.toThrow(/S00041 is sale/);
    await expect(run("odoo.quote.update", { id: 41, note: "x" })).rejects.toThrow(/only a quotation/);
    expect(await run("odoo.order.cancel", { id: 41 })).toMatchObject({ state: "cancel", was: "sale" });
    expect(odoo.callsTo("action_cancel")[0]!.params.context).toEqual({ disable_cancel_warning: true });
  });

  it("shows the quote in the approval for confirm", async () => {
    const prepared = await prepare("odoo.order.confirm", { id: 42 });
    expect(prepared.note).toMatch(/Jane Doe/);
    await expect(prepare("odoo.order.confirm", { id: 999 })).rejects.toThrow(/No sales order/);
  });

  it("invoices an order, posts, sends and records payment", async () => {
    await run("odoo.order.confirm", { id: 41 });
    const created = await run("odoo.invoice.create", { order_id: 41 });
    expect(created).toMatchObject({ order: "S00041", invoices: [{ name: null, state: "draft", total: 1250 }] });
    const id = created.invoices[0].id;
    expect(odoo.callsTo("create").find((c) => c.model === "sale.advance.payment.inv")!.params.context).toEqual({ active_model: "sale.order", active_ids: [41], active_id: 41 });
    await expect(run("odoo.invoice.create", { order_id: 41 })).rejects.toThrow(/nothing to invoice/);
    await expect(run("odoo.invoice.send", { id })).rejects.toThrow(/post it before sending/);
    expect(await run("odoo.invoice.post", { id })).toMatchObject({ state: "posted", name: `INV/2026/${String(id).padStart(5, "0")}` });
    await expect(run("odoo.invoice.post", { id })).rejects.toThrow(/not a draft/);
    expect(await run("odoo.invoice.send", { id })).toMatchObject({ to: "Acme Robotics", sent: true });
    expect(odoo.models["mail.message"]!.records.some((m) => m.model === "account.move" && m.res_id === id)).toBe(true);
    expect(await run("odoo.invoice.register_payment", { id, amount: 250, date: "2026-11-07", memo: "BACS" })).toMatchObject({ paid: 250, payment_state: "partial", still_owed: 1000 });
    expect(await run("odoo.invoice.register_payment", { id })).toMatchObject({ payment_state: "paid", still_owed: 0 });
    await expect(run("odoo.invoice.register_payment", { id })).rejects.toThrow(/already paid/);
    expect((await prepare("odoo.invoice.register_payment", { id: 9 })).note).toBe("[INV/2026/00009 for Acme Robotics: posted, not_paid, total 1500.00, owed 1500.00.]");
  });

  it("buys: creates, sends, confirms and bills a purchase order", async () => {
    const po = await run("odoo.purchase.create", { partner_id: 30, lines: [{ product_id: 2, qty: 10 }], date_planned: "2026-11-20", send: true });
    expect(po).toMatchObject({ vendor: "Spindle Supplies Ltd", state: "sent", total: 492, sent: true });
    await expect(run("odoo.purchase.bill", { id: po.id })).rejects.toThrow(/confirm it first/);
    expect(await run("odoo.purchase.confirm", { id: po.id })).toMatchObject({ state: "purchase" });
    expect((await run("odoo.purchase.bill", { id: po.id })).bills).toMatchObject([{ state: "draft", total: 492 }]);
    await expect(run("odoo.purchase.create", { partner_id: 10, lines: [] })).rejects.toThrow(/lines/);
  });

  it("validates deliveries, with or without a backorder, and sets tracking", async () => {
    expect((await prepare("odoo.delivery.validate", { id: 6 })).note).toMatch(/WH\/IN\/00004 for Spindle Supplies Ltd \(P00070\), assigned: 6\/10 × \[SP-300W\]/);
    expect(await run("odoo.delivery.validate", { id: 5 })).toMatchObject({ name: "WH/OUT/00017", state: "done", backorders: 0 });
    await expect(run("odoo.delivery.validate", { id: 5 })).rejects.toThrow(/already done/);
    expect(await run("odoo.delivery.validate", { id: 6 })).toMatchObject({ state: "done", backorders: 1 });
    await start();
    expect(await run("odoo.delivery.validate", { id: 6, backorder: false })).toMatchObject({ state: "done", backorders: 0 });
    expect(await run("odoo.delivery.set_tracking", { id: 5, tracking_ref: "RM999" })).toEqual({ id: 5, name: "WH/OUT/00017", from: "RM123456785GB", to: "RM999" });
  });

  it("adjusts counted stock", async () => {
    expect(await run("odoo.stock.adjust", { product_id: 2, quantity: 7 })).toMatchObject({ location_id: 8, from: 9, to: 7 });
    expect(record("stock.quant", 1).quantity).toBe(7);
    expect(await run("odoo.stock.adjust", { product_id: 1, quantity: 4, location_id: 9 })).toMatchObject({ from: 0, to: 4 });
    expect(odoo.callsTo("action_apply_inventory")).toHaveLength(2);
    expect(odoo.callsTo("write").find((c) => c.model === "stock.quant")!.params.context).toEqual({ inventory_mode: true });
  });

  it("creates and updates products, flagging duplicates", async () => {
    expect((await prepare("odoo.product.create", { name: "ER11 collet set (7 pcs)", sku: "ER11-7", list_price: 20 })).note).toMatch(/Already in Odoo: \[ER11-7\]/);
    expect((await prepare("odoo.product.create", { name: "ER16 collet", sku: "ER16-1", list_price: 20 })).note).toMatch(/No product/);
    const p = await run("odoo.product.create", { name: "ER16 collet", sku: "ER16-1", list_price: 20, standard_price: 7, weight: 0.1 });
    expect(record("product.product", p.id)).toMatchObject({ default_code: "ER16-1", type: "consu", is_storable: true, list_price: 20 });
    const s = await run("odoo.product.create", { name: "Setup call", kind: "service", list_price: 60 });
    expect(record("product.product", s.id)).toMatchObject({ type: "service" });
    expect(await run("odoo.product.update", { id: 2, weight: 1.3, website_published: false })).toEqual({ id: 2, from: { weight: 1.2, is_published: true }, to: { weight: 1.3, is_published: false } });
    await expect(run("odoo.product.update", { id: 2 })).rejects.toThrow(/nothing to change/);
  });

  it("updates a contact", async () => {
    const r = await run("odoo.customer.update", { id: 10, city: "York", country_code: "fr", mobile: "+44 7700 900999" });
    expect(r.to).toEqual({ phone: "+44 7700 900999", city: "York", country_id: 75 });
    expect(record("res.partner", 10)).toMatchObject({ city: "York", country_id: 75 });
    expect((await prepare("odoo.customer.update", { id: 11, vat: "GB1" })).note).toBe("[Now: Acme Robotics <buy@acme.example>.]");
    await expect(run("odoo.customer.update", { id: 10, country_code: "ZZ" })).rejects.toThrow(/No country/);
  });

  it("schedules and completes activities", async () => {
    const a = await run("odoo.activity.schedule", { model: "sale.order", id: 42, summary: "Check spindle shipped", due: "2026-11-10", type: "call" });
    expect(record("mail.activity", a.activityId)).toMatchObject({ res_model_id: 101, res_id: 42, activity_type_id: 2, summary: "Check spindle shipped", date_deadline: "2026-11-10" });
    await expect(run("odoo.activity.schedule", { model: "sale.order", id: 999, summary: "x", due: "2026-11-10" })).rejects.toThrow(/No sale.order with id 999/);
    await expect(run("odoo.activity.schedule", { model: "no.model", id: 1, summary: "x", due: "2026-11-10" })).rejects.toThrow(/no no.model model/);
    expect(await run("odoo.activity.done", { id: 1, feedback: "Acme said next week" })).toMatchObject({ on: "sale.order,41", done: true });
    expect(odoo.models["mail.activity"]!.records.find((x) => x.id === 1)).toBeUndefined();
    await expect(run("odoo.activity.done", { id: 999 })).rejects.toThrow(/No activity/);
  });

  it("creates and moves leads, and updates tickets", async () => {
    const lead = await run("odoo.lead.create", { name: "Milo for a dentist lab", email: "lab@teeth.example", expected_revenue: 1250 });
    expect(record("crm.lead", lead.id)).toMatchObject({ type: "opportunity", email_from: "lab@teeth.example" });
    await run("odoo.lead.update", { id: 1, stage: "propos", expected_revenue: 9000 });
    expect(record("crm.lead", 1)).toMatchObject({ stage_id: 3, expected_revenue: 9000 });
    await expect(run("odoo.lead.update", { id: 1, stage: "Nowhere" })).rejects.toThrow(/Choose one of: New, Qualified, Proposition, Won/);
    expect(await run("odoo.lead.update", { id: 1, outcome: "won" })).toMatchObject({ stage: "Won", outcome: "won" });
    await run("odoo.lead.update", { id: lead.id, outcome: "lost", lost_reason: "too expensive" });
    expect(record("crm.lead", lead.id)).toMatchObject({ active: false, lost_reason_id: [1, "Too expensive"] });
    expect(await run("odoo.ticket.update", { id: 1, stage: "Solved", priority: "2" })).toMatchObject({ priority: "2" });
    expect(record("helpdesk.ticket", 1)).toMatchObject({ stage_id: 3, priority: "2" });
  });

  it("refuses bad payloads before touching Odoo", async () => {
    for (const [type, payload] of [
      ["odoo.order.confirm", { id: -1 }],
      ["odoo.invoice.register_payment", { id: 9, amount: 0 }],
      ["odoo.stock.adjust", { product_id: 2, quantity: -1 }],
      ["odoo.activity.schedule", { model: "Sale Order", id: 1, summary: "x", due: "2026-11-10" }],
      ["odoo.activity.schedule", { model: "sale.order", id: 1, summary: "x", due: "tomorrow" }],
      ["odoo.lead.create", { name: "No way to reach them" }],
      ["odoo.lead.update", { id: 1, lost_reason: "x" }],
      ["odoo.ticket.update", { id: 1 }],
    ] as const) {
      await expect(run(type, payload), type).rejects.toThrow(/Invalid payload/);
    }
    expect(writes()).toEqual([]);
  });
});
