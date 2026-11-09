import type { CardProvider, CardTone } from "@cc/core";
import type { Domain, OdooReader, OdooRecord } from "./client";

/**
 * Odoo's cards (see @cc/core cards.ts and docs/CARDS.md): a product, a sales order and a
 * contact, read live. Fields this Odoo doesn't have are left off the card.
 */

const nameOf = (v: unknown) => (Array.isArray(v) && typeof v[1] === "string" ? v[1] : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const qty = (n: number) => String(Math.round(n * 100) / 100);
/** "2026-10-20 14:03:00" → "20 Oct 2026". */
const day = (v: string) => {
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? v.slice(0, 10) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** "£24.50" when the currency is known, else "24.50". */
export function money(amount: number, currency: string | null): string {
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
    } catch {
      /* unknown code: fall through */
    }
  }
  return amount.toFixed(2);
}

/** Odoo images are base64 with no type: the first bytes say which. */
export function imageDataUrl(base64: unknown): string | undefined {
  if (typeof base64 !== "string" || base64.length < 16) return undefined;
  const mime = base64.startsWith("iVBOR") ? "image/png" : base64.startsWith("/9j/") ? "image/jpeg" : base64.startsWith("R0lG") ? "image/gif" : base64.startsWith("UklG") ? "image/webp" : null;
  return mime ? `data:${mime};base64,${base64}` : undefined;
}

type Fact = { label: string; value: string; tone?: CardTone };
type Badge = { text: string; tone: CardTone };

async function findOne(client: OdooReader, model: string, domain: Domain, wanted: string[]): Promise<{ record: OdooRecord; fields: Set<string> } | null> {
  const fields = await client.fields(model);
  if (!fields) return null;
  const [record] = await client.searchRead(model, domain, wanted.filter((f) => fields.has(f)), { limit: 1 });
  return record ? { record, fields } : null;
}

const byIdOr = (id: string, field: string): Domain => (/^\d+$/.test(id) ? [["id", "=", Number(id)]] : [[field, "=ilike", id]]);

export function odooCardProviders(client: OdooReader, baseUrl: string): Record<string, CardProvider> {
  const base = baseUrl.replace(/\/+$/, "");
  const link = (model: string, id: number) => `${base}/web#id=${id}&model=${model}&view_type=form`;

  return {
    "odoo.product": {
      description: "A product: picture, name, part number, price, stock on hand, forecast and incoming, category, whether it is on the website. Id: the product id (from search_products) or its exact SKU.",
      async resolve(id) {
        const found = await findOne(client, "product.product", byIdOr(id, "default_code"), [
          "name", "display_name", "default_code", "lst_price", "list_price", "standard_price", "currency_id", "qty_available", "virtual_available",
          "incoming_qty", "outgoing_qty", "categ_id", "is_published", "website_published", "barcode", "is_storable", "type", "active", "image_256",
        ]);
        if (!found) return null;
        const { record: r, fields } = found;
        const currency = nameOf(r.currency_id);
        const stocked = fields.has("qty_available") && (fields.has("is_storable") ? r.is_storable === true : r.type === "product");
        const onHand = num(r.qty_available) ?? 0;
        const forecast = num(r.virtual_available);
        const incoming = num(r.incoming_qty) ?? 0;
        const badges: Badge[] = [];
        if (r.active === false) badges.push({ text: "Archived", tone: "bad" });
        if (stocked) badges.push(onHand <= 0 ? { text: incoming > 0 ? "Out of stock, more coming" : "Out of stock", tone: "bad" } : forecast !== null && forecast <= 0 ? { text: "All reserved", tone: "warn" } : { text: "In stock", tone: "good" });
        else if (fields.has("type")) badges.push({ text: r.type === "service" ? "Service" : "Not stocked", tone: "neutral" });
        const published = "is_published" in r ? r.is_published : "website_published" in r ? r.website_published : undefined;
        if (published !== undefined) badges.push(published ? { text: "On website", tone: "neutral" } : { text: "Not on website", tone: "warn" });
        const price = num(r.lst_price) ?? num(r.list_price);
        const facts: Fact[] = [];
        if (price !== null) facts.push({ label: "Price", value: money(price, currency) });
        if (num(r.standard_price) !== null) facts.push({ label: "Cost", value: money(r.standard_price as number, currency) });
        if (stocked) {
          facts.push({ label: "On hand", value: qty(onHand), tone: onHand <= 0 ? "bad" : undefined });
          if (forecast !== null) facts.push({ label: "Forecast", value: qty(forecast), tone: forecast <= 0 ? "warn" : undefined });
          if (incoming) facts.push({ label: "Incoming", value: qty(incoming) });
          if (num(r.outgoing_qty)) facts.push({ label: "Outgoing", value: qty(r.outgoing_qty as number) });
        }
        if (nameOf(r.categ_id)) facts.push({ label: "Category", value: nameOf(r.categ_id)! });
        if (text(r.barcode)) facts.push({ label: "Barcode", value: text(r.barcode)! });
        const title = (text(r.name) ?? text(r.display_name) ?? `Product ${r.id}`).replace(/^\[[^\]]*\]\s*/, "");
        return { title, subtitle: text(r.default_code) ?? undefined, image: imageDataUrl(r.image_256), url: link("product.product", r.id), badges, facts, footnote: "Live from Odoo" };
      },
    },

    "odoo.order": {
      description: "A sales order or quotation: customer, date, total, and its state, delivery and invoice status. Id: the order id or its number (e.g. S00042).",
      async resolve(id) {
        const found = await findOne(client, "sale.order", byIdOr(id, "name"), [
          "name", "partner_id", "date_order", "state", "amount_untaxed", "amount_total", "currency_id", "invoice_status", "delivery_status", "client_order_ref", "commitment_date", "order_line",
        ]);
        if (!found) return null;
        const r = found.record;
        const currency = nameOf(r.currency_id);
        const state = text(r.state);
        const STATES: Record<string, Badge> = {
          draft: { text: "Quotation", tone: "neutral" },
          sent: { text: "Quotation sent", tone: "neutral" },
          sale: { text: "Confirmed", tone: "good" },
          done: { text: "Locked", tone: "good" },
          cancel: { text: "Cancelled", tone: "bad" },
        };
        const DELIVERY: Record<string, Badge> = { pending: { text: "Not delivered", tone: "warn" }, started: { text: "Delivery started", tone: "warn" }, partial: { text: "Part delivered", tone: "warn" }, full: { text: "Delivered", tone: "good" } };
        const INVOICE: Record<string, Badge> = { "to invoice": { text: "To invoice", tone: "warn" }, invoiced: { text: "Invoiced", tone: "good" } };
        const badges = [state ? (STATES[state] ?? { text: state, tone: "neutral" as const }) : null, DELIVERY[text(r.delivery_status) ?? ""], INVOICE[text(r.invoice_status) ?? ""]].filter((b): b is Badge => !!b);
        const facts: Fact[] = [];
        if (num(r.amount_total) !== null) facts.push({ label: "Total", value: money(r.amount_total as number, currency) });
        if (num(r.amount_untaxed) !== null) facts.push({ label: "Untaxed", value: money(r.amount_untaxed as number, currency) });
        if (text(r.date_order)) facts.push({ label: "Ordered", value: day(text(r.date_order)!) });
        if (text(r.commitment_date)) facts.push({ label: "Promised", value: day(text(r.commitment_date)!) });
        if (Array.isArray(r.order_line)) facts.push({ label: "Lines", value: String(r.order_line.length) });
        if (text(r.client_order_ref)) facts.push({ label: "Their ref", value: text(r.client_order_ref)! });
        return { title: text(r.name) ?? `Order ${r.id}`, subtitle: nameOf(r.partner_id) ?? undefined, url: link("sale.order", r.id), badges, facts, footnote: "Live from Odoo" };
      },
    },

    "odoo.customer": {
      description: "A contact: picture, name, company, email, phone, town and country. Id: the contact id (from search_customers) or their exact email address.",
      async resolve(id) {
        const found = await findOne(client, "res.partner", byIdOr(id, "email"), [
          "name", "email", "phone", "mobile", "city", "country_id", "is_company", "parent_id", "ref", "vat", "active", "image_256", "sale_order_count",
        ]);
        if (!found) return null;
        const r = found.record;
        const badges: Badge[] = [{ text: r.is_company ? "Company" : "Person", tone: "neutral" }];
        if (r.active === false) badges.unshift({ text: "Archived", tone: "bad" });
        const facts: Fact[] = [];
        if (text(r.email)) facts.push({ label: "Email", value: text(r.email)! });
        if (text(r.phone) ?? text(r.mobile)) facts.push({ label: "Phone", value: (text(r.phone) ?? text(r.mobile))! });
        const place = [text(r.city), nameOf(r.country_id)].filter(Boolean).join(", ");
        if (place) facts.push({ label: "Where", value: place });
        if (num(r.sale_order_count)) facts.push({ label: "Orders", value: String(r.sale_order_count) });
        if (text(r.vat)) facts.push({ label: "VAT", value: text(r.vat)! });
        if (text(r.ref)) facts.push({ label: "Ref", value: text(r.ref)! });
        return { title: text(r.name) ?? `Contact ${r.id}`, subtitle: nameOf(r.parent_id) ?? undefined, image: imageDataUrl(r.image_256), url: link("res.partner", r.id), badges, facts, footnote: "Live from Odoo" };
      },
    },
  };
}
