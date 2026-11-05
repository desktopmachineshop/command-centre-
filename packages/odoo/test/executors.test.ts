import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOdooExecutors, OdooClient } from "../src";
import { demoModels, FakeOdoo } from "../src/testing";

let odoo: FakeOdoo;
let executors: ReturnType<typeof createOdooExecutors>;
beforeAll(async () => {
  odoo = new FakeOdoo({ models: demoModels() });
  await odoo.start();
  executors = createOdooExecutors(new OdooClient({ url: odoo.url, db: "testdb", username: "bot@example.com", apiKey: "test-api-key" }));
});
afterAll(() => odoo.stop());

const messages = () => odoo.models["mail.message"]!.records;

describe("odoo executors", () => {
  it("posts customer messages and internal notes", async () => {
    const msg = (await executors["odoo.message.post"]!.execute({ model: "sale.order", id: 42, body: "<p>Shipping Friday.</p>" })) as any;
    expect(msg).toMatchObject({ model: "sale.order", id: 42, internal: false });
    expect(odoo.callsTo("message_post").at(-1)!.params).toMatchObject({ body_is_html: true, message_type: "comment", subtype_xmlid: "mail.mt_comment" });
    expect(messages().find((m) => m.id === msg.messageId)).toMatchObject({ res_id: 42, subtype_id: [1, "Discussions"] });

    await executors["odoo.message.post"]!.execute({ model: "res.partner", id: 10, body: "Asked about collets", internal: true });
    expect(odoo.callsTo("message_post").at(-1)!.params).toEqual({ ids: [10], body: "Asked about collets", message_type: "comment", subtype_xmlid: "mail.mt_note" });
  });

  it("falls back for Odoo versions without body_is_html", async () => {
    odoo.legacyMessagePost = true;
    try {
      await executors["odoo.message.post"]!.execute({ model: "sale.order", id: 42, body: "<p>Hi</p>" });
      expect(odoo.callsTo("message_post").slice(-2).map((c) => "body_is_html" in c.params)).toEqual([true, false]);
    } finally {
      odoo.legacyMessagePost = false;
    }
  });

  it("validates payloads", async () => {
    await expect(executors["odoo.message.post"]!.execute({ model: "Sale Order!", id: 1, body: "x" })).rejects.toThrow(/model/);
    await expect(executors["odoo.message.post"]!.execute({ model: "sale.order", id: 999, body: "x" })).rejects.toThrow(/does not exist/);
    await expect(executors["odoo.product.update_price"]!.execute({ id: 1, list_price: -3 })).rejects.toThrow(/list_price/);
    await expect(executors["odoo.blog.draft"]!.execute({ title: "t", content: "<p>c</p>" })).rejects.toThrow(/blog_id or website_id/);
  });

  it("drafts unpublished blog posts on a website's blog", async () => {
    const res = (await executors["odoo.blog.draft"]!.execute({ title: "Spindle care", subtitle: "Keep it cool", content: "<p>Oil it.</p>", website_id: 2 })) as any;
    expect(res).toMatchObject({ blog_id: 2, published: false });
    const post = odoo.models["blog.post"]!.records.find((p) => p.id === res.id);
    expect(post).toMatchObject({ name: "Spindle care", subtitle: "Keep it cool", content: "<p>Oil it.</p>", blog_id: 2, is_published: false });
    await expect(executors["odoo.blog.draft"]!.execute({ title: "x", content: "y", website_id: 99 })).rejects.toThrow(/no blog/);
  });

  it("creates a quotation without sending it", async () => {
    const res = (await executors["odoo.quote.create"]!.execute({
      partner_id: 10,
      lines: [{ product_id: 2, qty: 2 }, { product_id: 1, qty: 1, price_unit: 20, discount: 10, description: "ER11 collets, trade price" }],
      validity_date: "2026-11-30",
      client_order_ref: "Workshop refit",
    })) as any;
    expect(res).toMatchObject({ customer: "Jane Doe", state: "draft", sent: false, untaxed: 196, total: 235.2 });
    const order = odoo.models["sale.order"]!.records.find((o) => o.id === res.id)!;
    expect(order).toMatchObject({ name: res.name, partner_id: [10, "Jane Doe"], validity_date: "2026-11-30", client_order_ref: "Workshop refit", state: "draft" });
    const lines = odoo.models["sale.order.line"]!.records.filter((l) => (order.order_line as number[]).includes(l.id));
    expect(lines.map((l) => [l.product_uom_qty, l.price_unit, l.discount ?? 0, l.name])).toEqual([
      [2, 89, 0, "300W spindle"],
      [1, 20, 10, "ER11 collets, trade price"],
    ]);
    expect(odoo.callsTo("action_send_mail")).toHaveLength(0);
  });

  it("creates and sends a quotation through Odoo's quotation email", async () => {
    const res = (await executors["odoo.quote.create"]!.execute({ partner_id: 10, lines: [{ product_id: 3, qty: 1 }], send: true })) as any;
    expect(res).toMatchObject({ state: "sent", sent: true, total: 1500 });
    const [composerCreate] = odoo.callsTo("create").filter((c) => c.model === "mail.compose.message");
    expect(composerCreate!.params.context).toMatchObject({ default_res_ids: [res.id], default_template_id: 9, mark_so_as_sent: true });
    expect(odoo.callsTo("action_send_mail").at(-1)!.params.context).toMatchObject({ default_model: "sale.order" });
    expect(messages().at(-1)).toMatchObject({ model: "sale.order", res_id: res.id });
  });

  it("sends an existing quotation, but not a confirmed order", async () => {
    expect(await executors["odoo.quote.send"]!.execute({ id: 41 })).toMatchObject({ id: 41, name: "S00041", to: "Acme Robotics", state: "sent", sent: true });
    await expect(executors["odoo.quote.send"]!.execute({ id: 42 })).rejects.toThrow(/S00042 is sale, not a quotation/);
    await expect(executors["odoo.quote.send"]!.execute({ id: 999 })).rejects.toThrow(/No sales order/);
  });

  it("validates quotations", async () => {
    await expect(executors["odoo.quote.create"]!.execute({ partner_id: 10, lines: [] })).rejects.toThrow(/lines/);
    await expect(executors["odoo.quote.create"]!.execute({ partner_id: 10, lines: [{ product_id: 1, qty: 0 }] })).rejects.toThrow(/qty/);
    await expect(executors["odoo.quote.create"]!.execute({ partner_id: 999, lines: [{ product_id: 1, qty: 1 }] })).rejects.toThrow(/No contact/);
    odoo.update("res.partner", 11, { email: false });
    try {
      await expect(executors["odoo.quote.create"]!.execute({ partner_id: 11, lines: [{ product_id: 1, qty: 1 }], send: true })).rejects.toThrow(/no email/);
    } finally {
      odoo.update("res.partner", 11, { email: "buy@acme.example" });
    }
  });

  it("creates a promo code program with its rule and reward", async () => {
    const res = (await executors["odoo.loyalty.create"]!.execute({
      name: "Black Friday 15%",
      program_type: "promo_code",
      code: "BF15",
      date_from: "2026-11-27",
      date_to: "2026-11-30",
      website_id: 1,
      max_usage: 100,
      rule: { minimum_amount: 40 },
      reward: { type: "discount", discount: 15, description: "15% off" },
    })) as any;
    expect(res).toEqual({ id: expect.any(Number), name: "Black Friday 15%", program_type: "promo_code", code: "BF15", date_from: "2026-11-27", date_to: "2026-11-30", active: true });
    const program = odoo.models["loyalty.program"]!.records.find((p) => p.id === res.id)!;
    expect(program).toMatchObject({ trigger: "with_code", applies_on: "current", active: true, limit_usage: true, max_usage: 100, website_id: 1 });
    const rule = odoo.models["loyalty.rule"]!.records.find((r) => (program.rule_ids as number[]).includes(r.id));
    expect(rule).toEqual({ id: expect.any(Number), mode: "with_code", code: "BF15", minimum_amount: 40 });
    const reward = odoo.models["loyalty.reward"]!.records.find((r) => (program.reward_ids as number[]).includes(r.id));
    expect(reward).toEqual({ id: expect.any(Number), reward_type: "discount", discount: 15, discount_mode: "percent", discount_applicability: "order", description: "15% off" });
  });

  it("creates a buy X get Y deal on specific products", async () => {
    const res = (await executors["odoo.loyalty.create"]!.execute({
      name: "Spindle + free collets",
      program_type: "buy_x_get_y",
      rule: { product_ids: [2], points: 1, points_mode: "unit" },
      reward: { type: "product", product_id: 1, required_points: 1 },
    })) as any;
    const program = odoo.models["loyalty.program"]!.records.find((p) => p.id === res.id)!;
    expect(program).toMatchObject({ trigger: "auto", program_type: "buy_x_get_y" });
    const rule = odoo.models["loyalty.rule"]!.records.find((r) => (program.rule_ids as number[]).includes(r.id));
    expect(rule).toMatchObject({ mode: "auto", product_ids: [2], reward_point_amount: 1, reward_point_mode: "unit" });
    const reward = odoo.models["loyalty.reward"]!.records.find((r) => (program.reward_ids as number[]).includes(r.id))!;
    expect(reward).toMatchObject({ reward_type: "product", reward_product_id: 1, required_points: 1 });
    expect("discount" in reward).toBe(false);
  });

  it("validates discount and loyalty programs", async () => {
    const create = (p: Record<string, unknown>) => executors["odoo.loyalty.create"]!.execute({ name: "x", program_type: "promotion", reward: { type: "discount", discount: 10 }, ...p });
    await expect(create({ program_type: "promo_code" })).rejects.toThrow(/code is required/);
    await expect(create({ code: "X" })).rejects.toThrow(/only for promo_code/);
    await expect(create({ reward: { type: "discount" } })).rejects.toThrow(/discount is required/);
    await expect(create({ reward: { type: "discount", discount: 150 } })).rejects.toThrow(/over 100/);
    await expect(create({ reward: { type: "discount", discount: 5, applies_to: "specific" } })).rejects.toThrow(/discount_product_ids/);
    await expect(create({ reward: { type: "product" } })).rejects.toThrow(/product_id/);
    await expect(create({ program_type: "buy_x_get_y" })).rejects.toThrow(/must be product/);
    await expect(create({ date_from: "2026-12-01", date_to: "2026-11-01" })).rejects.toThrow(/before date_from/);
    await expect(create({ date_to: "next week" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("archives a program and reports whether it was live", async () => {
    expect(await executors["odoo.loyalty.archive"]!.execute({ id: 1 })).toEqual({ id: 1, name: "Spring 10% off", archived: true, was_active: true });
    expect(odoo.models["loyalty.program"]!.records.find((p) => p.id === 1)!.active).toBe(false);
    expect(await executors["odoo.loyalty.archive"]!.execute({ id: 2 })).toEqual({ id: 2, name: "SUMMER25", archived: true, was_active: false });
    await expect(executors["odoo.loyalty.archive"]!.execute({ id: 999 })).rejects.toThrow(/No discount or loyalty program/);
  });

  it("updates a product price and reports the old one", async () => {
    expect(await executors["odoo.product.update_price"]!.execute({ id: 2, list_price: 94 })).toEqual({ id: 2, name: "[SP-300W] 300W spindle", from: 89, to: 94 });
    expect(odoo.models["product.product"]!.records.find((p) => p.id === 2)!.list_price).toBe(94);
    await expect(executors["odoo.product.update_price"]!.execute({ id: 999, list_price: 1 })).rejects.toThrow(/No product/);
  });
});
