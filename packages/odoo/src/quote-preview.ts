import { OdooError, type OdooClient, type OdooRecord } from "./client";

/**
 * What a quotation approval shows Dave: who the customer is, every line with its part number,
 * name, price and subtotal, and the quote's totals. Stored in the proposal's payload under
 * `quotePreview` (the server's, replacing whatever the agent sends), and looked up again when
 * Dave edits the proposal.
 */
export interface QuotePreview {
  /** The quotation's own name, for a quote that already exists in Odoo (odoo.quote.send). */
  quote?: string;
  customer: QuoteCustomer;
  lines: QuotePreviewLine[];
  currency: string | null;
  /** Total before tax: the sum of the line subtotals. */
  untaxed: number;
  /** Null when it can't be worked out here (Odoo still computes it on the quote): see `notes`. */
  tax: number | null;
  total: number | null;
  /** True when tax and prices are this server's own sums, not Odoo's figures for a saved quote. */
  estimated: boolean;
  /** Anything that may make Odoo's figures differ. */
  notes: string[];
}

export interface QuoteCustomer {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  vat: string | null;
  ref: string | null;
  pricelist: string | null;
  /** Confirmed sales orders for the customer (and its company's contacts). */
  previousOrders: number | null;
}

export interface QuotePreviewLine {
  product_id: number | null;
  part_number: string | null;
  name: string;
  qty: number;
  unit_price: number;
  /** Percent. */
  discount: number;
  /** Before tax, after discount. */
  subtotal: number;
}

export interface QuoteLineInput {
  product_id: number;
  qty: number;
  price_unit?: number;
  discount?: number;
  description?: string;
}

export type QuoteReader = Pick<OdooClient, "read" | "searchCount" | "fields">;

/** A record the quote names doesn't exist: the proposal is refused rather than shown half-empty. */
export class QuoteLookupError extends OdooError {}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const nameOf = (v: unknown) => (Array.isArray(v) && typeof v[1] === "string" ? v[1] : null);
const idOf = (v: unknown) => (Array.isArray(v) && typeof v[0] === "number" ? v[0] : typeof v === "number" ? v : null);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const money = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Reads only the fields this Odoo has. */
async function readSome(client: QuoteReader, model: string, recordIds: number[], wanted: string[]): Promise<{ rows: OdooRecord[]; fields: Set<string> }> {
  const fields = (await client.fields(model)) ?? new Set<string>();
  if (!recordIds.length) return { rows: [], fields };
  const rows = await client.read(model, recordIds, wanted.filter((f) => fields.has(f)));
  return { rows, fields };
}

async function customerOf(client: QuoteReader, partnerId: number): Promise<{ customer: QuoteCustomer; record: OdooRecord }> {
  const { rows } = await readSome(client, "res.partner", [partnerId], [
    "name", "email", "phone", "mobile", "street", "street2", "city", "zip", "country_id", "vat", "ref", "parent_id",
    "commercial_partner_id", "property_product_pricelist", "property_account_position_id",
  ]);
  const record = rows[0];
  if (!record) throw new QuoteLookupError(`No contact with id ${partnerId}`);
  const address = [text(record.street), text(record.street2), text(record.city), text(record.zip), nameOf(record.country_id)].filter(Boolean).join(", ");
  let previousOrders: number | null = null;
  try {
    const commercial = idOf(record.commercial_partner_id) ?? partnerId;
    previousOrders = await client.searchCount("sale.order", [["partner_id", "child_of", commercial], ["state", "in", ["sale", "done"]]]);
  } catch {
    // Only a nicety on the approval: leave it out rather than fail the preview.
  }
  return {
    record,
    customer: {
      id: partnerId,
      name: String(record.name),
      company: nameOf(record.parent_id),
      email: text(record.email),
      phone: text(record.phone) ?? text(record.mobile),
      address: address || null,
      vat: text(record.vat),
      ref: text(record.ref),
      pricelist: nameOf(record.property_product_pricelist),
      previousOrders,
    },
  };
}

/** A tax as this preview can apply it: a percentage, included in the price or added to it. */
interface SimpleTax {
  percent: number;
  included: boolean;
}

/** The product's taxes as percentages, or null when one isn't a plain percentage, or whether its price includes it is unknown. */
async function taxesOf(client: QuoteReader, taxIds: number[]): Promise<SimpleTax[] | null> {
  if (!taxIds.length) return [];
  const { rows } = await readSome(client, "account.tax", taxIds, ["amount", "amount_type", "price_include", "price_include_override"]);
  const out: SimpleTax[] = [];
  for (const t of rows) {
    if (t.amount_type !== "percent") return null;
    // Odoo 18: price_include_override (unset means the company's default, which its computed price_include has); Odoo 17: price_include.
    const override = t.price_include_override;
    const included = override === "tax_included" ? true : override === "tax_excluded" ? false : typeof t.price_include === "boolean" ? t.price_include : null;
    if (included == null) return null;
    out.push({ percent: num(t.amount), included });
  }
  return out;
}

/**
 * The preview of a new quotation: its customer, its lines priced as Odoo would by default
 * (the line's price_unit, else the product's sale price), and its totals with the products'
 * percentage taxes. Notes say what could make Odoo's own figures differ (a pricelist with rules,
 * a fiscal position, a tax that isn't a plain percentage).
 */
export async function previewNewQuote(client: QuoteReader, partnerId: number, lines: QuoteLineInput[]): Promise<QuotePreview> {
  const notes: string[] = [];
  const { customer, record: partner } = await customerOf(client, partnerId);

  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const { rows: products } = await readSome(client, "product.product", productIds, ["default_code", "name", "display_name", "lst_price", "list_price", "taxes_id", "currency_id"]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = productIds.filter((id) => !byId.has(id));
  if (missing.length) throw new QuoteLookupError(`No product with id ${missing.join(", ")}`);

  const pricelistId = idOf(partner.property_product_pricelist);
  let currency = products.map((p) => nameOf(p.currency_id)).find(Boolean) ?? null;
  if (pricelistId) {
    try {
      const { rows } = await readSome(client, "product.pricelist", [pricelistId], ["name", "currency_id", "item_ids"]);
      const pricelist = rows[0];
      currency = nameOf(pricelist?.currency_id) ?? currency;
      if (ids(pricelist?.item_ids).length && lines.some((l) => l.price_unit === undefined)) {
        notes.push(`Lines without a set price show the list price; the customer's pricelist (${customer.pricelist ?? "unnamed"}) has rules that may change it.`);
      }
    } catch {
      // The pricelist only refines the notes.
    }
  }

  const fiscal = nameOf(partner.property_account_position_id);
  if (fiscal) notes.push(`The customer has fiscal position ${fiscal}, which can change the tax: Odoo works out the final tax.`);
  const taxCache = new Map<string, SimpleTax[] | null>();

  let untaxed = 0;
  let tax: number | null = fiscal ? null : 0;
  const out: QuotePreviewLine[] = [];
  for (const line of lines) {
    const product = byId.get(line.product_id)!;
    const unit = line.price_unit ?? num(product.lst_price ?? product.list_price);
    const discount = line.discount ?? 0;
    const gross = line.qty * unit * (1 - discount / 100);
    const key = ids(product.taxes_id).join(",");
    if (!taxCache.has(key)) taxCache.set(key, await taxesOf(client, ids(product.taxes_id)));
    const taxes = taxCache.get(key);
    let subtotal = gross;
    if (taxes) {
      const included = taxes.filter((t) => t.included).reduce((s, t) => s + t.percent, 0);
      const all = taxes.reduce((s, t) => s + t.percent, 0);
      subtotal = gross / (1 + included / 100);
      if (tax != null) tax += money((money(subtotal) * all) / 100);
    } else if (tax != null) {
      tax = null;
      notes.push(`${text(product.display_name) ?? text(product.name)} has a tax this preview can't work out: Odoo works out the final tax.`);
    }
    subtotal = money(subtotal);
    untaxed += subtotal;
    out.push({
      product_id: product.id,
      part_number: text(product.default_code),
      name: line.description ?? String(product.name ?? product.display_name),
      qty: line.qty,
      unit_price: unit,
      discount,
      subtotal,
    });
  }
  untaxed = money(untaxed);
  return { customer, lines: out, currency, untaxed, tax: tax == null ? null : money(tax), total: tax == null ? null : money(untaxed + tax), estimated: true, notes };
}

/** The preview of a quotation already in Odoo: its own lines and totals, as Odoo computed them. */
export async function previewExistingQuote(client: QuoteReader, orderId: number): Promise<QuotePreview> {
  const { rows } = await readSome(client, "sale.order", [orderId], ["name", "partner_id", "order_line", "amount_untaxed", "amount_tax", "amount_total", "currency_id"]);
  const order = rows[0];
  if (!order) throw new QuoteLookupError(`No sales order with id ${orderId}`);
  const partnerId = idOf(order.partner_id);
  if (!partnerId) throw new QuoteLookupError(`${String(order.name)} has no customer`);
  const { customer } = await customerOf(client, partnerId);
  const { rows: lineRows } = await readSome(client, "sale.order.line", ids(order.order_line), [
    "product_id", "name", "product_uom_qty", "price_unit", "discount", "price_subtotal", "display_type", "sequence",
  ]);
  const productLines = lineRows.filter((l) => !l.display_type);
  const productIds = [...new Set(productLines.map((l) => idOf(l.product_id)).filter((x): x is number => x != null))];
  const { rows: products } = await readSome(client, "product.product", productIds, ["default_code"]);
  const codes = new Map(products.map((p) => [p.id, text(p.default_code)]));
  const lines = productLines
    .sort((a, b) => num(a.sequence) - num(b.sequence) || a.id - b.id)
    .map((l) => {
      const productId = idOf(l.product_id);
      return {
        product_id: productId,
        part_number: productId != null ? (codes.get(productId) ?? null) : null,
        name: text(l.name) ?? nameOf(l.product_id) ?? "",
        qty: num(l.product_uom_qty),
        unit_price: num(l.price_unit),
        discount: num(l.discount),
        subtotal: money(num(l.price_subtotal)),
      };
    });
  const untaxed = typeof order.amount_untaxed === "number" ? order.amount_untaxed : money(lines.reduce((s, l) => s + l.subtotal, 0));
  const total = typeof order.amount_total === "number" ? order.amount_total : null;
  const tax = typeof order.amount_tax === "number" ? order.amount_tax : total != null ? money(total - untaxed) : null;
  return { quote: String(order.name), customer, lines, currency: nameOf(order.currency_id), untaxed, tax, total, estimated: false, notes: [] };
}

const fmt = (n: number, currency: string | null) => {
  try {
    if (currency && /^[A-Z]{3}$/.test(currency)) return n.toLocaleString("en-GB", { style: "currency", currency });
  } catch {
    // An unknown currency code: plain number below.
  }
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** One line for the approval request (summary): customer, lines, total. */
export function quoteNote(p: QuotePreview): string {
  const count = `${p.lines.length} line${p.lines.length === 1 ? "" : "s"}`;
  const total = p.total != null ? `${fmt(p.total, p.currency)} total${p.estimated ? " (est.)" : ""}` : `${fmt(p.untaxed, p.currency)} before tax`;
  return `[${p.quote ? `${p.quote} for ` : ""}${p.customer.name}: ${count}, ${total}.]`;
}
