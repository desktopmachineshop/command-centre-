import type { SendcloudParcel } from "./client";
import { type ParcelState, parcelState, parseSendcloudDate } from "./status";

/** One parcel line in the digest. */
export interface ParcelLine {
  id: number;
  state: ParcelState;
  recipient: string | null;
  order: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Sendcloud's status text, e.g. "Delivery attempt failed". */
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Whole days since the last status change. */
  daysSinceUpdate: number | null;
  /** Why it is under problems when the status itself looks fine, e.g. "no tracking update for 6 days". */
  note?: string;
}

/** The Shipping part of a business's daily digest. */
export interface ShippingDigest {
  /** Parcels delivered (or collected) during the digest day. */
  deliveredToday: ParcelLine[];
  /** Needs a look: carrier problems, returns, and parcels that have stopped moving. */
  problems: ParcelLine[];
  /** At a service point or locker, waiting for the customer. */
  atPickupPoint: ParcelLine[];
  /** With the carrier and moving. */
  inTransit: ParcelLine[];
  /** Label made over a day ago, still not scanned by the carrier. */
  notCollected: ParcelLine[];
  /** Labels made today, waiting for the carrier. */
  labelsToday: number;
  /** Accounts that couldn't be read, e.g. "dms-sendcloud: Sendcloud rejected the API keys". */
  errors: string[];
}

export interface SummariseOptions {
  /** The digest day, [start, end). */
  start: Date;
  end: Date;
  /** Now; default `end`. */
  now?: Date;
  /** In transit with no update for this many days counts as a problem. Default 5. */
  stalledDays?: number;
}

const DAY = 86_400_000;
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function line(p: SendcloudParcel, state: ParcelState, now: Date): ParcelLine {
  const created = parseSendcloudDate(p.date_created);
  const updated = parseSendcloudDate(p.date_updated) ?? created;
  return {
    id: p.id,
    state,
    recipient: text(p.company_name) ?? text(p.name),
    order: text(p.order_number) ?? text(p.external_reference),
    carrier: text(p.carrier?.code),
    trackingNumber: text(p.tracking_number),
    trackingUrl: text(p.tracking_url),
    status: text(p.status?.message) ?? "unknown",
    createdAt: created?.toISOString() ?? null,
    updatedAt: updated?.toISOString() ?? null,
    daysSinceUpdate: updated ? Math.max(0, Math.floor((now.getTime() - updated.getTime()) / DAY)) : null,
  };
}

/**
 * Sorts recent parcels into the digest's buckets. Null when there is nothing to say (no
 * parcels in flight, none delivered today, no errors), so a quiet day adds no section.
 */
export function summariseParcels(parcels: SendcloudParcel[], options: SummariseOptions, errors: string[] = []): ShippingDigest | null {
  const now = options.now ?? options.end;
  const stalled = options.stalledDays ?? 5;
  const d: ShippingDigest = { deliveredToday: [], problems: [], atPickupPoint: [], inTransit: [], notCollected: [], labelsToday: 0, errors };
  const seen = new Set<number>();
  for (const p of parcels) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const state = parcelState(p);
    const l = line(p, state, now);
    const updated = l.updatedAt ? new Date(l.updatedAt) : null;
    const created = l.createdAt ? new Date(l.createdAt) : null;
    switch (state) {
      case "cancelled":
        break;
      case "delivered":
        if (updated && updated >= options.start && updated < options.end) d.deliveredToday.push(l);
        break;
      case "problem":
        d.problems.push(l);
        break;
      case "pickup_point":
        d.atPickupPoint.push(l);
        break;
      case "label":
        if (created && created >= options.start) d.labelsToday++;
        else if (created && now.getTime() - created.getTime() > DAY) d.notCollected.push(l);
        else d.labelsToday++;
        break;
      case "in_transit":
        if (l.daysSinceUpdate !== null && l.daysSinceUpdate >= stalled) d.problems.push({ ...l, note: `no tracking update for ${l.daysSinceUpdate} days` });
        else d.inTransit.push(l);
        break;
    }
  }
  const oldestFirst = (a: ParcelLine, b: ParcelLine) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
  for (const list of [d.problems, d.atPickupPoint, d.inTransit, d.notCollected]) list.sort(oldestFirst);
  const empty = !d.deliveredToday.length && !d.problems.length && !d.atPickupPoint.length && !d.inTransit.length && !d.notCollected.length && !d.labelsToday && !d.errors.length;
  return empty ? null : d;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Short headline parts, e.g. ["2 delivered", "5 in transit", "1 shipping problem"]. */
export function shippingHeadline(d: ShippingDigest | null): string[] {
  if (!d) return [];
  const parts: string[] = [];
  if (d.deliveredToday.length) parts.push(`${d.deliveredToday.length} delivered`);
  if (d.inTransit.length) parts.push(`${d.inTransit.length} in transit`);
  if (d.problems.length) parts.push(plural(d.problems.length, "shipping problem"));
  if (d.errors.length && !d.problems.length) parts.push("Sendcloud unreachable");
  return parts;
}

function describe(l: ParcelLine): string {
  const who = [l.order, l.recipient].filter(Boolean).join(", ") || `parcel ${l.id}`;
  const tracking = l.trackingNumber ? (l.trackingUrl ? `[${l.trackingNumber}](${l.trackingUrl})` : l.trackingNumber) : null;
  const via = [l.carrier, tracking].filter(Boolean).join(" ");
  const age = l.daysSinceUpdate ? ` (${l.daysSinceUpdate}d since last update)` : "";
  return `${who}${via ? `: ${via}` : ""}, ${l.note ?? l.status}${l.note ? ` (last: ${l.status})` : age}`;
}

/** The digest note's "Shipping (Sendcloud)" section. */
export function renderShippingDigest(d: ShippingDigest | null): string[] {
  if (!d) return [];
  const lines = [
    "",
    "## Shipping (Sendcloud)",
    "",
    `- ${d.deliveredToday.length} delivered today · ${d.inTransit.length} in transit · ${d.atPickupPoint.length} at a pickup point · ${plural(d.problems.length, "problem")}${d.labelsToday ? ` · ${plural(d.labelsToday, "label")} made today` : ""}`,
  ];
  const group = (title: string, items: ParcelLine[]) => {
    if (!items.length) return;
    lines.push(`- ${title}: ${items.length}`);
    for (const l of items) lines.push(`  - ${describe(l)}`);
  };
  for (const e of d.errors) lines.push(`- Couldn't read ${e}`);
  group("Needs a look", d.problems);
  group("Not picked up by the carrier yet", d.notCollected);
  group("Waiting at a pickup point", d.atPickupPoint);
  group("Delivered today", d.deliveredToday);
  group("In transit", d.inTransit);
  return lines;
}
