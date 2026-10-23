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

  it("updates a product price and reports the old one", async () => {
    expect(await executors["odoo.product.update_price"]!.execute({ id: 2, list_price: 94 })).toEqual({ id: 2, name: "[SP-300W] 300W spindle", from: 89, to: 94 });
    expect(odoo.models["product.product"]!.records.find((p) => p.id === 2)!.list_price).toBe(94);
    await expect(executors["odoo.product.update_price"]!.execute({ id: 999, list_price: 1 })).rejects.toThrow(/No product/);
  });
});
