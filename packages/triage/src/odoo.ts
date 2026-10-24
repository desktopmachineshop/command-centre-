import type { Event, Route, TriageResult } from "@cc/core";
import type { TriageContext } from "./triager";

/** Intents for Odoo events (see @cc/odoo events.ts). Verticals that take Odoo events list them. */
export const ODOO_INTENTS = {
  "order.created": "new-order",
  "message.received": "customer-message",
  "stock.low": "stock-low",
  "delivery.late": "delivery-late",
  "review.received": "review",
} as const;

const RULES: Record<keyof typeof ODOO_INTENTS, { route: Route; urgency: number; notes: string }> = {
  "order.created": { route: "file", urgency: 0.2, notes: "New order: journal and digest, no agent" },
  "message.received": { route: "agent", urgency: 0.7, notes: "Customer message: draft a reply" },
  "stock.low": { route: "agent", urgency: 0.5, notes: "Low stock: draft a reorder suggestion" },
  "delivery.late": { route: "agent", urgency: 0.7, notes: "Late delivery: check it and draft an apology" },
  "review.received": { route: "agent", urgency: 0.4, notes: "Review: draft a reply" },
};

/**
 * Odoo events are already classified by the poller, so their route and intent
 * follow from the kind with no model call. A new order is only filed, unless
 * the poller flagged it (`payload.attention`, e.g. over the big-order
 * threshold), when an agent takes a look. Poor reviews are more urgent.
 */
export function triageOdooEvent(event: Event, context: TriageContext, triager: string): TriageResult | null {
  const kind = event.kind as keyof typeof ODOO_INTENTS;
  const rule = RULES[kind];
  if (!rule) return null;
  const known = event.vertical ? context.verticals.find((v) => v.id === event.vertical) : undefined;
  const vertical = known?.id ?? context.verticals.find((v) => v.id === "dms")?.id ?? context.defaultVertical;
  let { route, urgency, notes } = rule;

  const attention = Array.isArray(event.payload.attention) ? (event.payload.attention as unknown[]).filter((a) => typeof a === "string") : [];
  if (kind === "order.created" && attention.length) {
    route = "agent";
    urgency = 0.6;
    notes = `Order flagged for a look: ${attention.join("; ")}`;
  }
  const rating = event.payload.rating;
  if (kind === "review.received" && typeof rating === "number" && rating <= 2) {
    urgency = 0.7;
    notes = "Poor review: find out what went wrong and draft an apology";
  }
  return { vertical, intent: ODOO_INTENTS[kind], urgency, route, confidence: 1, triager, notes };
}
