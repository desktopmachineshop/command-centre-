import type { SendcloudParcel } from "./client";
import { type ParcelState, parseSendcloudDate } from "./status";

/**
 * The internal notes Command Centre logs on a parcel's Odoo delivery order: one per change
 * that matters (picked up by the carrier, waiting at a pickup point, delivered, a problem,
 * cancelled) and one when a parcel stops moving. HTML, for Odoo's chatter; staff only.
 */
export type NoteKind = Exclude<ParcelState, "label"> | "stalled";

export interface NoteOptions {
  /** Business timezone for the times shown. Default Europe/London. */
  timeZone?: string;
  /** For "stalled": whole days since the last tracking update. */
  daysSinceUpdate?: number;
}

const CARRIERS: Record<string, string> = {
  royal_mail: "Royal Mail",
  royalmailv2: "Royal Mail",
  parcelforce: "Parcelforce",
  dpd: "DPD",
  dpd_gb: "DPD",
  dhl: "DHL",
  dhl_express: "DHL Express",
  ups: "UPS",
  fedex: "FedEx",
  evri: "Evri",
  hermes_gb: "Evri",
  yodel: "Yodel",
  gls: "GLS",
  postnl: "PostNL",
  bpost: "bpost",
  colissimo: "Colissimo",
  sendcloud: "Sendcloud",
};

/** "royal_mail" → "Royal Mail"; unknown codes are tidied ("inpost_uk" → "Inpost UK"). */
export function carrierName(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = CARRIERS[code.toLowerCase()];
  if (known) return known;
  return code
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function when(d: Date | null, timeZone: string): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function days(ms: number): string {
  const d = Math.max(0, Math.round(ms / 86_400_000));
  return d === 0 ? "the same day" : d === 1 ? "1 day" : `${d} days`;
}

/** The note for `kind`, as chatter HTML. */
export function parcelNote(parcel: SendcloudParcel, kind: NoteKind, options: NoteOptions = {}): string {
  const tz = options.timeZone ?? "Europe/London";
  const carrier = carrierName(text(parcel.carrier?.code)) ?? "The carrier";
  const status = text(parcel.status?.message);
  const updated = parseSendcloudDate(parcel.date_updated);
  const created = parseSendcloudDate(parcel.date_created);
  const said = status ? ` (${esc(carrier)}: “${esc(status)}”)` : "";

  let headline: string;
  let hint: string | null = null;
  switch (kind) {
    case "in_transit":
      headline = `🚚 <b>On its way</b>: ${esc(carrier)} has the parcel${status ? ` (“${esc(status)}”)` : ""}.`;
      break;
    case "pickup_point":
      headline = `📍 <b>Waiting at a pickup point</b> for the customer to collect${said}.`;
      hint = "Carriers usually send it back if it isn't collected within a week or two.";
      break;
    case "delivered": {
      const took = updated && created ? `, ${days(updated.getTime() - created.getTime())} after the label was made` : "";
      headline = `✅ <b>Delivered</b>${updated ? ` ${esc(when(updated, tz)!)}` : ""}${took}${said}.`;
      break;
    }
    case "problem":
      headline = `⚠️ <b>Delivery problem</b>: ${esc(status ?? "the carrier reported a problem")}.`;
      hint = "Check the tracking, and contact the customer or the carrier if it needs sorting out.";
      break;
    case "cancelled":
      headline = `✖️ <b>Label cancelled</b> in Sendcloud${status ? ` (“${esc(status)}”)` : ""}.`;
      break;
    case "stalled": {
      const n = options.daysSinceUpdate;
      headline = `⏳ <b>No tracking update for ${n ?? "several"} day${n === 1 ? "" : "s"}</b>${status ? `: last status “${esc(status)}”` : ""}.`;
      hint = `It may be stuck. Check with ${esc(carrier)} if it doesn't move soon.`;
      break;
    }
  }

  const tracking = text(parcel.tracking_number);
  const url = text(parcel.tracking_url);
  const facts = [
    tracking ? `Tracking: ${url && /^https?:\/\//.test(url) ? `<a href="${esc(url)}">${esc(tracking)}</a>` : esc(tracking)}` : url ? `<a href="${esc(url)}">Tracking</a>` : null,
    kind !== "delivered" && updated ? `Updated ${esc(when(updated, tz)!)}` : null,
  ].filter(Boolean);

  return [
    `<p>${headline}</p>`,
    hint ? `<p>${hint}</p>` : null,
    facts.length ? `<p>${facts.join(" · ")}</p>` : null,
    `<p><i>From Sendcloud, via Command Centre</i></p>`,
  ]
    .filter(Boolean)
    .join("");
}
