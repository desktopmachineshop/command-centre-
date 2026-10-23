import type { NewEvent } from "@cc/core";
import { z } from "zod";
import { type Domain, type OdooClient, OdooRpcError, type OdooRecord, type SearchReadOptions } from "./client";
import { htmlToText } from "./mcp";
import { type OdooEventKind, odooTitle } from "./prompt";

/**
 * Odoo inbound events. Odoo Online allows no custom modules (so no outgoing
 * hooks we control), so this polls the external API on an interval and turns
 * new records into pipeline events:
 *
 * | source     | model                         | event kind         |
 * | ---------- | ----------------------------- | ------------------ |
 * | orders     | sale.order (state sale/done)  | `order.created`    |
 * | messages   | mail.message (customer posts) | `message.received` |
 * | tickets    | helpdesk.ticket               | `message.received` |
 * | stock      | product.product qty_available | `stock.low`        |
 * | deliveries | stock.picking past scheduled  | `delivery.late`    |
 * | reviews    | rating.rating                 | `review.received`  |
 *
 * Each source has its own loop and checkpoint, so one failing (or missing:
 * a module that isn't installed disables its source, logged once) never
 * stops the others. Record sources keep a date cursor plus the ids already
 * seen in an overlap window (Odoo stamps rows at transaction start, so a slow
 * transaction can commit a row dated before the cursor). State sources
 * (stock, deliveries) keep the set of ids currently low/late and emit only
 * on a crossing. The first run of every source records where things stand
 * and emits nothing, so a backlog is never replayed.
 */

export const ODOO_EVENT_SOURCES = ["orders", "messages", "tickets", "stock", "deliveries", "reviews"] as const;
export type OdooEventSourceId = (typeof ODOO_EVENT_SOURCES)[number];

const verticalId = z.string().regex(/^[a-z0-9-]+$/, "a vertical id, e.g. dms");

const Options = z
  .object({
    /** Which sources to poll. Default: all of them (each disables itself if its Odoo app is missing). */
    sources: z.array(z.enum(ODOO_EVENT_SOURCES)).optional(),
    pollSeconds: z.number().int().min(30).default(300),
    /** stock.low fires when qty_available drops below this (or a reordering rule's min qty, when set). */
    lowStockThreshold: z.number().min(0).default(3),
    useReorderRules: z.boolean().default(true),
    /** Odoo website id or name → vertical, e.g. {"1": "dms", "3dpandme": "3dpandme"}. */
    websites: z.record(z.string(), verticalId).default({}),
    /** Vertical for records with no (mapped) website. */
    defaultVertical: verticalId.default("dms"),
    /** Orders at or above this total get `attention`, so triage hands them to an agent instead of just filing them. */
    bigOrderThreshold: z.number().positive().optional(),
    /** A delivery counts as late this many hours after its scheduled date. */
    lateAfterHours: z.number().min(0).default(24),
    /** mail.message types that count as customer messages. Add "email" to include email replies to Odoo's mails. */
    messageTypes: z.array(z.string().min(1)).min(1).default(["comment"]),
    /** Records whose chatter is watched. */
    messageModels: z.array(z.string().regex(/^[a-z0-9_.]+$/)).min(1).default(["sale.order", "res.partner", "helpdesk.ticket"]),
    /** How far back each poll re-reads, to catch rows committed late. */
    overlapSeconds: z.number().int().min(0).max(86_400).default(600),
  })
  .strict();

export type OdooEventsConfig = Omit<z.output<typeof Options>, "sources" | "pollSeconds"> & {
  sources: OdooEventSourceId[];
  pollIntervalMs: number;
};

function resolve(input: z.input<typeof Options>): OdooEventsConfig {
  const r = Options.safeParse(input);
  if (!r.success) throw new Error(`ODOO_EVENTS: ${r.error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`);
  const { sources, pollSeconds, ...rest } = r.data;
  return { ...rest, sources: [...new Set(sources ?? ODOO_EVENT_SOURCES)], pollIntervalMs: pollSeconds * 1000 };
}

/**
 * `ODOO_EVENTS`: unset/"on" (all sources, defaults), "off", a comma list of
 * sources ("orders,stock"), or a JSON object of options. Null means off.
 */
export function parseOdooEventsConfig(raw: string | undefined): OdooEventsConfig | null {
  const v = raw?.trim() ?? "";
  if (/^(off|false|0|no|none)$/i.test(v)) return null;
  if (v === "" || /^(on|true|1|yes|all)$/i.test(v)) return resolve({});
  if (v.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(v);
    } catch (err) {
      throw new Error(`ODOO_EVENTS is not valid JSON: ${(err as Error).message}`);
    }
    return resolve(json as z.input<typeof Options>);
  }
  return resolve({ sources: v.split(",").map((s) => s.trim()).filter(Boolean) as OdooEventSourceId[] });
}

/** The vertical for an Odoo website (many2one `[id, name]`), by id first, then by name. */
export function verticalForWebsite(config: Pick<OdooEventsConfig, "websites" | "defaultVertical">, website: unknown): string {
  if (Array.isArray(website) && typeof website[0] === "number") {
    const byId = config.websites[String(website[0])];
    if (byId) return byId;
    const name = String(website[1] ?? "").toLowerCase();
    for (const [key, vertical] of Object.entries(config.websites)) if (key.toLowerCase() === name) return vertical;
  }
  return config.defaultVertical;
}

// --- Checkpoints ---

export interface OdooCheckpoint {
  /** Odoo datetime ("YYYY-MM-DD HH:MM:SS", UTC) of the newest record seen; null for state sources. */
  cursor: string | null;
  /** Record sources: ids seen inside the overlap window. State sources: ids currently low/late. */
  seenIds: number[];
  state: Record<string, unknown>;
}

/** Where each source's progress is kept. The server's Store implements this. */
export interface OdooCheckpointStore {
  getOdooCheckpoint(key: string): Promise<OdooCheckpoint | null>;
  saveOdooCheckpoint(key: string, checkpoint: OdooCheckpoint): Promise<void>;
}

export class MemoryOdooCheckpointStore implements OdooCheckpointStore {
  readonly checkpoints = new Map<string, OdooCheckpoint>();
  async getOdooCheckpoint(key: string) {
    const c = this.checkpoints.get(key);
    return c ? structuredClone(c) : null;
  }
  async saveOdooCheckpoint(key: string, checkpoint: OdooCheckpoint) {
    this.checkpoints.set(key, structuredClone(checkpoint));
  }
}

// --- Helpers ---

/** Odoo's datetime format, in UTC. */
export function formatOdooDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
export function parseOdooDate(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

const nameOf = (v: unknown): string | null => (Array.isArray(v) && typeof v[1] === "string" ? v[1] : null);
const idOf = (v: unknown): number | null => (Array.isArray(v) && typeof v[0] === "number" ? v[0] : typeof v === "number" ? v : null);
const val = (v: unknown) => (v === false || v === undefined ? null : v);
const ids = (rows: OdooRecord[], key: string): number[] => [...new Set(rows.map((r) => idOf(r[key])).filter((x): x is number => x !== null))];
const stripSku = (v: unknown) => (typeof v === "string" ? v.replace(/^\[[^\]]*\]\s*/, "") : null);

/** A source can't run on this Odoo (module or field missing, no access): disable it. */
class SourceUnavailable extends Error {}

function unavailable(err: unknown): string | null {
  if (err instanceof SourceUnavailable) return err.message;
  if (err instanceof OdooRpcError && (err.kind === "missing_model" || err.kind === "missing_field" || err.kind === "access")) return err.message;
  return null;
}

export type OdooEventReader = Pick<OdooClient, "searchRead" | "read" | "fields">;

export interface OdooEventLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface OdooEventPollerOptions {
  client: OdooEventReader;
  store: OdooCheckpointStore;
  ingest: (event: NewEvent) => Promise<unknown>;
  config: OdooEventsConfig;
  /** Checkpoint key prefix, e.g. the Odoo database, so pointing at another instance starts fresh. */
  instance?: string;
  /** Odoo base URL, for links to records in event payloads. */
  baseUrl?: string;
  /** Delay after a failure; doubles each time up to `maxMs`. Default 30 s to 15 min. */
  backoff?: { initialMs: number; maxMs: number };
  logger?: OdooEventLogger;
  now?: () => Date;
}

type OdooEvent = NewEvent & { payload: Record<string, unknown> };
interface Collected {
  checkpoint: OdooCheckpoint;
  events: OdooEvent[];
}

const PAGE = 200;
const MAX_PAGES = 10;

export class OdooEventPoller {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly disabled = new Map<OdooEventSourceId, string>();
  private readonly running = new Map<OdooEventSourceId, Promise<number>>();
  private readonly log: OdooEventLogger;
  private readonly now: () => Date;
  private readonly cfg: OdooEventsConfig;

  constructor(private readonly options: OdooEventPollerOptions) {
    this.cfg = options.config;
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? {
      info: (m) => console.log(`[odoo-events] ${m}`),
      error: (m, err) => console.error(`[odoo-events] ${m}`, err ?? ""),
    };
  }

  get sources(): OdooEventSourceId[] {
    return this.cfg.sources;
  }

  /** Sources switched off because this Odoo can't serve them, with the reason. */
  disabledSources(): Record<string, string> {
    return Object.fromEntries(this.disabled);
  }

  start(): void {
    this.log.info(`polling ${this.sources.join(", ")} every ${Math.round(this.cfg.pollIntervalMs / 1000)}s`);
    for (const source of this.sources) this.loops.push(this.loop(source));
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.loops);
    await Promise.all([...this.running.values()].map((p) => p.catch(() => 0)));
  }

  /** One poll of every source, in turn. Returns the number of events ingested per source. */
  async pollAll(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const source of this.sources) out[source] = await this.pollOnce(source);
    return out;
  }

  /** One poll of `source`, queued behind any poll of it already running. 0 when disabled. */
  pollOnce(source: OdooEventSourceId): Promise<number> {
    const previous = this.running.get(source) ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(() => this.poll(source));
    this.running.set(source, next);
    return next;
  }

  private get stopped() {
    return this.abort.signal.aborted;
  }

  private async loop(source: OdooEventSourceId): Promise<void> {
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 30_000, maxMs: 15 * 60_000 };
    let delay = initialMs;
    while (!this.stopped && !this.disabled.has(source)) {
      let wait = this.cfg.pollIntervalMs;
      try {
        await this.pollOnce(source);
        delay = initialMs;
      } catch (err) {
        if (this.stopped) break;
        this.log.error(`${source}: ${(err as Error).message}; retrying in ${Math.round(delay / 1000)}s`, err);
        wait = delay;
        delay = Math.min(delay * 2, maxMs);
      }
      await sleep(wait, this.abort.signal);
    }
  }

  private async poll(source: OdooEventSourceId): Promise<number> {
    if (this.disabled.has(source) || this.stopped) return 0;
    const key = `${this.options.instance ?? "odoo"}:${source}`;
    try {
      const checkpoint = await this.options.store.getOdooCheckpoint(key);
      const collected = await this.collect(source, checkpoint);
      // Ingest everything before moving the checkpoint: a failed ingest re-reads next time, and dedupe keys keep that harmless.
      for (const event of collected.events) await this.options.ingest(event);
      await this.options.store.saveOdooCheckpoint(key, collected.checkpoint);
      if (!checkpoint) this.log.info(`${source}: first run, starting from now (no backlog)`);
      return collected.events.length;
    } catch (err) {
      const reason = unavailable(err);
      if (!reason) throw err;
      this.disabled.set(source, reason);
      this.log.error(`${source}: disabled: ${reason}`);
      return 0;
    }
  }

  private collect(source: OdooEventSourceId, cp: OdooCheckpoint | null): Promise<Collected> {
    switch (source) {
      case "orders":
        return this.orders(cp);
      case "messages":
        return this.messages(cp);
      case "tickets":
        return this.tickets(cp);
      case "stock":
        return this.stock(cp);
      case "deliveries":
        return this.deliveries(cp);
      case "reviews":
        return this.reviews(cp);
    }
  }

  // --- Odoo access ---

  private async model(model: string, required: string[], hint: string): Promise<Set<string>> {
    const fields = await this.options.client.fields(model);
    if (!fields) throw new SourceUnavailable(`Odoo has no ${model} model (${hint})`);
    const missing = required.filter((f) => !fields.has(f));
    if (missing.length) throw new SourceUnavailable(`${model} has no ${missing.join(", ")} field${missing.length > 1 ? "s" : ""}`);
    return fields;
  }

  /** search_read asking only for fields the instance has; [] when the model is missing. */
  private async find(model: string, domain: Domain, wanted: string[], options: SearchReadOptions = {}): Promise<OdooRecord[]> {
    const fields = await this.options.client.fields(model);
    if (!fields) return [];
    return this.options.client.searchRead(model, domain, [...new Set(wanted)].filter((f) => fields.has(f)), options);
  }

  private async readKnown(model: string, recordIds: number[], wanted: string[]): Promise<Map<number, OdooRecord>> {
    const fields = recordIds.length ? await this.options.client.fields(model) : null;
    if (!fields) return new Map();
    const rows = await this.options.client.read(model, recordIds, wanted.filter((f) => fields.has(f)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** website_id of each record, when the model has one. */
  private async websites(model: string, recordIds: number[]): Promise<Map<number, unknown>> {
    const fields = recordIds.length ? await this.options.client.fields(model) : null;
    if (!fields?.has("website_id")) return new Map();
    const rows = await this.options.client.read(model, recordIds, ["website_id"]);
    return new Map(rows.map((r) => [r.id, r.website_id]));
  }

  private async partners(partnerIds: number[]) {
    return this.readKnown("res.partner", partnerIds, ["name", "email", "city", "country_id"]);
  }

  private customer(ref: unknown, partners: Map<number, OdooRecord>, fallback: { name?: unknown; email?: unknown } = {}) {
    const id = idOf(ref);
    const p = id !== null ? partners.get(id) : undefined;
    return {
      id,
      name: (val(p?.name) ?? nameOf(ref) ?? val(fallback.name) ?? null) as string | null,
      email: (val(p?.email) ?? val(fallback.email) ?? null) as string | null,
      city: val(p?.city) ?? null,
      country: nameOf(p?.country_id) ?? null,
    };
  }

  private link(model: string, id: unknown): string | null {
    return this.options.baseUrl ? `${this.options.baseUrl.replace(/\/+$/, "")}/web#id=${id}&model=${model}&view_type=form` : null;
  }

  private event(kind: OdooEventKind, model: string, id: number, vertical: string, payload: Record<string, unknown>, keySuffix = ""): OdooEvent {
    return {
      source: "odoo",
      vertical,
      kind,
      title: odooTitle(kind, payload),
      payload: { kind, ...payload },
      dedupeKey: `odoo:${model}:${id}:${kind}${keySuffix}`,
    };
  }

  /**
   * Reads every record dated from (cursor − overlap) on. On the first run the
   * cursor is now, and what's already there only seeds `seenIds`.
   */
  private async scan(model: string, dateField: string, domain: Domain, wanted: string[], cp: OdooCheckpoint | null) {
    const now = this.now();
    const overlap = this.cfg.overlapSeconds * 1000;
    const from = cp?.cursor ? parseOdooDate(cp.cursor) : now;
    const since = formatOdooDate(new Date(from.getTime() - overlap));
    const rows: OdooRecord[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.find(model, [...domain, [dateField, ">=", since]], [...wanted, dateField], {
        order: `${dateField} asc, id asc`,
        limit: PAGE,
        offset: page * PAGE,
      });
      rows.push(...batch);
      if (batch.length < PAGE) break;
      if (page === MAX_PAGES - 1) this.log.info(`${model}: more than ${PAGE * MAX_PAGES} records since ${since}; the rest come next poll`);
    }
    const dateOf = (r: OdooRecord) => (typeof r[dateField] === "string" ? (r[dateField] as string) : "");
    let cursor = cp?.cursor ?? formatOdooDate(now);
    for (const r of rows) if (dateOf(r) > cursor) cursor = dateOf(r);
    const floor = formatOdooDate(new Date(parseOdooDate(cursor).getTime() - overlap));
    const seen = new Set(cp?.seenIds ?? []);
    return {
      fresh: cp ? rows.filter((r) => !seen.has(r.id)) : [],
      checkpoint: { cursor, seenIds: rows.filter((r) => dateOf(r) >= floor).map((r) => r.id), state: cp?.state ?? {} } as OdooCheckpoint,
    };
  }

  // --- Sources ---

  private async orders(cp: OdooCheckpoint | null): Promise<Collected> {
    // Confirming an order sets date_order to the confirmation time, so it is the cursor for "new confirmed orders".
    await this.model("sale.order", ["name", "state", "date_order", "amount_total", "partner_id"], "is the Sales app installed?");
    const wanted = ["name", "state", "amount_total", "amount_untaxed", "currency_id", "partner_id", "order_line", "carrier_id", "website_id", "note", "client_order_ref"];
    const { fresh, checkpoint } = await this.scan("sale.order", "date_order", [["state", "in", ["sale", "done"]]], wanted, cp);
    if (!fresh.length) return { checkpoint, events: [] };

    const lineIds = fresh.flatMap((o) => (Array.isArray(o.order_line) ? (o.order_line as number[]) : []));
    const [lines, partners] = await Promise.all([
      this.readKnown("sale.order.line", lineIds, ["product_id", "name", "product_uom_qty", "price_subtotal", "display_type", "is_delivery"]),
      this.partners(ids(fresh, "partner_id")),
    ]);
    const events = fresh.map((o) => {
      const currency = nameOf(o.currency_id);
      const own = (Array.isArray(o.order_line) ? (o.order_line as number[]) : []).map((id) => lines.get(id)).filter((l): l is OdooRecord => !!l);
      const deliveryLine = own.find((l) => l.is_delivery === true);
      const items = own
        .filter((l) => !l.display_type && l.is_delivery !== true)
        .map((l) => ({
          product: stripSku(nameOf(l.product_id)) ?? htmlToText(l.name, 120),
          sku: (nameOf(l.product_id)?.match(/^\[([^\]]+)\]/) ?? [])[1] ?? null,
          qty: l.product_uom_qty,
          subtotal: l.price_subtotal,
        }));
      const amount = typeof o.amount_total === "number" ? o.amount_total : 0;
      const threshold = this.cfg.bigOrderThreshold;
      const attention = threshold && amount >= threshold ? [`large order (${amount.toFixed(2)} ≥ ${threshold} threshold)`] : [];
      const payload = {
        model: "sale.order",
        id: o.id,
        name: o.name,
        date: val(o.date_order),
        state: o.state,
        amount,
        amountUntaxed: val(o.amount_untaxed),
        currency,
        customer: this.customer(o.partner_id, partners),
        lines: items,
        linesSummary: items.map((i) => `${i.qty} × ${i.product}`).join(", "),
        deliveryMethod: nameOf(o.carrier_id) ?? (deliveryLine ? htmlToText(deliveryLine.name, 120) : null),
        website: nameOf(o.website_id),
        websiteId: idOf(o.website_id),
        notes: htmlToText(o.note, 1000),
        customerRef: val(o.client_order_ref),
        attention,
        link: this.link("sale.order", o.id),
      };
      return this.event("order.created", "sale.order", o.id, verticalForWebsite(this.cfg, o.website_id), payload);
    });
    return { checkpoint, events };
  }

  private async messages(cp: OdooCheckpoint | null): Promise<Collected> {
    const fields = await this.model("mail.message", ["model", "res_id", "message_type", "author_id", "body"], "messaging");
    const dateField = fields.has("create_date") ? "create_date" : "date";
    if (!fields.has(dateField)) throw new SourceUnavailable("mail.message has no create_date or date field");
    const domain: Domain = [
      ["model", "in", this.cfg.messageModels],
      ["message_type", "in", this.cfg.messageTypes],
      ...(fields.has("is_internal") ? [["is_internal", "=", false]] : []),
    ];
    const wanted = ["model", "res_id", "record_name", "message_type", "author_id", "email_from", "subject", "body", "date"];
    const { fresh, checkpoint } = await this.scan("mail.message", dateField, domain, wanted, cp);
    if (!fresh.length) return { checkpoint, events: [] };

    // Internal users (including archived ones such as OdooBot) are staff, not customers.
    const userFields = await this.options.client.fields("res.users");
    const users = await this.find("res.users", userFields?.has("share") ? [["share", "=", false]] : [], ["partner_id"], { context: { active_test: false } });
    const staff = new Set(ids(users, "partner_id"));
    const external = fresh.filter((m) => {
      const author = idOf(m.author_id);
      return author === null ? !!val(m.email_from) : !staff.has(author);
    });
    const orderIds = [...new Set(external.filter((m) => m.model === "sale.order").map((m) => m.res_id as number))];
    const [sites, partners] = await Promise.all([this.websites("sale.order", orderIds), this.partners(ids(external, "author_id"))]);

    const events = external.map((m) => {
      const website = m.model === "sale.order" ? sites.get(m.res_id as number) : undefined;
      const author = this.customer(m.author_id, partners, { name: m.email_from, email: m.email_from });
      const payload = {
        model: m.model,
        resId: m.res_id,
        messageId: m.id,
        recordName: val(m.record_name),
        author: author.name,
        email: author.email,
        customer: author,
        subject: val(m.subject),
        body: htmlToText(m.body, 4000),
        date: val(m.date) ?? val(m[dateField]),
        messageType: m.message_type,
        website: nameOf(website),
        link: this.link(String(m.model), m.res_id),
      };
      return this.event("message.received", "mail.message", m.id, verticalForWebsite(this.cfg, website), payload);
    });
    return { checkpoint, events };
  }

  private async tickets(cp: OdooCheckpoint | null): Promise<Collected> {
    await this.model("helpdesk.ticket", ["name", "create_date"], "is the Helpdesk app installed?");
    const wanted = ["name", "ticket_ref", "partner_id", "partner_name", "partner_email", "description", "team_id", "stage_id", "priority", "website_id"];
    const { fresh, checkpoint } = await this.scan("helpdesk.ticket", "create_date", [], wanted, cp);
    if (!fresh.length) return { checkpoint, events: [] };
    const partners = await this.partners(ids(fresh, "partner_id"));
    const events = fresh.map((t) => {
      const customer = this.customer(t.partner_id, partners, { name: t.partner_name, email: t.partner_email });
      const payload = {
        model: "helpdesk.ticket",
        resId: t.id,
        recordName: val(t.ticket_ref) ? `${t.name} (#${t.ticket_ref})` : t.name,
        author: customer.name,
        email: customer.email,
        customer,
        subject: t.name,
        body: htmlToText(t.description, 4000),
        date: val(t.create_date),
        ticket: { ref: val(t.ticket_ref), team: nameOf(t.team_id), stage: nameOf(t.stage_id), priority: val(t.priority) },
        website: nameOf(t.website_id),
        link: this.link("helpdesk.ticket", t.id),
      };
      return this.event("message.received", "helpdesk.ticket", t.id, verticalForWebsite(this.cfg, t.website_id), payload);
    });
    return { checkpoint, events };
  }

  private async stock(cp: OdooCheckpoint | null): Promise<Collected> {
    const fields = await this.model("product.product", ["qty_available"], "is the Inventory app installed?");
    // Per-product thresholds from reordering rules (min qty > 0), else the configured one.
    const thresholds = new Map<number, number>();
    if (this.cfg.useReorderRules) {
      const op = await this.options.client.fields("stock.warehouse.orderpoint");
      if (op?.has("product_id") && op.has("product_min_qty")) {
        for (const r of await this.find("stock.warehouse.orderpoint", [], ["product_id", "product_min_qty"], { limit: 5000 })) {
          const id = idOf(r.product_id);
          const min = typeof r.product_min_qty === "number" ? r.product_min_qty : 0;
          if (id !== null && min > 0) thresholds.set(id, Math.max(min, thresholds.get(id) ?? 0));
        }
      }
    }
    const max = Math.max(this.cfg.lowStockThreshold, ...thresholds.values());
    const storable: Domain = fields.has("is_storable") ? [["is_storable", "=", true]] : fields.has("type") ? [["type", "=", "product"]] : [];
    const rows = await this.find(
      "product.product",
      [...storable, ["qty_available", "<", max], ...(fields.has("sale_ok") ? [["sale_ok", "=", true]] : [])],
      ["default_code", "display_name", "name", "qty_available", "virtual_available", "incoming_qty", "product_tmpl_id"],
      { limit: 5000, order: "id" },
    );
    const thresholdOf = (id: number) => thresholds.get(id) ?? this.cfg.lowStockThreshold;
    const low = rows.filter((r) => typeof r.qty_available === "number" && r.qty_available < thresholdOf(r.id));
    const previous = new Set(cp?.seenIds ?? []);
    const crossings = { ...((cp?.state.crossings as Record<string, number> | undefined) ?? {}) };
    const events: OdooEvent[] = [];
    if (cp) {
      for (const r of low.filter((r) => !previous.has(r.id))) {
        const n = (crossings[r.id] ?? 0) + 1;
        crossings[r.id] = n;
        const payload = {
          model: "product.product",
          id: r.id,
          templateId: idOf(r.product_tmpl_id),
          sku: val(r.default_code),
          name: stripSku(val(r.display_name) ?? r.name) ?? r.name,
          qtyAvailable: r.qty_available,
          virtualAvailable: val(r.virtual_available),
          incomingQty: val(r.incoming_qty),
          threshold: thresholdOf(r.id),
          thresholdSource: thresholds.has(r.id) ? "reorder-rule" : "config",
          crossing: n,
          link: this.link("product.product", r.id),
        };
        // One event per crossing: the first keeps the plain key, later ones are numbered.
        events.push(this.event("stock.low", "product.product", r.id, this.cfg.defaultVertical, payload, n > 1 ? `#${n}` : ""));
      }
    }
    return { checkpoint: { cursor: null, seenIds: low.map((r) => r.id), state: { crossings } }, events };
  }

  private async deliveries(cp: OdooCheckpoint | null): Promise<Collected> {
    const fields = await this.model("stock.picking", ["name", "state", "scheduled_date"], "is the Inventory app installed?");
    const now = this.now();
    const cutoff = formatOdooDate(new Date(now.getTime() - this.cfg.lateAfterHours * 3_600_000));
    const domain: Domain = [
      ["state", "not in", ["done", "cancel", "draft"]],
      ["scheduled_date", "<", cutoff],
      ...(fields.has("picking_type_code") ? [["picking_type_code", "=", "outgoing"]] : []),
    ];
    const wanted = ["name", "state", "scheduled_date", "date_deadline", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "sale_id"];
    const late = await this.find("stock.picking", domain, wanted, { limit: 1000, order: "scheduled_date asc" });
    const previous = new Set(cp?.seenIds ?? []);
    const fresh = cp ? late.filter((p) => !previous.has(p.id)) : [];
    const checkpoint: OdooCheckpoint = { cursor: null, seenIds: late.map((p) => p.id), state: {} };
    if (!fresh.length) return { checkpoint, events: [] };

    const orders = await this.readKnown("sale.order", ids(fresh, "sale_id"), ["name", "website_id", "partner_id"]);
    const partners = await this.partners([...ids(fresh, "partner_id"), ...ids([...orders.values()], "partner_id")]);
    const events = fresh.map((p) => {
      const order = orders.get(idOf(p.sale_id) ?? -1);
      const scheduled = typeof p.scheduled_date === "string" ? parseOdooDate(p.scheduled_date) : null;
      const payload = {
        model: "stock.picking",
        id: p.id,
        name: p.name,
        state: p.state,
        scheduledDate: val(p.scheduled_date),
        deadline: val(p.date_deadline),
        hoursLate: scheduled ? Math.floor((now.getTime() - scheduled.getTime()) / 3_600_000) : null,
        origin: val(p.origin),
        carrier: nameOf(p.carrier_id),
        trackingRef: val(p.carrier_tracking_ref),
        order: order || p.sale_id ? { id: idOf(p.sale_id), name: (order?.name as string | undefined) ?? nameOf(p.sale_id) } : null,
        customer: this.customer(p.partner_id || order?.partner_id, partners),
        website: nameOf(order?.website_id),
        link: this.link("stock.picking", p.id),
      };
      return this.event("delivery.late", "stock.picking", p.id, verticalForWebsite(this.cfg, order?.website_id), payload);
    });
    return { checkpoint, events };
  }

  private async reviews(cp: OdooCheckpoint | null): Promise<Collected> {
    const fields = await this.model("rating.rating", ["rating", "res_model", "res_id"], "is the Rating module installed?");
    // A rating row exists from the request on; it counts once the customer has filled it in (consumed).
    const dateField = fields.has("write_date") ? "write_date" : "create_date";
    if (!fields.has(dateField)) throw new SourceUnavailable("rating.rating has no write_date or create_date field");
    const domain: Domain = [["rating", ">", 0], ...(fields.has("consumed") ? [["consumed", "=", true]] : [])];
    const wanted = ["rating", "feedback", "res_model", "res_id", "res_name", "partner_id", "message_id", "publisher_comment"];
    const { fresh, checkpoint } = await this.scan("rating.rating", dateField, domain, wanted, cp);
    if (!fresh.length) return { checkpoint, events: [] };

    const partners = await this.partners(ids(fresh, "partner_id"));
    const byModel = new Map<string, number[]>();
    for (const r of fresh) byModel.set(String(r.res_model), [...(byModel.get(String(r.res_model)) ?? []), r.res_id as number]);
    const sites = new Map<string, Map<number, unknown>>();
    for (const [model, recordIds] of byModel) sites.set(model, await this.websites(model, recordIds).catch(() => new Map()));

    const events = fresh.map((r) => {
      const website = sites.get(String(r.res_model))?.get(r.res_id as number);
      const payload = {
        model: "rating.rating",
        id: r.id,
        rating: r.rating,
        feedback: htmlToText(r.feedback, 4000),
        resModel: r.res_model,
        resId: r.res_id,
        recordName: val(r.res_name),
        customer: this.customer(r.partner_id, partners),
        messageId: idOf(r.message_id),
        replied: !!val(r.publisher_comment),
        date: val(r[dateField]),
        website: nameOf(website),
        link: this.link(String(r.res_model), r.res_id),
      };
      return this.event("review.received", "rating.rating", r.id, verticalForWebsite(this.cfg, website), payload);
    });
    return { checkpoint, events };
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
