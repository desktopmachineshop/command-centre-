import { describe, expect, it } from "vitest";
import { customerFacts, fieldsOf, hasReadable, labelOf, moneyText, quotePreviewOf, readable, recordPreviewOf, specFacts, stepText, stockText, videoSpecOf, voiceText } from "../src/payload";

describe("generic Odoo record previews", () => {
  it("reads as which records and what changes", () => {
    expect(
      recordPreviewOf({
        model: "product.pricelist.item",
        label: "Pricelist Rule",
        count: 12,
        records: [{ id: 1, name: "Spindle: 79.00" }, { id: 2, name: "Collets: 21.00" }],
        changes: [
          { field: "min_quantity", label: "Min. Quantity", from: "1", to: "5", changes: 12 },
          { field: "fixed_price", label: "Fixed Price", from: [{ value: "79", records: 7 }, { value: "21", records: 5 }], to: "79", changes: 5 },
          { field: "active", label: "Active", from: "yes", to: "yes", changes: 0 },
        ],
      }),
    ).toEqual({
      title: "12 records of Pricelist Rule (product.pricelist.item)",
      lines: ["Spindle: 79.00, Collets: 21.00 and 10 more", "Min. Quantity: 1 → 5 (changes 12 of 12)", "Fixed Price: 79 (7), 21 (5) → 79 (changes 5 of 12)", "Active: already yes"],
    });
  });

  it("reads a new record with its duplicates, and a button press", () => {
    expect(recordPreviewOf({ model: "res.partner", label: "Contact", values: { Name: "Jane" }, duplicates: [{ id: 10, name: "Jane Doe", same: "Name", archived: true }] })).toEqual({
      title: "New Contact (res.partner)",
      lines: ["Name: Jane", "Possible duplicate: Jane Doe #10 (archived), same Name"],
    });
    expect(recordPreviewOf({ model: "sale.order", label: "Sales Order", count: 1, records: [{ id: 41, name: "S00041", state: "draft" }], method: "action_confirm" })).toEqual({ title: "Press action_confirm on Sales Order (sale.order)", lines: ["S00041 (draft)"] });
    expect(recordPreviewOf("looks fine")).toBeNull();
  });
});

describe("readable proposal details", () => {
  it("labels keys in plain words", () => {
    expect(labelOf("accountId")).toBe("Account id");
    expect(labelOf("scheduled_at")).toBe("Scheduled at");
    expect(labelOf("cta")).toBe("Call to action");
  });

  it("turns values into text, links, images, colours and lists, dropping empties", () => {
    expect(readable("Hello")).toEqual({ kind: "text", text: "Hello" });
    expect(readable("#d9822b")).toEqual({ kind: "colour", hex: "#d9822b" });
    expect(readable("https://x.test/a.png")).toEqual({ kind: "image", url: "https://x.test/a.png" });
    expect(readable("https://x.test/page")).toEqual({ kind: "link", url: "https://x.test/page" });
    expect(readable(true)).toEqual({ kind: "text", text: "Yes" });
    expect(readable(["a", "", null])).toEqual({ kind: "list", items: [{ kind: "text", text: "a" }] });
    expect(readable({})).toBeNull();
    expect(readable("  ")).toBeNull();
  });

  it("orders fields addressing first, long text last, and hides server keys", () => {
    const keys = fieldsOf({ body: "Hi", policyDowngrade: "x", priority: 2, to: "a@b.c", subject: "S" }).map((f) => f.key);
    expect(keys).toEqual(["to", "subject", "priority", "body"]);
  });

  it("reads a video spec as a storyboard", () => {
    const spec = { title: "DMS reel", type: "short", format: "9:16", voice: { provider: "silent" }, scenes: [{ id: "hook", kind: "title", heading: "Hi" }] };
    expect(videoSpecOf(spec)).toBe(spec);
    expect(videoSpecOf({ scenes: [] })).toBeNull();
    expect(specFacts(spec)).toEqual([
      ["Title", "DMS reel"],
      ["Kind", "Short"],
      ["Format", "9:16 (portrait)"],
      ["Voiceover", "None (captions only)"],
    ]);
    expect(stepText({ action: "goto", url: "https://dms.test" })).toBe("Open https://dms.test");
    expect(stepText({ action: "type", selector: "#q", text: "milo" })).toBe("Type “milo” into #q");
    expect(stepText({ action: "wait", ms: 1500 })).toBe("Pause 1.5 s");
    expect(voiceText("local", "kokoro:bm_george")).toBe("George (server voice, most natural)");
    expect(voiceText("local", "piper:jenny_dioco")).toBe("Jenny (server voice, fast)");
    expect(voiceText("local")).toBe("Server default voice");
    expect(voiceText("auto")).toBe("The best voice the server has");
    expect(voiceText("flite")).toMatch(/drafts only/);
  });
});

describe("quote approvals", () => {
  const preview = {
    customer: { id: 10, name: "Jane Doe", company: "Acme", email: "jane@example.com", phone: null, address: "Leeds", previousOrders: 0 },
    lines: [{ product_id: 2, part_number: "SP-300W", name: "300W spindle", qty: 2, unit_price: 89, discount: 0, subtotal: 148.33 }],
    currency: "GBP",
    untaxed: 148.33,
    tax: 29.67,
    total: 178,
    estimated: true,
    notes: [],
  };

  it("reads the server's quote preview, and nothing else, as a quote", () => {
    expect(quotePreviewOf(preview)).toBe(preview);
    expect(quotePreviewOf("Could not look up the quote in Odoo")).toBeNull();
    expect(quotePreviewOf({ customer: { name: "x" } })).toBeNull();
  });

  it("summarises the customer and formats amounts in the quote's currency", () => {
    expect(customerFacts(preview.customer)).toEqual([
      ["Customer", "Jane Doe (Acme)"],
      ["Email", "jane@example.com"],
      ["Address", "Leeds"],
      ["Previous orders", "None (new customer)"],
    ]);
    expect(moneyText(1234.5, "GBP")).toBe("£1,234.50");
    expect(moneyText(3, null)).toBe("3.00");
  });

  it("shows the quote instead of its raw ids and lines", () => {
    const payload = { partner_id: 10, lines: [{ product_id: 2, qty: 2 }], note: "Thanks", quotePreview: preview };
    expect(hasReadable(payload)).toBe(true);
    expect(fieldsOf(payload, ["quotePreview", "partner_id", "lines", "id"]).map((f) => f.key)).toEqual(["note"]);
  });
});

describe("quote stock", () => {
  it("says whether stock is good, short but incoming, or needs ordering", () => {
    expect(stockText({ status: "ok", on_hand: 12, forecast: 10 })).toMatchObject({ tone: "ok", text: "In stock (12)" });
    expect(stockText({ status: "incoming", on_hand: 0, forecast: 4 })).toMatchObject({ tone: "warn", text: "Incoming (0 now)" });
    expect(stockText({ status: "order", on_hand: 3, forecast: 1, short: 2 })).toEqual({
      tone: "bad",
      text: "Order 2 more",
      detail: "Needs ordering. 3 on hand, 1 forecast after incoming and other orders",
    });
    expect(stockText({ status: "untracked", on_hand: null, forecast: null })).toBeNull();
    expect(stockText(undefined)).toBeNull();
  });
});
