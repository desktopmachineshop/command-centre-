import { describe, expect, it } from "vitest";
import { Card, cardRefs, parseCardRef, proposalCardRefs } from "../src";

describe("cards", () => {
  it("parses references as kind:id", () => {
    expect(parseCardRef("odoo.product:42")).toEqual({ kind: "odoo.product", id: "42" });
    expect(parseCardRef(" odoo.order:S00042 ")).toEqual({ kind: "odoo.order", id: "S00042" });
    expect(parseCardRef("odoo.customer:jane@example.com")).toEqual({ kind: "odoo.customer", id: "jane@example.com" });
    for (const bad of ["", "product:42", "odoo.product", "odoo.product:", "Odoo.Product:1", '{"title":"x"}']) expect(parseCardRef(bad), bad).toBeNull();
  });

  it("reads a card block: one reference per line or comma, no duplicates, at most 12", () => {
    expect(cardRefs("odoo.product:1\n\n odoo.product:2, odoo.product:1\n")).toEqual(["odoo.product:1", "odoo.product:2"]);
    expect(cardRefs(Array.from({ length: 20 }, (_, i) => `odoo.product:${i}`).join("\n"))).toHaveLength(12);
  });

  it("defaults badges and facts", () => {
    expect(Card.parse({ ref: "a.b:1", kind: "a.b", title: "T", badges: [{ text: "x" }] })).toEqual({ ref: "a.b:1", kind: "a.b", title: "T", badges: [{ text: "x", tone: "neutral" }], facts: [] });
  });
});

describe("proposalCardRefs", () => {
  it("names the record an action would change", () => {
    expect(proposalCardRefs("odoo.product.update_price", { id: 1, list_price: 26 })).toEqual(["odoo.product:1"]);
    expect(proposalCardRefs("odoo.stock.adjust", { product_id: "7", quantity: 3 })).toEqual(["odoo.product:7"]);
    expect(proposalCardRefs("odoo.order.cancel", { id: 42 })).toEqual(["odoo.order:42"]);
    expect(proposalCardRefs("odoo.invoice.create", { order_id: 42 })).toEqual(["odoo.order:42"]);
    expect(proposalCardRefs("odoo.customer.update", { id: 10, phone: "1" })).toEqual(["odoo.customer:10"]);
  });

  it("reads the model of chatter posts and generic record actions", () => {
    expect(proposalCardRefs("odoo.message.post", { model: "sale.order", id: 42, body: "x" })).toEqual(["odoo.order:42"]);
    expect(proposalCardRefs("odoo.record.update", { model: "res.partner", ids: [10, 11], values: {} })).toEqual(["odoo.customer:10", "odoo.customer:11"]);
    expect(proposalCardRefs("odoo.record.update", { model: "stock.picking", ids: [5], values: {} })).toEqual([]);
  });

  it("is empty for anything else, and for ids that aren't ids", () => {
    expect(proposalCardRefs("notify", { title: "x", id: 3 })).toEqual([]);
    expect(proposalCardRefs("email.send", { model: "sale.order", id: 42 })).toEqual([]);
    expect(proposalCardRefs("odoo.product.update_price", { id: "ER11-7; drop" })).toEqual([]);
    expect(proposalCardRefs("odoo.product.update_price", { id: -1 })).toEqual([]);
  });
});
