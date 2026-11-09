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
