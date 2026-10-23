import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOdooMcpServer, htmlToText, OdooClient } from "../src";
import { demoModels, type FakeModel, FakeOdoo } from "../src/testing";

async function connect(models: Record<string, FakeModel>) {
  const odoo = new FakeOdoo({ models });
  await odoo.start();
  const odooClient = new OdooClient({ url: odoo.url, db: "testdb", username: "bot@example.com", apiKey: "test-api-key" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createOdooMcpServer(odooClient).connect(serverT);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
  };
  return { odoo, mcp, call };
}

describe("odoo MCP server", () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    ctx = await connect(demoModels());
  });
  afterAll(() => ctx.odoo.stop());

  it("exposes only read tools", async () => {
    const tools = (await ctx.mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "get_customer_history", "get_order", "get_product", "get_record_messages", "list_websites", "low_stock",
      "search_blog_posts", "search_customers", "search_orders", "search_products",
    ]);
    const methods = new Set(ctx.odoo.calls.map((c) => c.method));
    for (const write of ["create", "write", "unlink", "message_post"]) expect(methods.has(write)).toBe(false);
  });

  it("searches products by name, SKU or barcode", async () => {
    const { json } = await ctx.call("search_products", { query: "spindle" });
    expect(json).toEqual([
      {
        id: 2, sku: "SP-300W", name: "300W spindle", list_price: 89, standard_price: 41, qty_available: 12, virtual_available: 10,
        weight: 1.2, category: "All / Spindles", website_published: true, barcode: "5060000000012", template_id: 12,
      },
    ]);
    expect((await ctx.call("search_products", { query: "5060000000012" })).json[0].sku).toBe("SP-300W");
  });

  it("gets a product by SKU with taxes", async () => {
    const { json } = await ctx.call("get_product", { sku: "er11-7" });
    expect(json).toMatchObject({ id: 1, sku: "ER11-7", description: "Fits 300W spindles.", storable: true, taxes: [{ name: "20% S", amount: 20, price_include: "tax_included" }] });
    expect((await ctx.call("get_product", { sku: "NOPE" })).isError).toBe(true);
  });

  it("searches orders by customer, state and date", async () => {
    expect((await ctx.call("search_orders", { partner: "jane" })).json.map((o: any) => o.name)).toEqual(["S00042"]);
    expect((await ctx.call("search_orders", { partner: 10 })).json).toHaveLength(1);
    expect((await ctx.call("search_orders", { state: "draft" })).json.map((o: any) => o.name)).toEqual(["S00041"]);
    expect((await ctx.call("search_orders", { date_from: "2026-10-01" })).json.map((o: any) => o.name)).toEqual(["S00042"]);
    expect((await ctx.call("search_orders", {})).json.map((o: any) => o.name)).toEqual(["S00042", "S00041"]);
  });

  it("gets an order with lines, delivery tracking, invoices and chatter", async () => {
    const { json } = await ctx.call("get_order", { name: "s00042" });
    expect(json).toMatchObject({ name: "S00042", customer: { id: 10, name: "Jane Doe" }, delivery_status: "partial", invoice_status: "invoiced" });
    expect(json.lines).toEqual([
      { id: 1, product: "[ER11-7] ER11 collet set (7 pcs)", description: "ER11 collet set (7 pcs)", qty: 1, delivered: 1, invoiced: 1, unit_price: 24.5, discount: 0, subtotal: 24.5 },
      { id: 2, product: "[SP-300W] 300W spindle", description: "300W spindle", qty: 1, delivered: 0, invoiced: 1, unit_price: 89, discount: 0, subtotal: 89 },
    ]);
    expect(json.deliveries).toEqual([
      { id: 5, name: "WH/OUT/00017", type: "outgoing", state: "assigned", scheduled: "2026-10-24 09:00:00", done: null, carrier: "Royal Mail Tracked 48", tracking_ref: "RM123456785GB" },
    ]);
    expect(json.invoices[0]).toMatchObject({ name: "INV/2026/00008", payment_state: "paid", outstanding: 0 });
    // Tracking notifications are left out; HTML is flattened.
    expect(json.messages).toEqual([
      { id: 100, date: "2026-10-21 08:00:00", author: "Jane Doe", type: "email", subtype: "Discussions", subject: "Where is my spindle?", body: "Hi, when will the spindle ship?", on: "sale.order,42" },
    ]);
  });

  it("finds customers and their history", async () => {
    const found = (await ctx.call("search_customers", { query: "jane@" })).json;
    expect(found).toEqual([{ id: 10, name: "Jane Doe", email: "jane@example.com", phone: "+44 7700 900123", city: "Leeds", country: "United Kingdom", ref: null }]);
    const history = (await ctx.call("get_customer_history", { partner_id: 10 })).json;
    expect(history.order_count).toBe(1);
    expect(history.orders.map((o: any) => o.name)).toEqual(["S00042"]);
    expect(history.invoices.map((i: any) => i.name)).toEqual(["INV/2026/00008"]);
    expect(history.messages.map((m: any) => m.id)).toEqual([100, 102]);
  });

  it("reads chatter on any record", async () => {
    expect((await ctx.call("get_record_messages", { model: "sale.order", id: 42 })).json.map((m: any) => m.id)).toEqual([100]);
    const all = await ctx.call("get_record_messages", { model: "sale.order", id: 42, include_notifications: true });
    expect(all.json.map((m: any) => m.id)).toEqual([100, 101]);
  });

  it("lists websites with blogs and searches posts per website", async () => {
    expect((await ctx.call("list_websites")).json).toEqual([
      { id: 1, name: "Desktop Machine Shop", domain: "https://desktopmachineshop.com", blogs: [{ id: 1, name: "DMS News" }] },
      { id: 2, name: "3dpandme", domain: "https://3dpandme.com", blogs: [{ id: 2, name: "3dpandme Blog" }] },
    ]);
    const posts = (await ctx.call("search_blog_posts", { website: "3dpandme" })).json;
    expect(posts).toEqual([
      { id: 1, title: "Tramming your spindle", subtitle: "A 10-minute fix", blog: { id: 2, name: "3dpandme Blog" }, website: "3dpandme", published: true, date: "2026-10-01 09:00:00", url: "/blog/3dpandme-blog-2/tramming-1", author: "Dave" },
    ]);
    expect((await ctx.call("search_blog_posts", { website: 1, published: false })).json.map((p: any) => p.id)).toEqual([2]);
    expect((await ctx.call("search_blog_posts", { query: "milo" })).json.map((p: any) => p.id)).toEqual([2]);
  });

  it("reports low stock for storable products only, lowest first", async () => {
    const { json } = await ctx.call("low_stock", { threshold: 5 });
    expect(json).toEqual([
      { id: 3, sku: "MILO-V2", name: "Milo v2 CNC kit", qty_available: 0, virtual_available: 4, incoming_qty: 4 },
      { id: 1, sku: "ER11-7", name: "ER11 collet set (7 pcs)", qty_available: 3, virtual_available: 1, incoming_qty: 0 },
    ]);
  });
});

describe("odoo MCP server on a sparse Odoo", () => {
  it("degrades when fields and apps are missing", async () => {
    const full = demoModels();
    // An older/smaller instance: no Blog, Sales or Inventory apps, and products without stock or website fields.
    const ctx = await connect({
      "product.product": { fields: ["default_code", "name", "list_price", "type", "categ_id"], records: [{ id: 1, default_code: "A1", name: "Widget", list_price: 5, type: "product", categ_id: [1, "All"] }] },
      "res.partner": full["res.partner"]!,
      "mail.message": full["mail.message"]!,
      website: full.website!,
    });
    try {
      expect((await ctx.call("search_products", { query: "a1" })).json).toEqual([{ id: 1, sku: "A1", name: "Widget", list_price: 5, category: "All", barcode: null }]);
      const orders = await ctx.call("search_orders", { query: "S1" });
      expect(orders).toMatchObject({ isError: true, text: expect.stringContaining("Sales app") });
      expect((await ctx.call("search_blog_posts", {})).text).toContain("Blog app");
      expect((await ctx.call("low_stock", {})).text).toContain("Inventory");
      const history = (await ctx.call("get_customer_history", { partner_id: 10 })).json;
      expect(history).toMatchObject({ order_count: null, orders: [], invoices: [] });
      expect((await ctx.call("list_websites")).json[0].blogs).toEqual([]);
    } finally {
      await ctx.odoo.stop();
    }
  });
});

describe("htmlToText", () => {
  it("flattens and truncates", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>there</b></p><p>Line &amp; two</p>", 100)).toBe("Hello there\nLine & two");
    expect(htmlToText("<p>abcdef</p>", 3)).toBe("abc…");
    expect(htmlToText(false, 10)).toBeNull();
  });
});
