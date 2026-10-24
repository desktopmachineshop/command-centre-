import type { Event } from "@cc/core";
import { formatMoney } from "@cc/odoo";

/** The Odoo part of a vertical's daily digest, built from the day's Odoo events. */
export interface OdooDigest {
  orders: number;
  /** Order totals by currency code ("" when the order had none). */
  revenue: Record<string, number>;
  /** e.g. "£412.50" or "£412.50 + €80.00". */
  revenueText: string;
  orderList: { name: string; customer: string | null; amount: string }[];
  lowStock: { id: number; name: string; sku: string | null; qtyAvailable: number | null; threshold: number | null }[];
  lateDeliveries: { name: string; order: string | null; customer: string | null; scheduledDate: string | null }[];
  messages: number;
  reviews: { rating: number | null; on: string | null; customer: string | null }[];
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nameOf = (v: unknown): string | null => s((v as { name?: unknown } | null)?.name);

/** Null when the day had no Odoo events. */
export function summariseOdooEvents(events: Event[]): OdooDigest | null {
  if (!events.length) return null;
  const d: OdooDigest = { orders: 0, revenue: {}, revenueText: "", orderList: [], lowStock: [], lateDeliveries: [], messages: 0, reviews: [] };
  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case "order.created": {
        d.orders++;
        const currency = s(p.currency) ?? "";
        d.revenue[currency] = (d.revenue[currency] ?? 0) + (n(p.amount) ?? 0);
        d.orderList.push({ name: s(p.name) ?? `#${p.id}`, customer: nameOf(p.customer), amount: formatMoney(p.amount, currency) });
        break;
      }
      case "stock.low":
        d.lowStock.push({ id: n(p.id) ?? 0, name: s(p.name) ?? `product ${p.id}`, sku: s(p.sku), qtyAvailable: n(p.qtyAvailable), threshold: n(p.threshold) });
        break;
      case "delivery.late":
        d.lateDeliveries.push({ name: s(p.name) ?? `picking ${p.id}`, order: nameOf(p.order), customer: nameOf(p.customer), scheduledDate: s(p.scheduledDate) });
        break;
      case "message.received":
        d.messages++;
        break;
      case "review.received":
        d.reviews.push({ rating: n(p.rating), on: s(p.recordName), customer: nameOf(p.customer) });
        break;
    }
  }
  d.revenueText = Object.entries(d.revenue).map(([currency, total]) => formatMoney(total, currency)).join(" + ") || formatMoney(0);
  return d;
}

/** Short headline part, e.g. "3 orders £412.50, 1 low stock". */
export function odooHeadline(d: OdooDigest | null): string[] {
  if (!d) return [];
  const parts: string[] = [];
  if (d.orders) parts.push(`${d.orders} order${d.orders === 1 ? "" : "s"} ${d.revenueText}`);
  if (d.lowStock.length) parts.push(`${d.lowStock.length} low stock`);
  if (d.lateDeliveries.length) parts.push(`${d.lateDeliveries.length} late`);
  return parts;
}

/** The digest note's "Odoo" section. */
export function renderOdooDigest(d: OdooDigest | null): string[] {
  if (!d) return [];
  const lines = ["", "## Odoo", "", `- Orders: ${d.orders}, revenue ${d.revenueText}`];
  for (const o of d.orderList) lines.push(`  - ${o.name}${o.customer ? `, ${o.customer}` : ""}: ${o.amount}`);
  if (d.messages) lines.push(`- Customer messages and tickets: ${d.messages}`);
  if (d.lowStock.length) {
    lines.push(`- Low stock: ${d.lowStock.length}`);
    for (const p of d.lowStock) lines.push(`  - ${p.name}${p.sku ? ` (${p.sku})` : ""}: ${p.qtyAvailable ?? "?"} on hand, below ${p.threshold ?? "?"}`);
  }
  if (d.lateDeliveries.length) {
    lines.push(`- Late deliveries: ${d.lateDeliveries.length}`);
    for (const l of d.lateDeliveries) {
      lines.push(`  - ${l.name}${l.order ? ` (${l.order})` : ""}${l.customer ? `, ${l.customer}` : ""}${l.scheduledDate ? `: due ${l.scheduledDate.slice(0, 10)}` : ""}`);
    }
  }
  if (d.reviews.length) {
    lines.push(`- Reviews: ${d.reviews.length}`);
    for (const r of d.reviews) lines.push(`  - ${r.rating ?? "?"}/5${r.on ? ` on ${r.on}` : ""}${r.customer ? ` from ${r.customer}` : ""}`);
  }
  return lines;
}
