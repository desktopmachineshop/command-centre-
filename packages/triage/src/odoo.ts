import type { Event, NotificationCategory, Route, TriageResult } from "@cc/core";
import type { TriageContext } from "./triager";

/** Intents for Odoo events (see @cc/odoo events.ts). Verticals that take Odoo events list them. */
export const ODOO_INTENTS = {
  "order.created": "new-order",
  "message.received": "customer-message",
  "stock.low": "stock-low",
  "delivery.late": "delivery-late",
  "review.received": "review",
  "rfq.received": "rfq",
  "purchase.reply": "supplier-reply",
} as const;

const RULES: Record<keyof typeof ODOO_INTENTS, { route: Route; urgency: number; notes: string; push?: NotificationCategory }> = {
  "order.created": { route: "file", urgency: 0.2, notes: "New order: journal and daily digest, no agent" },
  "message.received": { route: "agent", urgency: 0.7, notes: "Customer message: draft a reply" },
  // Stock and delivery status are Dave's daily buying and dispatch list (the digest), not a task each.
  "stock.low": { route: "file", urgency: 0.3, notes: "Low stock: on the daily digest's buying list, no agent" },
  "delivery.late": { route: "file", urgency: 0.3, notes: "Late delivery: on the daily digest, no agent" },
  "review.received": { route: "agent", urgency: 0.4, notes: "Review: draft a reply" },
  // Quotes and purchasing reach Dave one at a time, straight away; he answers them himself.
  "rfq.received": { route: "file", urgency: 0.8, notes: "Incoming RFQ: pushed to Dave now", push: "quotes" },
  "purchase.reply": { route: "file", urgency: 0.8, notes: "Supplier reply on an RFQ or PO: pushed to Dave now", push: "quotes" },
};

/**
 * Odoo events are already classified by the poller, so their route and intent
 * follow from the kind with no model call. New orders, low stock and late
 * deliveries are only filed for the daily digest (a big order's `attention`
 * flag is listed there, not investigated). RFQs and supplier replies are filed
 * and pushed. Poor reviews are more urgent.
 */
export function triageOdooEvent(event: Event, context: TriageContext, triager: string): TriageResult | null {
  const kind = event.kind as keyof typeof ODOO_INTENTS;
  const rule = RULES[kind];
  if (!rule) return null;
  const known = event.vertical ? context.verticals.find((v) => v.id === event.vertical) : undefined;
  const vertical = known?.id ?? context.verticals.find((v) => v.id === "dms")?.id ?? context.defaultVertical;
  const { route } = rule;
  let { urgency, notes } = rule;
  const rating = event.payload.rating;
  if (kind === "review.received" && typeof rating === "number" && rating <= 2) {
    urgency = 0.7;
    notes = "Poor review: find out what went wrong and draft an apology";
  }
  return { vertical, intent: ODOO_INTENTS[kind], urgency, route, confidence: 1, triager, notes, ...(rule.push ? { push: rule.push } : {}) };
}
