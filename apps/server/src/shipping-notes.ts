import { Cron } from "croner";
import { type Domain, type OdooCheckpointStore, type OdooClient, postMessage } from "@cc/odoo";
import {
  type NoteKind,
  type ParcelState,
  parcelNote,
  parcelState,
  parseSendcloudDate,
  type SendcloudAccount,
  type SendcloudClient,
  type SendcloudParcel,
  type ShippingService,
} from "@cc/sendcloud";

/**
 * Sendcloud tracking → internal notes on Odoo delivery orders.
 *
 * At 08:00, 12:00 and 17:00 (business time; `schedule`) each Sendcloud account (with `odooNotes` not switched off) is asked for
 * parcels updated since the last check. A parcel whose state changes (picked up by the carrier,
 * at a pickup point, delivered, a problem, cancelled), or whose problem changes, gets an internal
 * note on its outgoing stock.picking, found by tracking number, then by order number as the
 * picking's name or origin. A parcel in transit with no update for `stalledDays` gets one note
 * too. Notes are staff-only (mail.mt_note): nothing is emailed to the customer.
 *
 * What each parcel last looked like is kept in a checkpoint per account. The first check, or one
 * after more than `rebaselineAfterMs` without a check, only records where parcels are, so a
 * backlog is never posted.
 */

export type OdooNoteWriter = Pick<OdooClient, "call" | "searchRead" | "fields">;

/** What's kept per parcel: enough to compare the next status and to write a stalled note. */
interface Tracked {
  state: ParcelState;
  updatedAt: string | null;
  /** The delivery order found for it (looked up again while unknown). */
  picking?: number;
  /** The stalled note was posted for this update. */
  stalled?: true;
  parcel: SendcloudParcel;
}

export interface ShippingNotesLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface ShippingNotesOptions {
  shipping: () => ShippingService | null;
  odoo: () => OdooNoteWriter | undefined;
  store: OdooCheckpointStore;
  /** Business timezone for times in the notes. */
  timeZone: string;
  /** When to check, a cron expression in `timeZone`. Default 08:00, 12:00 and 17:00 every day. */
  schedule?: string;
  /** In transit with no update for this many days gets a "may be stuck" note. Default 5. */
  stalledDays?: number;
  /** How far back the first check looks. Default 30 days. */
  lookbackDays?: number;
  /** Each check re-reads this far before the last one, for late updates. Default 10 minutes. */
  overlapMs?: number;
  /** A gap longer than this since the last check starts afresh instead of posting the backlog. Default 2 days. */
  rebaselineAfterMs?: number;
  logger?: ShippingNotesLogger;
  now?: () => Date;
}

export interface ShippingNotesResult {
  account: string;
  posted: number;
  failed: number;
  baseline?: true;
}

const DAY = 86_400_000;
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The parcel fields a note needs, so the checkpoint stays small. */
function slim(p: SendcloudParcel): SendcloudParcel {
  return {
    id: p.id,
    order_number: p.order_number ?? null,
    external_reference: p.external_reference ?? null,
    tracking_number: p.tracking_number ?? null,
    tracking_url: p.tracking_url ?? null,
    carrier: p.carrier?.code ? { code: p.carrier.code } : null,
    status: p.status ?? null,
    date_created: p.date_created ?? null,
    date_updated: p.date_updated ?? null,
  };
}

export class ShippingNotes {
  private readonly abort = new AbortController();
  private cron?: Cron;
  private running: Promise<unknown> = Promise.resolve();
  private readonly log: ShippingNotesLogger;
  private readonly now: () => Date;

  constructor(private readonly options: ShippingNotesOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? {
      info: (m) => console.log(`[shipping-notes] ${m}`),
      error: (m, err) => console.error(`[shipping-notes] ${m}`, err ?? ""),
    };
  }

  start(): void {
    if (this.cron || this.abort.signal.aborted) return;
    this.cron = new Cron(this.options.schedule ?? "0 8,12,17 * * *", { timezone: this.options.timeZone, protect: true }, async () => {
      await this.pollOnce().catch((err) => this.log.error(`check failed: ${(err as Error).message}`, err));
    });
  }

  /** When the next scheduled check runs (null until started). */
  nextCheck(): Date | null {
    return this.cron?.nextRun() ?? null;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.cron?.stop();
    await this.running.catch(() => undefined);
  }

  /** One check of every account, queued behind any check already running. */
  pollOnce(): Promise<ShippingNotesResult[]> {
    const next = this.running.catch(() => undefined).then(() => this.poll());
    this.running = next;
    return next;
  }

  private async poll(): Promise<ShippingNotesResult[]> {
    const shipping = this.options.shipping();
    const odoo = this.options.odoo();
    if (!shipping || !odoo) return [];
    const out: ShippingNotesResult[] = [];
    for (const { account, client } of shipping.clients) {
      if (account.odooNotes === false || this.abort.signal.aborted) continue;
      try {
        out.push(await this.pollAccount(account, client, odoo));
      } catch (err) {
        this.log.error(`${account.id}: ${(err as Error).message}`, err);
        out.push({ account: account.id, posted: 0, failed: 1 });
      }
    }
    return out;
  }

  private async pollAccount(account: SendcloudAccount, client: SendcloudClient, odoo: OdooNoteWriter): Promise<ShippingNotesResult> {
    const key = `sendcloud:${account.id}:odoo-notes`;
    const store = this.options.store;
    const now = this.now();
    const checkpoint = await store.getOdooCheckpoint(key);
    const last = checkpoint?.cursor ? Date.parse(checkpoint.cursor) : Number.NaN;
    const baseline = !Number.isFinite(last) || now.getTime() - last > (this.options.rebaselineAfterMs ?? 2 * DAY);
    const since = baseline ? new Date(now.getTime() - (this.options.lookbackDays ?? 30) * DAY) : new Date(last - (this.options.overlapMs ?? 10 * 60_000));
    const parcels = await client.listParcels({ updatedAfter: since });
    const tracked: Record<string, Tracked> = baseline ? {} : { ...((checkpoint?.state.parcels ?? {}) as Record<string, Tracked>) };
    let posted = 0;
    let failed = 0;

    const note = async (key: string, entry: Tracked, kind: NoteKind, daysSinceUpdate?: number): Promise<boolean> => {
      try {
        entry.picking ??= (await this.findPicking(odoo, entry.parcel)) ?? undefined;
        if (!entry.picking) {
          this.log.info(`${account.id}: no Odoo delivery order for parcel ${entry.parcel.id} (${text(entry.parcel.order_number) ?? text(entry.parcel.tracking_number) ?? "no reference"}); no note`);
          return true;
        }
        await postMessage(odoo, "stock.picking", entry.picking, parcelNote(entry.parcel, kind, { timeZone: this.options.timeZone, daysSinceUpdate }), true);
        posted++;
        return true;
      } catch (err) {
        failed++;
        this.log.error(`${account.id}: parcel ${key}: could not post to Odoo: ${(err as Error).message}`, err);
        return false;
      }
    };

    for (const p of parcels) {
      const id = String(p.id);
      const state = parcelState(p);
      const updatedAt = parseSendcloudDate(p.date_updated)?.toISOString() ?? null;
      const before = tracked[id];
      const entry: Tracked = { state, updatedAt, parcel: slim(p), ...(before?.picking ? { picking: before.picking } : {}) };
      if (before?.stalled && before.updatedAt === updatedAt) entry.stalled = true;
      const changed = !before ? state !== "label" : before.state !== state || (state === "problem" && text(before.parcel.status?.message) !== text(p.status?.message));
      if (baseline || !changed || state === "label") {
        tracked[id] = entry;
        continue;
      }
      // A failed post keeps the old entry, so the next check tries again.
      if (await note(id, entry, state as NoteKind)) tracked[id] = entry;
      else if (!before) tracked[id] = { ...entry, state: "label" };
    }

    // Parcels in transit that have stopped moving: one note per stall.
    const stalledMs = (this.options.stalledDays ?? 5) * DAY;
    if (!baseline) {
      for (const [id, entry] of Object.entries(tracked)) {
        if (entry.state !== "in_transit" || entry.stalled || !entry.updatedAt) continue;
        const quiet = now.getTime() - Date.parse(entry.updatedAt);
        if (quiet < stalledMs) continue;
        if (await note(id, entry, "stalled", Math.floor(quiet / DAY))) entry.stalled = true;
      }
    }

    // Forget parcels that are finished, or that haven't changed in two months.
    for (const [id, entry] of Object.entries(tracked)) {
      const age = entry.updatedAt ? now.getTime() - Date.parse(entry.updatedAt) : Number.POSITIVE_INFINITY;
      if (age > 60 * DAY || ((entry.state === "delivered" || entry.state === "cancelled") && age > 14 * DAY)) delete tracked[id];
    }

    // After a failure the cursor stays put, so the parcels are read again next time.
    const cursor = failed && !baseline ? checkpoint!.cursor : now.toISOString();
    await store.saveOdooCheckpoint(key, { cursor, seenIds: [], state: { parcels: tracked } });
    if (baseline) this.log.info(`${account.id}: started tracking ${Object.keys(tracked).length} parcel(s); notes from the next change`);
    return { account: account.id, posted, failed, ...(baseline ? { baseline: true as const } : {}) };
  }

  /** The outgoing delivery order for a parcel: by tracking number, then by order number. */
  private async findPicking(odoo: OdooNoteWriter, parcel: SendcloudParcel): Promise<number | null> {
    const fields = await odoo.fields("stock.picking");
    if (!fields) return null;
    const base: Domain = [["state", "!=", "cancel"], ...(fields.has("picking_type_code") ? [["picking_type_code", "=", "outgoing"]] : [])];
    const tries: Domain[] = [];
    const tracking = text(parcel.tracking_number);
    if (tracking && fields.has("carrier_tracking_ref")) tries.push([["carrier_tracking_ref", "ilike", tracking]]);
    for (const ref of new Set([text(parcel.order_number), text(parcel.external_reference)].filter((r): r is string => !!r))) {
      tries.push([["name", "=", ref]]);
      if (fields.has("origin")) tries.push([["origin", "=", ref]]);
    }
    for (const domain of tries) {
      const [row] = await odoo.searchRead("stock.picking", [...base, ...domain], ["id"], { limit: 1, order: "id desc" });
      if (row) return row.id;
    }
    return null;
  }
}
