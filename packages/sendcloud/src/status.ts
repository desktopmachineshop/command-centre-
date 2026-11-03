import type { SendcloudParcel } from "./client";

/**
 * Where a parcel is, in the buckets the digest reports. Sendcloud has dozens of status ids
 * (and carriers add their own wording), so known ids decide first and the message text second.
 *
 * - `label`: label made, not yet scanned by the carrier
 * - `in_transit`: with the carrier
 * - `pickup_point`: waiting at a service point / locker for the customer
 * - `delivered`: delivered or collected by the customer
 * - `problem`: delayed, failed delivery, exception, lost, returning to sender, announcement failed
 * - `cancelled`: cancelled (not reported)
 */
export type ParcelState = "label" | "in_transit" | "pickup_point" | "delivered" | "problem" | "cancelled";

const BY_ID: Record<number, ParcelState> = {
  // label made, not with the carrier yet
  0: "label", // Ready to send (older accounts)
  1: "label", // Announced
  13: "label", // Announced: not collected
  999: "label", // No label
  1000: "label", // Ready to send
  1001: "label", // Being announced
  // in transit
  3: "in_transit", // En route to sorting center
  5: "in_transit", // Sorted
  7: "in_transit", // Being sorted
  22: "in_transit", // Shipment picked up by driver
  91: "in_transit", // Parcel en route
  // waiting for the customer
  12: "pickup_point", // Awaiting customer pickup
  // done
  11: "delivered", // Delivered
  93: "delivered", // Shipment collected by customer
  // problems
  4: "problem", // Delivery delayed
  6: "problem", // Not sorted
  8: "problem", // Delivery attempt failed
  15: "problem", // Error collecting
  62: "problem", // Unable to deliver
  80: "problem", // Unable to deliver
  1002: "problem", // Announcement failed
  // cancelled
  1998: "cancelled", // Cancelled upstream
  1999: "cancelled", // Cancellation requested
  2000: "cancelled", // Cancelled
  2001: "cancelled", // Submitting cancellation request
};

export function parcelState(parcel: Pick<SendcloudParcel, "status">): ParcelState {
  const message = (parcel.status?.message ?? "").toLowerCase();
  // Text that is unambiguous wins over the id, which carriers sometimes reuse.
  if (/cancel/.test(message)) return "cancelled";
  if (/return(ed|ing)? to sender|exception|lost|damaged|refused|undeliverable|unable to deliver|failed|delayed|address (invalid|incorrect)|error/.test(message)) return "problem";
  if (/delivered|collected by (the )?customer|picked up by (the )?(customer|recipient)/.test(message)) return "delivered";
  const id = parcel.status?.id;
  if (typeof id === "number" && BY_ID[id]) return BY_ID[id];
  if (/awaiting (customer )?pick ?up|service ?point|parcel ?shop|locker|ready for pick ?up/.test(message)) return "pickup_point";
  if (/ready to send|announced|no label|being announced/.test(message)) return "label";
  return "in_transit";
}

/**
 * Sendcloud's "DD-MM-YYYY HH:MM:SS" dates, read as Europe/Amsterdam time (where Sendcloud
 * keeps them). ISO strings are accepted too. Null when unparseable.
 */
export function parseSendcloudDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const asUtc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss ?? 0));
  return new Date(asUtc - amsterdamOffsetMs(new Date(asUtc)));
}

/** Europe/Amsterdam's UTC offset at about that moment (CET/CEST). */
function amsterdamOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", timeZoneName: "shortOffset" }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
}
