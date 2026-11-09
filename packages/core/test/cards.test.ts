import { describe, expect, it } from "vitest";
import { Card, cardRefs, parseCardRef } from "../src";

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
