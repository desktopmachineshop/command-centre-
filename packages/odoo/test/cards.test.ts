import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageDataUrl, money, OdooClient, odooCardProviders } from "../src";
import { demoModels, FakeOdoo } from "../src/testing";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let odoo: FakeOdoo;
let cards: ReturnType<typeof odooCardProviders>;
beforeAll(async () => {
  const models = demoModels();
  models["product.product"]!.fields.push("image_256", "currency_id");
  for (const r of models["product.product"]!.records!) r.currency_id = [1, "GBP"];
  models["product.product"]!.records![0]!.image_256 = PNG;
  odoo = new FakeOdoo({ models });
  await odoo.start();
  cards = odooCardProviders(new OdooClient({ url: odoo.url, db: "testdb", username: "bot@example.com", apiKey: "test-api-key" }), "https://shop.odoo.com/");
});
afterAll(() => odoo.stop());

describe("odoo cards", () => {
  it("shows a product by id or SKU: picture, part number, price, stock", async () => {
    const card = await cards["odoo.product"]!.resolve("er11-7");
    expect(card).toEqual({
      title: "ER11 collet set (7 pcs)",
      subtitle: "ER11-7",
      image: `data:image/png;base64,${PNG}`,
      url: "https://shop.odoo.com/web#id=1&model=product.product&view_type=form",
      badges: [{ text: "In stock", tone: "good" }, { text: "On website", tone: "neutral" }],
      facts: [
        { label: "Price", value: "£24.50" },
        { label: "Cost", value: "£9.10" },
        { label: "On hand", value: "3", tone: undefined },
        { label: "Forecast", value: "1", tone: undefined },
        { label: "Category", value: "All / Tooling" },
      ],
      footnote: "Live from Odoo",
    });
    expect(await cards["odoo.product"]!.resolve("1")).toMatchObject({ subtitle: "ER11-7" });
  });

  it("flags no stock and what is coming, and leaves stock off a service", async () => {
    const milo = (await cards["odoo.product"]!.resolve("MILO-V2"))!;
    expect(milo.badges![0]).toEqual({ text: "Out of stock, more coming", tone: "bad" });
    expect(milo.facts).toContainEqual({ label: "On hand", value: "0", tone: "bad" });
    expect(milo.facts).toContainEqual({ label: "Incoming", value: "4" });
    expect(milo.image).toBeUndefined();
    const ship = (await cards["odoo.product"]!.resolve("SHIP"))!;
    expect(ship.badges![0]).toEqual({ text: "Service", tone: "neutral" });
    expect(ship.facts!.map((f) => f.label)).toEqual(["Price", "Cost"]);
  });

  it("shows an order and a contact", async () => {
    expect(await cards["odoo.order"]!.resolve("s00042")).toMatchObject({
      title: "S00042",
      subtitle: "Jane Doe",
      badges: [{ text: "Confirmed", tone: "good" }, { text: "Part delivered", tone: "warn" }, { text: "Invoiced", tone: "good" }],
      facts: [{ label: "Total", value: "£113.50" }, { label: "Ordered", value: "20 Oct 2026" }, { label: "Lines", value: "2" }],
    });
    expect(await cards["odoo.customer"]!.resolve("jane@example.com")).toMatchObject({
      title: "Jane Doe",
      badges: [{ text: "Person", tone: "neutral" }],
      facts: [{ label: "Email", value: "jane@example.com" }, { label: "Phone", value: "+44 7700 900123" }, { label: "Where", value: "Leeds, United Kingdom" }],
    });
  });

  it("answers null for a record that isn't there, and never writes", async () => {
    expect(await cards["odoo.product"]!.resolve("NOPE")).toBeNull();
    expect(await cards["odoo.order"]!.resolve("999")).toBeNull();
    expect(odoo.calls.filter((c) => !["search_read", "fields_get"].includes(c.method))).toEqual([]);
  });

  it("formats money and recognises image types", () => {
    expect(money(5, "EUR")).toBe("€5.00");
    expect(money(5, null)).toBe("5.00");
    expect(imageDataUrl("/9j/4AAQSkZJRgABAQ")).toMatch(/^data:image\/jpeg/);
    expect(imageDataUrl("PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPg==")).toBeUndefined();
    expect(imageDataUrl(false)).toBeUndefined();
  });
});
