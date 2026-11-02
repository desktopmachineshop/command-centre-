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
  /** Incoming RFQs (CRM leads) today; each was also pushed when it arrived. */
  rfqs: { name: string; from: string | null }[];
  /** Supplier replies on RFQs and purchase orders today; each was also pushed. */
  supplierReplies: { order: string; supplier: string | null }[];
  /** Every outgoing delivery late right now. */
  lateNow: OdooLateNow[];
}

/** One product low right now, from the stock poller's checkpoint. */
export interface OdooStockNow {
  id: number;
  name: string;
  sku: string | null;
  qtyAvailable: number | null;
  incomingQty: number | null;
  threshold: number | null;
  vertical: string;
}

/** One delivery late right now, from the deliveries poller's checkpoint. */
export interface OdooLateNow {
  id: number;
  name: string;
  state: string | null;
  scheduledDate: string | null;
  order: string | null;
  customer: string | null;
  vertical: string;
}

/** What the Odoo pollers last saw as low and late, across every vertical. */
export interface OdooSnapshot {
  lowStock: OdooStockNow[];
  lateDeliveries: OdooLateNow[];
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nameOf = (v: unknown): string | null => s((v as { name?: unknown } | null)?.name);

/**
 * A vertical's Odoo section: the day's events plus, from `snapshot`, what is
 * low and late right now. Null when there is neither.
 */
export function summariseOdooEvents(events: Event[], snapshot: OdooSnapshot | null = null, vertical?: string): OdooDigest | null {
  const lateNow = (snapshot?.lateDeliveries ?? []).filter((p) => !vertical || p.vertical === vertical);
  // Low stock is not here: it goes on the weekly low-stock summary (renderLowStockSummary).
  if (!events.some((e) => e.kind !== "stock.low") && !lateNow.length) return null;
  const d: OdooDigest = { orders: 0, revenue: {}, revenueText: "", orderList: [], lowStock: [], lateDeliveries: [], messages: 0, reviews: [], rfqs: [], supplierReplies: [], lateNow };
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
      case "rfq.received":
        d.rfqs.push({ name: s(p.name) ?? `lead ${p.id}`, from: s(p.company) ?? nameOf(p.customer) });
        break;
      case "purchase.reply":
        d.supplierReplies.push({ order: s(p.recordName) ?? `PO ${p.resId}`, supplier: s(p.supplier) });
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
  if (d.rfqs.length) parts.push(`${d.rfqs.length} RFQ${d.rfqs.length === 1 ? "" : "s"}`);
  if (d.lateNow.length) parts.push(`${d.lateNow.length} late`);
  return parts;
}

/** The digest note's "Odoo" section. */
export function renderOdooDigest(d: OdooDigest | null): string[] {
  if (!d) return [];
  const lines = ["", "## Odoo", "", `- Confirmed sales: ${d.orders}, revenue ${d.revenueText}`];
  for (const o of d.orderList) lines.push(`  - ${o.name}${o.customer ? `, ${o.customer}` : ""}: ${o.amount}`);
  if (d.rfqs.length) {
    lines.push(`- RFQs received: ${d.rfqs.length}`);
    for (const r of d.rfqs) lines.push(`  - ${r.name}${r.from ? `, ${r.from}` : ""}`);
  }
  if (d.supplierReplies.length) {
    lines.push(`- Supplier replies: ${d.supplierReplies.length}`);
    for (const r of d.supplierReplies) lines.push(`  - ${r.order}${r.supplier ? `, ${r.supplier}` : ""}`);
  }
  if (d.messages) lines.push(`- Customer messages and tickets: ${d.messages}`);
  if (d.lateNow.length) {
    lines.push(`- Late deliveries (not shipped, past their date): ${d.lateNow.length}`);
    for (const l of d.lateNow) {
      lines.push(`  - ${l.name}${l.order ? ` (${l.order})` : ""}${l.customer ? `, ${l.customer}` : ""}${l.scheduledDate ? `: due ${l.scheduledDate.slice(0, 10)}` : ""}${l.state ? `, ${l.state}` : ""}`);
    }
  }
  if (d.reviews.length) {
    lines.push(`- Reviews: ${d.reviews.length}`);
    for (const r of d.reviews) lines.push(`  - ${r.rating ?? "?"}/5${r.on ? ` on ${r.on}` : ""}${r.customer ? ` from ${r.customer}` : ""}`);
  }
  return lines;
}

/** The weekly low-stock note: every product below its reorder level now, nothing on order first. */
export function renderLowStockSummary(name: string, day: string, items: OdooStockNow[]): string {
  const none = items.filter((p) => !p.incomingQty);
  const incoming = items.filter((p) => p.incomingQty);
  const line = (p: OdooStockNow) =>
    `- ${p.name}${p.sku ? ` (${p.sku})` : ""}: ${p.qtyAvailable ?? "?"} on hand, reorder level ${p.threshold ?? "?"}${p.incomingQty ? `, ${p.incomingQty} incoming` : ""}`;
  const lines = [`# ${name} low stock, week of ${day}`, "", `**${items.length} below reorder level · ${none.length} with nothing on order**`];
  if (none.length) lines.push("", "## To order", "", ...none.map(line));
  if (incoming.length) lines.push("", "## Already on order", "", ...incoming.map(line));
  return `${lines.join("\n")}\n`;
}
