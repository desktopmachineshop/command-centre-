import { z } from "zod";

/**
 * Cards: the one way an integration shows a record in the app (chat first). An agent never
 * sends card data: it writes a reference (`odoo.product:42`) in a ```card fence in its reply,
 * and the app asks the server, which asks the integration, for the card. So a card always
 * shows live, trusted data (stock as it is now, not as the model remembers it), and looks the
 * same whichever integration it comes from. See docs/CARDS.md.
 */

/** How a badge or fact reads at a glance: fine, needs a look, a problem, or plain. */
export const CardTone = z.enum(["good", "warn", "bad", "neutral"]);
export type CardTone = z.infer<typeof CardTone>;

export const Card = z.object({
  /** The reference it was asked for by, e.g. "odoo.product:42". */
  ref: z.string(),
  /** `<integration>.<type>`, e.g. "odoo.product": the app may style a kind, never needs to. */
  kind: z.string(),
  title: z.string(),
  /** One muted line under the title: a part number, a date, who it is for. */
  subtitle: z.string().optional(),
  /** A small image: an https URL or a `data:image/…` URL. */
  image: z.string().optional(),
  /** Opens the record where it lives (Odoo, the shop, a tracking page). */
  url: z.string().optional(),
  /** Short states, most important first: "In stock", "Unpublished", "Paid". At most 4 are shown. */
  badges: z.array(z.object({ text: z.string(), tone: CardTone.default("neutral") })).default([]),
  /** Label and value pairs, ready to read (already formatted: "£24.50", "3 on hand"). At most 8 are shown. */
  facts: z.array(z.object({ label: z.string(), value: z.string(), tone: CardTone.optional() })).default([]),
  /** One small line at the bottom, e.g. where the data came from and when. */
  footnote: z.string().optional(),
});
export type Card = z.infer<typeof Card>;
export type CardInput = z.input<typeof Card>;

/** `<integration>.<type>:<id>`; the id is whatever the integration looks records up by (a number, a SKU, an order name). */
const REF = /^([a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*):(.{1,120})$/;

export function parseCardRef(ref: string): { kind: string; id: string } | null {
  const m = REF.exec(ref.trim());
  return m ? { kind: m[1]!, id: m[2]!.trim() } : null;
}

/** The references in a ```card fence: one per line (commas work too), at most 12, duplicates dropped. */
export function cardRefs(body: string): string[] {
  const refs = body
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter(Boolean);
  return [...new Set(refs)].slice(0, 12);
}

/** One kind of card an integration offers. */
export interface CardProvider {
  /** For the agents: what the card shows and what the id may be, in one line. */
  description: string;
  /** The card for an id, or null when there is no such record. Without `ref` and `kind`: the registry adds them. */
  resolve(id: string): Promise<Omit<CardInput, "ref" | "kind"> | null>;
}

/** What `GET /api/cards` answers per reference. */
export type CardResult = { ref: string; card: Card } | { ref: string; error: string };

/** Odoo models that have a card kind. */
const ODOO_MODEL_KINDS: Record<string, string> = { "product.product": "odoo.product", "sale.order": "odoo.order", "res.partner": "odoo.customer" };
/** Action types whose payload names one record by a plain id field: [payload key, card kind]. */
const PROPOSAL_RECORDS: Record<string, [string, string][]> = {
  "odoo.product.update_price": [["id", "odoo.product"]],
  "odoo.product.update": [["id", "odoo.product"]],
  "odoo.stock.adjust": [["product_id", "odoo.product"]],
  "odoo.order.confirm": [["id", "odoo.order"]],
  "odoo.order.cancel": [["id", "odoo.order"]],
  "odoo.quote.update": [["id", "odoo.order"]],
  "odoo.quote.send": [["id", "odoo.order"]],
  "odoo.quote.create": [["partner_id", "odoo.customer"]],
  "odoo.invoice.create": [["order_id", "odoo.order"]],
  "odoo.customer.update": [["id", "odoo.customer"]],
};

/**
 * The records a proposal is about, as card references, so an approval shows what it would
 * change (the product whose price moves, the order being cancelled) and not just its id.
 * From the action type and the ids in its payload; empty when it names no record with a card.
 */
export function proposalCardRefs(actionType: string, payload: Record<string, unknown>): string[] {
  const id = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? String(v) : typeof v === "string" && /^\d+$/.test(v) ? v : null);
  const refs: string[] = [];
  for (const [key, kind] of PROPOSAL_RECORDS[actionType] ?? []) {
    const n = id(payload[key]);
    if (n) refs.push(`${kind}:${n}`);
  }
  // Chatter posts and generic record actions say which model they act on.
  const kind = typeof payload.model === "string" ? ODOO_MODEL_KINDS[payload.model] : undefined;
  if (kind && actionType.startsWith("odoo.")) {
    const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id];
    for (const v of ids.slice(0, 4)) {
      const n = id(v);
      if (n) refs.push(`${kind}:${n}`);
    }
  }
  return [...new Set(refs)];
}
