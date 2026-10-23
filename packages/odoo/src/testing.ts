import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small in-memory Odoo for tests: speaks JSON-RPC (`/jsonrpc`) and JSON-2
 * (`/json/2/<model>/<method>`) over real HTTP, with field checking and a
 * domain evaluator good enough for the tools. Never point tests at a real Odoo.
 */

type Rec = Record<string, unknown> & { id: number };

export interface FakeModel {
  fields: string[];
  records?: Rec[];
}

export interface FakeOdooOptions {
  db?: string;
  login?: string;
  apiKey?: string;
  uid?: number;
  models: Record<string, FakeModel>;
}

export interface FakeCall {
  api: "jsonrpc" | "json2";
  model: string;
  method: string;
  params: Record<string, unknown>;
}

class FakeOdooException extends Error {
  constructor(readonly odooName: string, message: string) {
    super(message);
  }
}

/** Positional argument names for execute_kw, so both APIs map to named params. */
const POSITIONAL: Record<string, string[]> = {
  search_read: ["domain", "fields", "offset", "limit", "order"],
  search: ["domain", "offset", "limit", "order"],
  search_count: ["domain"],
  read: ["ids", "fields"],
  create: ["vals_list"],
  write: ["ids", "vals"],
  message_post: ["ids"],
  fields_get: [],
};

export class FakeOdoo {
  readonly db: string;
  readonly login: string;
  readonly apiKey: string;
  readonly uid: number;
  readonly models: Record<string, { fields: Set<string>; records: Rec[] }>;
  readonly calls: FakeCall[] = [];
  /** Delay every response, to test timeouts. */
  delayMs = 0;
  /** Behave like Odoo ≤16, whose message_post has no body_is_html argument. */
  legacyMessagePost = false;
  private server?: Server;
  url = "";

  constructor(options: FakeOdooOptions) {
    this.db = options.db ?? "testdb";
    this.login = options.login ?? "bot@example.com";
    this.apiKey = options.apiKey ?? "test-api-key";
    this.uid = options.uid ?? 7;
    this.models = Object.fromEntries(
      Object.entries(options.models).map(([name, m]) => [
        name,
        { fields: new Set(["id", "display_name", ...m.fields]), records: (m.records ?? []).map((r) => ({ ...r })) },
      ]),
    );
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (res.destroyed) return;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad json" });
    }

    const url = req.url ?? "";
    const json2 = url.match(/^\/json\/2\/([\w.]+)\/(\w+)$/);
    if (json2) {
      if (req.headers.authorization !== `bearer ${this.apiKey}`) {
        return send(401, { name: "werkzeug.exceptions.Unauthorized", message: "Invalid apikey", arguments: [], debug: "" });
      }
      try {
        return send(200, this.dispatch("json2", json2[1]!, json2[2]!, body));
      } catch (err) {
        const e = err as FakeOdooException;
        return send(e.odooName === "builtins.KeyError" ? 404 : 422, { name: e.odooName, message: e.message, arguments: [e.message], debug: "Traceback..." });
      }
    }
    if (url !== "/jsonrpc") return send(404, { error: "not found" });

    const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: body.id, result });
    const fail = (name: string, message: string) =>
      send(200, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: 200, message: "Odoo Server Error", data: { name, message, arguments: [message], debug: "Traceback..." } },
      });
    const { service, method, args = [] } = body.params ?? {};
    if (service === "common" && (method === "authenticate" || method === "login")) {
      const [db, login, key] = args;
      return reply(db === this.db && login === this.login && key === this.apiKey ? this.uid : false);
    }
    if (service === "object" && method === "execute_kw") {
      const [db, uid, key, model, m, positional = [], kwargs = {}] = args;
      if (db !== this.db || uid !== this.uid || key !== this.apiKey) return fail("odoo.exceptions.AccessDenied", "Access Denied");
      const params: Record<string, unknown> = { ...kwargs };
      (POSITIONAL[m] ?? ["ids"]).forEach((name, i) => {
        if (i < positional.length) params[name] = positional[i];
      });
      try {
        return reply(this.dispatch("jsonrpc", model, m, params));
      } catch (err) {
        const e = err as FakeOdooException;
        return fail(e.odooName, e.message);
      }
    }
    return fail("builtins.ValueError", `Unknown service ${service}.${method}`);
  }

  private dispatch(api: FakeCall["api"], modelName: string, method: string, params: Record<string, unknown>): unknown {
    this.calls.push({ api, model: modelName, method, params });
    const model = this.models[modelName];
    if (!model) throw new FakeOdooException("builtins.KeyError", `'${modelName}'`);
    const checkFields = (fields: string[]) => {
      for (const f of fields) {
        if (!model.fields.has(f)) throw new FakeOdooException("builtins.ValueError", `Invalid field '${f}' on model '${modelName}'`);
      }
    };
    const project = (r: Rec, fields: string[] | undefined) =>
      fields?.length ? Object.fromEntries([["id", r.id], ...fields.map((f) => [f, r[f] ?? false])]) : { ...r };
    const byIds = (ids: unknown) => (ids as number[]).map((id) => model.records.find((r) => r.id === id)).filter((r): r is Rec => !!r);

    switch (method) {
      case "fields_get":
        return Object.fromEntries([...model.fields].map((f) => [f, { type: "char" }]));
      case "search_read":
      case "search":
      case "search_count": {
        const domain = (params.domain ?? []) as unknown[];
        const fields = params.fields as string[] | undefined;
        if (fields) checkFields(fields);
        let rows = model.records.filter(compileDomain(domain, modelName, model.fields));
        if (method === "search_count") return rows.length;
        rows = sortRows(rows, params.order as string | undefined);
        const offset = (params.offset as number) ?? 0;
        rows = rows.slice(offset, params.limit ? offset + (params.limit as number) : undefined);
        return method === "search" ? rows.map((r) => r.id) : rows.map((r) => project(r, fields));
      }
      case "read": {
        const fields = params.fields as string[] | undefined;
        if (fields) checkFields(fields);
        return byIds(params.ids).map((r) => project(r, fields));
      }
      case "create": {
        const list = (Array.isArray(params.vals_list) ? params.vals_list : [params.vals_list]) as Record<string, unknown>[];
        const ids = list.map((vals) => {
          checkFields(Object.keys(vals));
          const id = Math.max(0, ...model.records.map((r) => r.id)) + 1;
          model.records.push({ ...vals, id });
          return id;
        });
        return api === "json2" || Array.isArray(params.vals_list) ? ids : ids[0];
      }
      case "write": {
        const vals = params.vals as Record<string, unknown>;
        checkFields(Object.keys(vals));
        for (const r of byIds(params.ids)) Object.assign(r, vals);
        return true;
      }
      case "message_post": {
        if (this.legacyMessagePost && "body_is_html" in params) {
          throw new FakeOdooException("builtins.ValueError", "Invalid field 'body_is_html' on model 'mail.message'");
        }
        const [record] = byIds(params.ids);
        if (!record) throw new FakeOdooException("odoo.exceptions.MissingError", "Record does not exist or has been deleted.");
        const messages = this.models["mail.message"];
        if (!messages) throw new FakeOdooException("builtins.AttributeError", "message_post");
        const id = Math.max(0, ...messages.records.map((r) => r.id)) + 1;
        messages.records.push({
          id,
          model: modelName,
          res_id: record.id,
          body: params.body,
          message_type: params.message_type ?? "notification",
          subtype_id: params.subtype_xmlid === "mail.mt_note" ? [2, "Note"] : [1, "Discussions"],
          author_id: [3, "Bot"],
          date: "2026-10-23 09:00:00",
        });
        return id;
      }
      default:
        throw new FakeOdooException("builtins.AttributeError", `The method '${method}' does not exist on the model '${modelName}'`);
    }
  }
}

/**
 * A small DMS-like dataset shaped like Odoo 18: no `res.partner.mobile`, and
 * `is_storable` rather than `type = 'product'`.
 */
export function demoModels(): Record<string, FakeModel> {
  return {
    "res.users": { fields: ["login", "name"], records: [{ id: 7, login: "bot@example.com", name: "Command Centre" }] },
    "product.product": {
      fields: [
        "default_code", "name", "lst_price", "list_price", "standard_price", "qty_available", "virtual_available", "incoming_qty",
        "outgoing_qty", "weight", "categ_id", "is_published", "barcode", "product_tmpl_id", "is_storable", "type", "sale_ok", "active",
        "taxes_id", "description_sale", "uom_id", "website_url", "volume",
      ],
      records: [
        { id: 1, default_code: "ER11-7", name: "ER11 collet set (7 pcs)", display_name: "[ER11-7] ER11 collet set (7 pcs)", lst_price: 24.5, list_price: 24.5, standard_price: 9.1, qty_available: 3, virtual_available: 1, incoming_qty: 0, weight: 0.3, categ_id: [4, "All / Tooling"], is_published: true, barcode: false, product_tmpl_id: [11, "ER11 collet set (7 pcs)"], is_storable: true, type: "consu", sale_ok: true, active: true, taxes_id: [1], description_sale: "<p>Fits 300W spindles.</p>", uom_id: [1, "Units"], website_url: "/shop/er11-collet-set-11" },
        { id: 2, default_code: "SP-300W", name: "300W spindle", display_name: "[SP-300W] 300W spindle", lst_price: 89, list_price: 89, standard_price: 41, qty_available: 12, virtual_available: 10, incoming_qty: 0, weight: 1.2, categ_id: [5, "All / Spindles"], is_published: true, barcode: "5060000000012", product_tmpl_id: [12, "300W spindle"], is_storable: true, type: "consu", sale_ok: true, active: true, taxes_id: [1] },
        { id: 3, default_code: "MILO-V2", name: "Milo v2 CNC kit", display_name: "[MILO-V2] Milo v2 CNC kit", lst_price: 1250, list_price: 1250, standard_price: 640, qty_available: 0, virtual_available: 4, incoming_qty: 4, weight: 38.5, categ_id: [6, "All / Kits"], is_published: true, barcode: false, product_tmpl_id: [13, "Milo v2 CNC kit"], is_storable: true, type: "consu", sale_ok: true, active: true, taxes_id: [1] },
        { id: 4, default_code: "SHIP", name: "Shipping", display_name: "Shipping", lst_price: 5, list_price: 5, standard_price: 0, qty_available: 0, virtual_available: 0, is_storable: false, type: "service", sale_ok: true, active: true, taxes_id: [] },
      ],
    },
    "account.tax": { fields: ["name", "amount", "amount_type", "price_include_override"], records: [{ id: 1, name: "20% S", amount: 20, amount_type: "percent", price_include_override: "tax_included" }] },
    "res.partner": {
      fields: ["name", "email", "phone", "city", "country_id", "is_company", "parent_id", "ref", "customer_rank"],
      records: [
        { id: 10, name: "Jane Doe", email: "jane@example.com", phone: "+44 7700 900123", city: "Leeds", country_id: [233, "United Kingdom"], is_company: false, parent_id: false, customer_rank: 2 },
        { id: 11, name: "Acme Robotics", email: "buy@acme.example", is_company: true, parent_id: false, customer_rank: 1 },
      ],
    },
    "sale.order": {
      fields: ["name", "partner_id", "date_order", "state", "amount_total", "currency_id", "invoice_status", "delivery_status", "client_order_ref", "commitment_date", "website_id", "order_line", "picking_ids", "invoice_ids", "note"],
      records: [
        { id: 42, name: "S00042", partner_id: [10, "Jane Doe"], date_order: "2026-10-20 14:03:00", state: "sale", amount_total: 113.5, currency_id: [1, "GBP"], invoice_status: "invoiced", delivery_status: "partial", client_order_ref: false, commitment_date: false, website_id: [1, "Desktop Machine Shop"], order_line: [1, 2], picking_ids: [5], invoice_ids: [8], note: false },
        { id: 41, name: "S00041", partner_id: [11, "Acme Robotics"], date_order: "2026-09-02 10:00:00", state: "draft", amount_total: 1250, currency_id: [1, "GBP"], invoice_status: "no", delivery_status: false, order_line: [], picking_ids: [], invoice_ids: [] },
      ],
    },
    "sale.order.line": {
      fields: ["product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "display_type"],
      records: [
        { id: 1, product_id: [1, "[ER11-7] ER11 collet set (7 pcs)"], name: "ER11 collet set (7 pcs)", product_uom_qty: 1, qty_delivered: 1, qty_invoiced: 1, price_unit: 24.5, discount: 0, price_subtotal: 24.5, display_type: false },
        { id: 2, product_id: [2, "[SP-300W] 300W spindle"], name: "300W spindle", product_uom_qty: 1, qty_delivered: 0, qty_invoiced: 1, price_unit: 89, discount: 0, price_subtotal: 89, display_type: false },
      ],
    },
    "stock.picking": {
      fields: ["name", "state", "picking_type_code", "scheduled_date", "date_done", "carrier_id", "carrier_tracking_ref", "sale_id"],
      records: [{ id: 5, name: "WH/OUT/00017", state: "assigned", picking_type_code: "outgoing", scheduled_date: "2026-10-24 09:00:00", date_done: false, carrier_id: [2, "Royal Mail Tracked 48"], carrier_tracking_ref: "RM123456785GB", sale_id: [42, "S00042"] }],
    },
    "account.move": {
      fields: ["name", "state", "payment_state", "move_type", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "invoice_origin", "partner_id"],
      records: [{ id: 8, name: "INV/2026/00008", state: "posted", payment_state: "paid", move_type: "out_invoice", invoice_date: "2026-10-20", invoice_date_due: "2026-10-20", amount_total: 113.5, amount_residual: 0, invoice_origin: "S00042", partner_id: [10, "Jane Doe"] }],
    },
    "mail.message": {
      fields: ["date", "author_id", "email_from", "message_type", "subtype_id", "subject", "body", "model", "res_id"],
      records: [
        { id: 100, model: "sale.order", res_id: 42, date: "2026-10-21 08:00:00", author_id: [10, "Jane Doe"], email_from: "jane@example.com", message_type: "email", subtype_id: [1, "Discussions"], subject: "Where is my spindle?", body: "<p>Hi, when will the <b>spindle</b> ship?</p>" },
        { id: 101, model: "sale.order", res_id: 42, date: "2026-10-20 14:03:00", author_id: [3, "OdooBot"], message_type: "notification", subtype_id: [3, "Sales Order Confirmed"], body: "<p>Order confirmed</p>" },
        { id: 102, model: "res.partner", res_id: 10, date: "2026-09-01 12:00:00", author_id: [3, "Dave"], message_type: "comment", subtype_id: [2, "Note"], body: "<p>Prefers email. Runs a 300W spindle.</p>" },
      ],
    },
    website: {
      fields: ["name", "domain", "company_id"],
      records: [
        { id: 1, name: "Desktop Machine Shop", domain: "https://desktopmachineshop.com", company_id: [1, "DMS Ltd"] },
        { id: 2, name: "3dpandme", domain: "https://3dpandme.com", company_id: [1, "DMS Ltd"] },
      ],
    },
    "blog.blog": {
      fields: ["name", "website_id"],
      records: [
        { id: 1, name: "DMS News", website_id: [1, "Desktop Machine Shop"] },
        { id: 2, name: "3dpandme Blog", website_id: [2, "3dpandme"] },
      ],
    },
    "blog.post": {
      fields: ["name", "subtitle", "blog_id", "website_id", "is_published", "post_date", "website_url", "author_id", "content"],
      records: [
        { id: 1, name: "Tramming your spindle", subtitle: "A 10-minute fix", blog_id: [2, "3dpandme Blog"], website_id: [2, "3dpandme"], is_published: true, post_date: "2026-10-01 09:00:00", website_url: "/blog/3dpandme-blog-2/tramming-1", author_id: [3, "Dave"], content: "<p>...</p>" },
        { id: 2, name: "Milo v2 restock", subtitle: false, blog_id: [1, "DMS News"], website_id: [1, "Desktop Machine Shop"], is_published: false, post_date: "2026-10-15 09:00:00", website_url: "/blog/dms-news-1/milo-2", author_id: [3, "Dave"], content: "<p>...</p>" },
      ],
    },
  };
}

function sortRows(rows: Rec[], order: string | undefined): Rec[] {
  const [field, dir] = (order ?? "id").split(",")[0]!.trim().split(/\s+/);
  const sign = dir?.toLowerCase() === "desc" ? -1 : 1;
  const key = (r: Rec) => {
    const v = r[field!];
    return Array.isArray(v) ? v[1] : v;
  };
  return [...rows].sort((a, b) => {
    const x = key(a) as any;
    const y = key(b) as any;
    return x === y ? 0 : x > y ? sign : -sign;
  });
}

type Pred = (r: Rec) => boolean;

/** Polish-notation domain → predicate, with Odoo's implicit '&' between terms. */
function compileDomain(domain: unknown[], modelName: string, fields: Set<string>): Pred {
  const stack: Pred[] = [];
  for (const term of [...domain].reverse()) {
    if (term === "!") {
      const a = stack.pop()!;
      stack.push((r) => !a(r));
    } else if (term === "&" || term === "|") {
      const a = stack.pop()!;
      const b = stack.pop()!;
      stack.push(term === "&" ? (r) => a(r) && b(r) : (r) => a(r) || b(r));
    } else {
      const [field, op, value] = term as [string, string, unknown];
      if (!fields.has(field)) throw new FakeOdooException("builtins.ValueError", `Invalid field ${modelName}.${field} in leaf ${JSON.stringify(term)}`);
      stack.push((r) => leaf(r[field] ?? false, op, value));
    }
  }
  return (r) => stack.every((p) => p(r));
}

function leaf(raw: unknown, op: string, value: unknown): boolean {
  const many = Array.isArray(raw) && raw.every((v) => typeof v === "number") ? (raw as number[]) : null;
  const m2o = Array.isArray(raw) && !many ? (raw as [number, string]) : null;
  const id = m2o ? m2o[0] : raw;
  const label = String(m2o ? m2o[1] : raw).toLowerCase();
  const values = Array.isArray(value) ? value : [value];
  const eq = (v: unknown) => (many ? many.includes(v as number) : typeof v === "string" && m2o ? m2o[1] === v : id === v);
  switch (op) {
    case "=":
    case "child_of":
      return values.some(eq);
    case "!=":
      return !eq(value);
    case "in":
      return values.some(eq);
    case "not in":
      return !values.some(eq);
    case "ilike":
    case "like":
      return raw !== false && label.includes(String(value).toLowerCase());
    case "not ilike":
      return !label.includes(String(value).toLowerCase());
    case "=ilike":
      return label === String(value).toLowerCase();
    case "<":
      return (raw as any) < (value as any);
    case "<=":
      return (raw as any) <= (value as any);
    case ">":
      return (raw as any) > (value as any);
    case ">=":
      return (raw as any) >= (value as any);
    default:
      throw new FakeOdooException("builtins.ValueError", `Invalid operator ${op}`);
  }
}
