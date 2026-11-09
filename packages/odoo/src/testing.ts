import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small in-memory Odoo for tests: speaks JSON-RPC (`/jsonrpc`) and JSON-2
 * (`/json/2/<model>/<method>`) over real HTTP, with field checking and a
 * domain evaluator good enough for the tools. Never point tests at a real Odoo.
 */

type Rec = Record<string, unknown> & { id: number };

/** What fields_get says about a field, for models whose tests need real metadata. */
export interface FakeField {
  type: string;
  string?: string;
  required?: boolean;
  readonly?: boolean;
  relation?: string;
  selection?: [string | number, string][];
  store?: boolean;
}

export interface FakeModel {
  fields: string[];
  records?: Rec[];
  /**
   * Typed definitions for some fields (they needn't be repeated in `fields`). Fields without
   * one get a type guessed from the records' values (char when there is nothing to go on).
   */
  defs?: Record<string, FakeField>;
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
  readonly models: Record<string, { fields: Set<string>; records: Rec[]; defs?: Record<string, FakeField> }>;
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
        { fields: new Set(["id", "display_name", ...m.fields, ...Object.keys(m.defs ?? {})]), records: (m.records ?? []).map((r) => ({ ...r })), defs: m.defs },
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

  /** Adds a record (as a test's "something happened in Odoo") and returns its id. */
  add(modelName: string, record: Record<string, unknown> & { id?: number }): number {
    const model = this.models[modelName];
    if (!model) throw new Error(`FakeOdoo has no model ${modelName}`);
    const id = record.id ?? Math.max(0, ...model.records.map((r) => r.id)) + 1;
    model.records.push({ ...record, id });
    return id;
  }

  /** Changes fields of an existing record. */
  update(modelName: string, id: number, values: Record<string, unknown>): void {
    const record = this.models[modelName]?.records.find((r) => r.id === id);
    if (!record) throw new Error(`FakeOdoo has no ${modelName} ${id}`);
    Object.assign(record, values);
  }

  /** Removes a model, as if its app were uninstalled. */
  uninstall(modelName: string): void {
    delete this.models[modelName];
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
    // display_name is computed in Odoo: fall back to the name when a dataset doesn't spell it out.
    const cell = (r: Rec, f: string) => r[f] ?? (f === "display_name" ? (r.name ?? false) : false);
    const project = (r: Rec, fields: string[] | undefined) =>
      fields?.length ? Object.fromEntries([["id", r.id], ...fields.map((f) => [f, cell(r, f)])]) : { ...r };
    const byIds = (ids: unknown) => (ids as number[]).map((id) => model.records.find((r) => r.id === id)).filter((r): r is Rec => !!r);

    switch (method) {
      case "fields_get":
        return Object.fromEntries(
          [...model.fields].map((f) => {
            const def = fieldDef(f, model);
            const wanted = params.attributes as string[] | undefined;
            return [f, wanted ? Object.fromEntries(Object.entries(def).filter(([k]) => wanted.includes(k))) : def];
          }),
        );
      case "search_read":
      case "search":
      case "search_count": {
        const domain = (params.domain ?? []) as unknown[];
        const fields = params.fields as string[] | undefined;
        if (fields) checkFields(fields);
        let rows = model.records.filter(compileDomain(domain, modelName, model.fields));
        // As Odoo: archived records are left out unless the domain mentions `active` or active_test is off.
        if (model.fields.has("active") && contextOf(params).active_test !== false && !JSON.stringify(domain).includes('["active"')) rows = rows.filter((r) => r.active !== false);
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
          const record: Rec = { ...this.commands(modelName, vals), id };
          if (modelName === "mail.compose.message" || WIZARDS.has(modelName)) record._context = params.context ?? {};
          if (modelName === "sale.order") this.computeOrder(record);
          if (modelName === "purchase.order") this.computePurchase(record);
          model.records.push(record);
          return id;
        });
        return api === "json2" || Array.isArray(params.vals_list) ? ids : ids[0];
      }
      case "write": {
        const vals = params.vals as Record<string, unknown>;
        checkFields(Object.keys(vals));
        for (const r of byIds(params.ids)) {
          Object.assign(r, this.writeCommands(modelName, r, vals));
          if (modelName === "sale.order" && "order_line" in vals) this.orderTotals(r);
        }
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
      case "action_quotation_send": {
        if (modelName !== "sale.order") break;
        const [order] = byIds(params.ids);
        if (!order) throw new FakeOdooException("odoo.exceptions.MissingError", "Record does not exist or has been deleted.");
        return {
          type: "ir.actions.act_window",
          res_model: "mail.compose.message",
          target: "new",
          context: { default_model: "sale.order", default_res_ids: [order.id], default_template_id: 9, default_composition_mode: "comment", mark_so_as_sent: true, force_email: true },
        };
      }
      case "action_send_mail": {
        if (modelName !== "mail.compose.message") break;
        const [wizard] = byIds(params.ids);
        if (!wizard) throw new FakeOdooException("odoo.exceptions.MissingError", "Record does not exist or has been deleted.");
        const ctx = (wizard._context ?? {}) as Record<string, unknown>;
        const target = this.models[ctx.default_model as string];
        for (const id of (ctx.default_res_ids as number[]) ?? []) {
          const record = target?.records.find((r) => r.id === id);
          if (!record) continue;
          if ((ctx.mark_so_as_sent || ctx.mark_rfq_as_sent) && record.state === "draft") record.state = "sent";
          const messages = this.models["mail.message"]!;
          messages.records.push({
            id: Math.max(0, ...messages.records.map((r) => r.id)) + 1,
            model: ctx.default_model,
            res_id: id,
            body: `<p>Quotation ${String(record.name)} (template ${String(ctx.default_template_id)})</p>`,
            message_type: "comment",
            subtype_id: [1, "Discussions"],
            author_id: [3, "Bot"],
            date: "2026-10-23 09:00:00",
          });
        }
        return true;
      }
      default:
        break;
    }
    const handler = WORKFLOW[`${modelName}.${method}`];
    if (handler) {
      const records = byIds(params.ids ?? []);
      if (Array.isArray(params.ids) && records.length !== (params.ids as unknown[]).length) {
        throw new FakeOdooException("odoo.exceptions.MissingError", "Record does not exist or has been deleted.");
      }
      return handler(this, records, params);
    }
    throw new FakeOdooException("builtins.AttributeError", `The method '${method}' does not exist on the model '${modelName}'`);
  }

  /** The next id of a model. */
  nextId(modelName: string): number {
    return Math.max(0, ...this.models[modelName]!.records.map((r) => r.id)) + 1;
  }

  /** x2many commands in write values: 0 creates a line, 1 updates one, 2 deletes one, 6 sets ids. */
  private writeCommands(modelName: string, record: Rec, vals: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...vals };
    for (const [field, v] of Object.entries(vals)) {
      const lineModel = LINE_MODELS[`${modelName}.${field}`];
      if (!lineModel || !Array.isArray(v) || !v.every((c) => Array.isArray(c))) continue;
      let ids = [...((record[field] as number[] | undefined) ?? [])];
      const lines = this.models[lineModel]!;
      for (const [cmd, id, data] of v as [number, number, Record<string, unknown> | number[]][]) {
        if (cmd === 0) ids.push(this.dispatch("jsonrpc", lineModel, "create", { vals_list: data }) as number);
        else if (cmd === 1) Object.assign(lines.records.find((l) => l.id === id) ?? {}, data);
        else if (cmd === 2) {
          ids = ids.filter((x) => x !== id);
          lines.records = lines.records.filter((l) => l.id !== id);
        } else if (cmd === 6) ids = [...(data as number[])];
      }
      out[field] = ids;
    }
    return out;
  }

  /** Line prices and order totals (20% tax). */
  private orderTotals(order: Rec) {
    const lines = this.models["sale.order.line"]!.records.filter((l) => (order.order_line as number[] | undefined)?.includes(l.id));
    const products = this.models["product.product"]!.records;
    let untaxed = 0;
    for (const line of lines) {
      const productId = Array.isArray(line.product_id) ? line.product_id[0] : line.product_id;
      const product = products.find((p) => p.id === productId);
      if (!product) throw new FakeOdooException("odoo.exceptions.MissingError", `Product ${String(productId)} does not exist`);
      line.product_id = [product.id, product.display_name];
      line.name ??= product.name;
      line.price_unit ??= product.lst_price;
      line.price_subtotal = (line.product_uom_qty as number) * (line.price_unit as number) * (1 - ((line.discount as number) ?? 0) / 100);
      untaxed += line.price_subtotal as number;
    }
    order.amount_untaxed = untaxed;
    order.amount_total = Math.round(untaxed * 120) / 100;
  }

  /** What Odoo computes on a new purchase order: name, draft state, vendor prices and totals. */
  private computePurchase(po: Rec) {
    const lines = this.models["purchase.order.line"]!.records.filter((l) => (po.order_line as number[] | undefined)?.includes(l.id));
    let untaxed = 0;
    for (const line of lines) {
      const product = this.models["product.product"]!.records.find((p) => p.id === line.product_id);
      if (!product) throw new FakeOdooException("odoo.exceptions.MissingError", `Product ${String(line.product_id)} does not exist`);
      line.product_id = [product.id, product.display_name];
      line.price_unit ??= product.standard_price;
      line.price_subtotal = (line.product_qty as number) * (line.price_unit as number);
      untaxed += line.price_subtotal as number;
    }
    const vendor = this.models["res.partner"]!.records.find((p) => p.id === po.partner_id);
    if (!vendor) throw new FakeOdooException("odoo.exceptions.MissingError", `Contact ${String(po.partner_id)} does not exist`);
    Object.assign(po, {
      name: `P${String(po.id).padStart(5, "0")}`,
      partner_id: [vendor.id, vendor.name],
      state: "draft",
      amount_untaxed: untaxed,
      amount_total: Math.round(untaxed * 120) / 100,
      picking_ids: [],
      invoice_ids: [],
    });
  }

  /** x2many commands in create values: `[0, 0, vals]` creates a line record, `[6, 0, ids]` sets ids. */
  private commands(modelName: string, vals: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...vals };
    for (const [field, v] of Object.entries(vals)) {
      if (!Array.isArray(v) || !v.every((c) => Array.isArray(c) && (c[0] === 0 || c[0] === 6))) continue;
      const lineModel = LINE_MODELS[`${modelName}.${field}`];
      const ids: number[] = [];
      for (const [cmd, , data] of v as [number, number, unknown][]) {
        if (cmd === 6) ids.push(...(data as number[]));
        else if (lineModel) ids.push(this.dispatch("jsonrpc", lineModel, "create", { vals_list: data }) as number);
        else throw new FakeOdooException("builtins.ValueError", `FakeOdoo can't create lines for ${modelName}.${field}`);
      }
      out[field] = ids;
    }
    return out;
  }

  /** What Odoo computes on a new sales order: its name, draft state, line products and totals (20% tax). */
  private computeOrder(order: Rec) {
    this.orderTotals(order);
    const untaxed = order.amount_untaxed as number;
    const partner = this.models["res.partner"]!.records.find((p) => p.id === order.partner_id);
    if (!partner) throw new FakeOdooException("odoo.exceptions.MissingError", `Contact ${String(order.partner_id)} does not exist`);
    Object.assign(order, {
      name: `S${String(Math.max(0, ...this.models["sale.order"]!.records.map((r) => r.id)) + 1).padStart(5, "0")}`,
      partner_id: [partner.id, partner.name],
      state: "draft",
      amount_untaxed: untaxed,
      amount_total: Math.round(untaxed * 120) / 100,
      picking_ids: [],
      invoice_ids: [],
    });
  }
}

/** A field's fields_get entry: its typed definition, or one guessed from the name and the records' values. */
function fieldDef(field: string, model: { records: Rec[]; defs?: Record<string, FakeField> }): FakeField {
  const def = model.defs?.[field];
  if (def) return { string: field, required: false, readonly: false, store: true, ...def };
  if (field === "id") return { type: "integer", string: "ID", required: false, readonly: true, store: true };
  if (field === "display_name") return { type: "char", string: "Display Name", required: false, readonly: true, store: false };
  const sample = model.records.map((r) => r[field]).find((v) => v !== undefined && v !== false && v !== null);
  const type =
    typeof sample === "boolean" || field === "active"
      ? "boolean"
      : typeof sample === "number"
        ? "float"
        : Array.isArray(sample)
          ? sample.length === 2 && typeof sample[1] === "string"
            ? "many2one"
            : "many2many"
          : "char";
  return { type, string: field, required: false, readonly: false, store: true };
}

/** One2many fields FakeOdoo can create lines for, and the line model. */
const LINE_MODELS: Record<string, string> = {
  "sale.order.order_line": "sale.order.line",
  "purchase.order.order_line": "purchase.order.line",
  "loyalty.program.rule_ids": "loyalty.rule",
  "loyalty.program.reward_ids": "loyalty.reward",
};

/** Models whose records remember the context they were created with (wizards). */
const WIZARDS = new Set(["sale.advance.payment.inv", "account.payment.register", "account.move.send.wizard", "stock.backorder.confirmation", "sale.order.cancel"]);

type Handler = (fake: FakeOdoo, records: Rec[], params: Record<string, unknown>) => unknown;
const contextOf = (params: Record<string, unknown>) => (params.context ?? {}) as Record<string, unknown>;
const wizardContext = (r: Rec | undefined) => (r?._context ?? {}) as Record<string, unknown>;
const recs = (fake: FakeOdoo, model: string) => fake.models[model]!.records;

/** Workflow buttons and wizards FakeOdoo understands, as `model.method`. */
const WORKFLOW: Record<string, Handler> = {
  "sale.order.action_confirm": (_f, rs) => {
    for (const r of rs) {
      if (r.state !== "draft" && r.state !== "sent") throw new FakeOdooException("odoo.exceptions.UserError", "Only quotations can be confirmed");
      r.state = "sale";
      r.invoice_status = "to invoice";
    }
    return true;
  },
  "sale.order.action_cancel": (_f, rs, params) => {
    if (!contextOf(params).disable_cancel_warning) {
      return { type: "ir.actions.act_window", res_model: "sale.order.cancel", target: "new", context: { default_order_id: rs[0]?.id } };
    }
    for (const r of rs) r.state = "cancel";
    return true;
  },
  "sale.advance.payment.inv.create_invoices": (f, [wizard]) => {
    const ctx = wizardContext(wizard);
    for (const id of (ctx.active_ids as number[]) ?? []) {
      const order = recs(f, "sale.order").find((o) => o.id === id)!;
      const invoice = f.nextId("account.move");
      recs(f, "account.move").push({ id: invoice, name: false, state: "draft", payment_state: "not_paid", move_type: "out_invoice", amount_total: order.amount_total, amount_residual: order.amount_total, invoice_origin: order.name, partner_id: order.partner_id, invoice_date: false, invoice_date_due: false });
      order.invoice_ids = [...((order.invoice_ids as number[]) ?? []), invoice];
      order.invoice_status = "invoiced";
    }
    return { type: "ir.actions.act_window", res_model: "account.move" };
  },
  "account.move.action_post": (f, rs) => {
    for (const r of rs) {
      if (r.state !== "draft") throw new FakeOdooException("odoo.exceptions.UserError", "Only draft entries can be posted");
      r.state = "posted";
      r.name ||= `${r.move_type === "in_invoice" ? "BILL" : "INV"}/2026/${String(r.id).padStart(5, "0")}`;
    }
    return false;
  },
  "account.move.action_invoice_sent": (_f, rs) => ({
    type: "ir.actions.act_window",
    res_model: "account.move.send.wizard",
    target: "new",
    context: { active_model: "account.move", active_ids: rs.map((r) => r.id) },
  }),
  "account.move.send.wizard.action_send_and_print": (f, [wizard]) => {
    for (const id of (wizardContext(wizard).active_ids as number[]) ?? []) {
      const move = recs(f, "account.move").find((m) => m.id === id)!;
      recs(f, "mail.message").push({ id: f.nextId("mail.message"), model: "account.move", res_id: id, body: `<p>Invoice ${String(move.name)}</p>`, message_type: "comment", subtype_id: [1, "Discussions"], author_id: [3, "Bot"], date: "2026-10-23 09:00:00" });
    }
    return { type: "ir.actions.act_window_close" };
  },
  "account.payment.register.action_create_payments": (f, [wizard]) => {
    for (const id of (wizardContext(wizard).active_ids as number[]) ?? []) {
      const move = recs(f, "account.move").find((m) => m.id === id)!;
      const amount = (wizard!.amount as number | undefined) ?? (move.amount_residual as number);
      move.amount_residual = Math.round(((move.amount_residual as number) - amount) * 100) / 100;
      move.payment_state = (move.amount_residual as number) <= 0 ? "paid" : "partial";
      recs(f, "account.payment").push({ id: f.nextId("account.payment"), name: `PBNK/${id}`, amount, partner_id: move.partner_id, payment_type: "inbound", state: "paid", date: wizard!.payment_date ?? "2026-11-07", reconciled_invoice_ids: [id] });
    }
    return true;
  },
  "purchase.order.button_confirm": (_f, rs) => {
    for (const r of rs) r.state = "purchase";
    return true;
  },
  "purchase.order.action_rfq_send": (_f, [po]) => ({
    type: "ir.actions.act_window",
    res_model: "mail.compose.message",
    context: { default_model: "purchase.order", default_res_ids: [po!.id], default_template_id: 12, default_composition_mode: "comment", mark_rfq_as_sent: true },
  }),
  "purchase.order.action_create_invoice": (f, rs) => {
    for (const po of rs) {
      const bill = f.nextId("account.move");
      recs(f, "account.move").push({ id: bill, name: false, state: "draft", payment_state: "not_paid", move_type: "in_invoice", amount_total: po.amount_total, amount_residual: po.amount_total, invoice_origin: po.name, partner_id: po.partner_id });
      po.invoice_ids = [...((po.invoice_ids as number[]) ?? []), bill];
    }
    return { type: "ir.actions.act_window", res_model: "account.move" };
  },
  "stock.picking.button_validate": (f, rs) => {
    for (const p of rs) {
      const moves = recs(f, "stock.move").filter((m) => ((p.move_ids as number[]) ?? []).includes(m.id));
      if (moves.some((m) => (m.quantity as number) < (m.product_uom_qty as number))) {
        return { type: "ir.actions.act_window", res_model: "stock.backorder.confirmation", target: "new", context: { button_validate_picking_ids: [p.id] } };
      }
      p.state = "done";
      p.date_done = "2026-11-07 10:00:00";
    }
    return true;
  },
  "stock.backorder.confirmation.process": (f, [wizard]) => {
    for (const id of (wizardContext(wizard).button_validate_picking_ids as number[]) ?? []) {
      const p = recs(f, "stock.picking").find((x) => x.id === id)!;
      const backorder = f.nextId("stock.picking");
      recs(f, "stock.picking").push({ ...p, id: backorder, name: `${String(p.name)}-BO`, state: "assigned", move_ids: [], backorder_ids: [] });
      p.backorder_ids = [backorder];
      p.state = "done";
    }
    return true;
  },
  "stock.backorder.confirmation.process_cancel_backorder": (f, [wizard]) => {
    for (const id of (wizardContext(wizard).button_validate_picking_ids as number[]) ?? []) recs(f, "stock.picking").find((x) => x.id === id)!.state = "done";
    return true;
  },
  "stock.quant.action_apply_inventory": (f, rs) => {
    for (const q of rs) {
      q.quantity = q.inventory_quantity;
      const product = recs(f, "product.product").find((p) => p.id === (Array.isArray(q.product_id) ? q.product_id[0] : q.product_id));
      if (product) product.qty_available = recs(f, "stock.quant").filter((x) => (Array.isArray(x.product_id) ? x.product_id[0] : x.product_id) === product.id).reduce((t, x) => t + ((x.quantity as number) ?? 0), 0);
    }
    return false;
  },
  "mail.activity.action_feedback": (f, rs, params) => {
    const ids = rs.map((r) => r.id);
    f.models["mail.activity"]!.records = recs(f, "mail.activity").filter((a) => !ids.includes(a.id));
    const id = f.nextId("mail.message");
    recs(f, "mail.message").push({ id, model: rs[0]?.res_model, res_id: rs[0]?.res_id, body: `<p>${String(rs[0]?.summary)} done${params.feedback ? `: ${String(params.feedback)}` : ""}</p>`, message_type: "notification", subtype_id: [5, "Activities"], author_id: [3, "Bot"], date: "2026-11-07 10:00:00" });
    return id;
  },
  "crm.lead.action_set_won": (f, rs) => {
    const won = recs(f, "crm.stage").find((s) => s.is_won);
    for (const r of rs) Object.assign(r, { probability: 100, stage_id: won ? [won.id, won.name] : r.stage_id });
    return true;
  },
  "crm.lead.action_set_lost": (f, rs, params) => {
    const reason = recs(f, "crm.lost.reason").find((x) => x.id === params.lost_reason_id);
    for (const r of rs) Object.assign(r, { active: false, probability: 0, lost_reason_id: reason ? [reason.id, reason.name] : false });
    return true;
  },
};

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
      fields: ["name", "email", "phone", "phone_sanitized", "street", "street2", "zip", "city", "country_id", "is_company", "parent_id", "ref", "vat", "comment", "customer_rank", "active"],
      records: [
        { id: 10, name: "Jane Doe", email: "jane@example.com", phone: "+44 7700 900123", phone_sanitized: "+447700900123", city: "Leeds", country_id: [233, "United Kingdom"], is_company: false, parent_id: false, customer_rank: 2, active: true },
        { id: 11, name: "Acme Robotics", email: "buy@acme.example", is_company: true, parent_id: false, customer_rank: 1, vat: "GB123456789", active: true },
      ],
    },
    "res.country": {
      fields: ["name", "code"],
      records: [
        { id: 233, name: "United Kingdom", code: "GB" },
        { id: 75, name: "France", code: "FR" },
      ],
    },
    "sale.order": {
      fields: ["name", "partner_id", "date_order", "state", "amount_total", "amount_untaxed", "currency_id", "invoice_status", "delivery_status", "client_order_ref", "commitment_date", "validity_date", "website_id", "order_line", "picking_ids", "invoice_ids", "note"],
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
    "mail.compose.message": { fields: ["body", "subject"], records: [] },
    "loyalty.program": {
      fields: ["name", "program_type", "trigger", "applies_on", "active", "date_from", "date_to", "website_id", "limit_usage", "max_usage", "rule_ids", "reward_ids"],
      records: [
        { id: 1, name: "Spring 10% off", program_type: "promotion", trigger: "auto", applies_on: "current", active: true, date_from: "2026-03-01", date_to: false, website_id: [1, "Desktop Machine Shop"], limit_usage: false, max_usage: 0, rule_ids: [1], reward_ids: [1] },
        { id: 2, name: "SUMMER25", program_type: "promo_code", trigger: "with_code", applies_on: "current", active: false, date_from: false, date_to: "2026-08-31", website_id: false, limit_usage: true, max_usage: 50, rule_ids: [2], reward_ids: [2] },
      ],
    },
    "loyalty.rule": {
      fields: ["code", "mode", "minimum_amount", "minimum_qty", "product_ids", "product_category_id", "reward_point_amount", "reward_point_mode"],
      records: [
        { id: 1, code: false, mode: "auto", minimum_amount: 50, minimum_qty: 0, product_ids: [], product_category_id: false, reward_point_amount: 1, reward_point_mode: "order" },
        { id: 2, code: "SUMMER25", mode: "with_code", minimum_amount: 0, minimum_qty: 0, product_ids: [], product_category_id: false, reward_point_amount: 1, reward_point_mode: "order" },
      ],
    },
    "loyalty.reward": {
      fields: ["reward_type", "description", "discount", "discount_mode", "discount_applicability", "discount_product_ids", "discount_max_amount", "reward_product_id", "reward_product_qty", "required_points"],
      records: [
        { id: 1, reward_type: "discount", description: "10% on your order", discount: 10, discount_mode: "percent", discount_applicability: "order", discount_product_ids: [], discount_max_amount: 0, reward_product_id: false, reward_product_qty: 1, required_points: 1 },
        { id: 2, reward_type: "discount", description: "£25 off", discount: 25, discount_mode: "per_order", discount_applicability: "order", discount_product_ids: [], discount_max_amount: 0, reward_product_id: false, reward_product_qty: 1, required_points: 1 },
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

/**
 * `demoModels` plus what the event poller reads: create/write dates, internal
 * users, delivery carriers, and the Helpdesk, Rating and reordering-rule
 * models (absent from `demoModels`, which stands for an instance without them).
 */
export function eventModels(): Record<string, FakeModel> {
  const m = demoModels();
  const extend = (name: string, fields: string[]) => (m[name] = { ...m[name]!, fields: [...m[name]!.fields, ...fields] });
  m["res.users"] = {
    fields: ["login", "name", "share", "partner_id", "active"],
    records: [
      { id: 7, login: "bot@example.com", name: "Command Centre", share: false, partner_id: [3, "Dave"], active: true },
      { id: 1, login: "__system__", name: "OdooBot", share: false, partner_id: [2, "OdooBot"], active: false },
      { id: 20, login: "jane@example.com", name: "Jane Doe", share: true, partner_id: [10, "Jane Doe"], active: true },
    ],
  };
  extend("sale.order", ["carrier_id", "amount_untaxed", "create_date", "write_date"]);
  extend("sale.order.line", ["is_delivery", "order_id"]);
  extend("mail.message", ["create_date", "is_internal", "record_name"]);
  extend("stock.picking", ["origin", "partner_id", "date_deadline"]);
  m["product.template"] = {
    fields: ["name", "website_id"],
    records: [
      { id: 11, name: "ER11 collet set (7 pcs)", website_id: [1, "Desktop Machine Shop"] },
      { id: 12, name: "300W spindle", website_id: [1, "Desktop Machine Shop"] },
      { id: 13, name: "Milo v2 CNC kit", website_id: false },
    ],
  };
  m["stock.warehouse.orderpoint"] = { fields: ["product_id", "product_min_qty", "product_max_qty"], records: [] };
  m["helpdesk.ticket"] = {
    fields: ["name", "ticket_ref", "partner_id", "partner_name", "partner_email", "description", "team_id", "stage_id", "priority", "create_date"],
    records: [],
  };
  m["crm.lead"] = {
    fields: ["name", "type", "partner_id", "partner_name", "contact_name", "email_from", "phone", "description", "expected_revenue", "team_id", "source_id", "create_uid", "create_date"],
    records: [],
  };
  m["purchase.order"] = {
    fields: ["name", "state", "partner_id", "amount_total", "currency_id", "date_planned"],
    records: [{ id: 70, name: "P00070", state: "sent", partner_id: [30, "Spindle Supplies Ltd"], amount_total: 820, currency_id: [1, "GBP"], date_planned: "2026-11-05 09:00:00" }],
  };
  m["rating.rating"] = {
    fields: ["rating", "feedback", "res_model", "res_id", "res_name", "partner_id", "message_id", "consumed", "publisher_comment", "create_date", "write_date"],
    records: [],
  };
  return m;
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
    case "=ilike": {
      // No implicit wildcards, but % and _ in the pattern work as in SQL.
      const pattern = String(value).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
      return raw !== false && new RegExp(`^${pattern}$`, "s").test(label);
    }
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

/**
 * `eventModels` plus what the day-to-day tools and actions use: invoice lines, payments, stock
 * moves, quants and locations, purchase lines and vendor prices, activities, CRM and helpdesk
 * stages, and the wizards behind Odoo's buttons.
 */
export function dailyModels(): Record<string, FakeModel> {
  const m = eventModels();
  const extend = (name: string, fields: string[], records: Rec[] = []) =>
    (m[name] = { fields: [...m[name]!.fields, ...fields], records: [...(m[name]!.records ?? []), ...records] });
  extend("product.product", ["purchase_ok"]);
  extend("res.partner", [], [{ id: 30, name: "Spindle Supplies Ltd", email: "sales@spindles.example", is_company: true, parent_id: false, customer_rank: 0, active: true }]);
  extend("account.move", ["currency_id", "ref", "invoice_line_ids", "amount_untaxed", "amount_tax", "invoice_payment_term_id", "narration"], [
    { id: 9, name: "INV/2026/00009", state: "posted", payment_state: "not_paid", move_type: "out_invoice", invoice_date: "2026-08-01", invoice_date_due: "2026-08-31", amount_total: 1500, amount_residual: 1500, invoice_origin: "S00039", partner_id: [11, "Acme Robotics"], invoice_line_ids: [1], amount_untaxed: 1250, amount_tax: 250 },
    { id: 10, name: "INV/2026/00010", state: "posted", payment_state: "partial", move_type: "out_invoice", invoice_date: "2026-10-25", invoice_date_due: "2026-11-24", amount_total: 240, amount_residual: 100, invoice_origin: "S00040", partner_id: [10, "Jane Doe"] },
    { id: 11, name: false, state: "draft", payment_state: "not_paid", move_type: "out_invoice", invoice_date: false, invoice_date_due: false, amount_total: 60, amount_residual: 60, partner_id: [10, "Jane Doe"] },
    { id: 12, name: "BILL/2026/00003", state: "posted", payment_state: "not_paid", move_type: "in_invoice", invoice_date: "2026-10-01", invoice_date_due: "2026-10-31", amount_total: 820, amount_residual: 820, invoice_origin: "P00070", partner_id: [30, "Spindle Supplies Ltd"] },
  ]);
  m["account.move.line"] = {
    fields: ["product_id", "name", "quantity", "price_unit", "discount", "price_subtotal", "price_total", "tax_ids", "display_type"],
    records: [{ id: 1, product_id: [3, "[MILO-V2] Milo v2 CNC kit"], name: "Milo v2 CNC kit", quantity: 1, price_unit: 1250, discount: 0, price_subtotal: 1250, price_total: 1500, tax_ids: [1], display_type: "product" }],
  };
  m["account.payment"] = {
    fields: ["name", "date", "partner_id", "amount", "currency_id", "payment_type", "journal_id", "state", "memo", "reconciled_invoice_ids", "reconciled_bill_ids"],
    records: [{ id: 1, name: "PBNK/2026/00001", date: "2026-10-20", partner_id: [10, "Jane Doe"], amount: 113.5, currency_id: [1, "GBP"], payment_type: "inbound", journal_id: [6, "Bank"], state: "paid", memo: "S00042", reconciled_invoice_ids: [8], reconciled_bill_ids: [] }],
  };
  m["sale.advance.payment.inv"] = { fields: ["advance_payment_method"], records: [] };
  m["account.payment.register"] = { fields: ["amount", "payment_date", "journal_id", "communication"], records: [] };
  m["account.move.send.wizard"] = { fields: [], records: [] };
  m["sale.order.cancel"] = { fields: [], records: [] };
  extend("stock.picking", ["move_ids", "backorder_ids", "purchase_id", "location_id", "location_dest_id", "note", "carrier_tracking_url"], [
    { id: 6, name: "WH/IN/00004", state: "assigned", picking_type_code: "incoming", scheduled_date: "2026-11-05 09:00:00", date_done: false, partner_id: [30, "Spindle Supplies Ltd"], origin: "P00070", move_ids: [2], backorder_ids: [], purchase_id: [70, "P00070"] },
  ]);
  m["stock.picking"]!.records![0] = { ...m["stock.picking"]!.records![0]!, partner_id: [10, "Jane Doe"], origin: "S00042", move_ids: [1], backorder_ids: [], location_id: [8, "WH/Stock"], location_dest_id: [5, "Partners/Customers"] };
  m["stock.move"] = {
    fields: ["product_id", "product_uom_qty", "quantity", "product_uom", "state"],
    records: [
      { id: 1, product_id: [2, "[SP-300W] 300W spindle"], product_uom_qty: 1, quantity: 1, product_uom: [1, "Units"], state: "assigned" },
      { id: 2, product_id: [2, "[SP-300W] 300W spindle"], product_uom_qty: 10, quantity: 6, product_uom: [1, "Units"], state: "assigned" },
    ],
  };
  m["stock.backorder.confirmation"] = { fields: [], records: [] };
  m["stock.location"] = {
    fields: ["name", "usage"],
    records: [
      { id: 8, name: "WH/Stock", usage: "internal" },
      { id: 9, name: "WH/Stock/Shelf 2", usage: "internal" },
      { id: 5, name: "Partners/Customers", usage: "customer" },
    ],
  };
  m["stock.warehouse"] = { fields: ["name", "lot_stock_id"], records: [{ id: 1, name: "WH", lot_stock_id: [8, "WH/Stock"] }] };
  m["stock.quant"] = {
    fields: ["product_id", "location_id", "quantity", "reserved_quantity", "lot_id", "inventory_quantity"],
    records: [
      { id: 1, product_id: [2, "[SP-300W] 300W spindle"], location_id: [8, "WH/Stock"], quantity: 9, reserved_quantity: 1, lot_id: false },
      { id: 2, product_id: [2, "[SP-300W] 300W spindle"], location_id: [9, "WH/Stock/Shelf 2"], quantity: 3, reserved_quantity: 0, lot_id: false },
      { id: 3, product_id: [2, "[SP-300W] 300W spindle"], location_id: [5, "Partners/Customers"], quantity: 40, reserved_quantity: 0, lot_id: false },
    ],
  };
  extend("purchase.order", ["partner_ref", "date_order", "amount_untaxed", "receipt_status", "invoice_status", "order_line", "picking_ids", "invoice_ids", "notes"]);
  Object.assign(m["purchase.order"]!.records![0]!, { date_order: "2026-10-28 09:00:00", order_line: [1], picking_ids: [6], invoice_ids: [12], receipt_status: "partial", amount_untaxed: 683.33 });
  m["purchase.order.line"] = {
    fields: ["product_id", "name", "product_qty", "qty_received", "qty_invoiced", "price_unit", "price_subtotal", "date_planned", "display_type"],
    records: [{ id: 1, product_id: [2, "[SP-300W] 300W spindle"], name: "300W spindle", product_qty: 10, qty_received: 6, qty_invoiced: 10, price_unit: 41, price_subtotal: 410, date_planned: "2026-11-05 09:00:00", display_type: false }],
  };
  m["product.supplierinfo"] = {
    fields: ["partner_id", "product_code", "product_name", "price", "currency_id", "min_qty", "delay", "date_start", "date_end", "product_id", "product_tmpl_id", "sequence"],
    records: [{ id: 1, partner_id: [30, "Spindle Supplies Ltd"], product_code: "SS-300", price: 41, currency_id: [1, "GBP"], min_qty: 5, delay: 7, product_id: false, product_tmpl_id: [12, "300W spindle"], sequence: 1 }],
  };
  m["ir.model"] = { fields: ["model", "name"], records: [{ id: 101, model: "sale.order", name: "Sales Order" }, { id: 102, model: "res.partner", name: "Contact" }] };
  m["ir.model.data"] = {
    fields: ["module", "name", "model", "res_id"],
    records: [
      { id: 1, module: "mail", name: "mail_activity_data_todo", model: "mail.activity.type", res_id: 4 },
      { id: 2, module: "mail", name: "mail_activity_data_call", model: "mail.activity.type", res_id: 2 },
    ],
  };
  m["mail.activity"] = {
    fields: ["res_model", "res_model_id", "res_id", "res_name", "activity_type_id", "summary", "note", "date_deadline", "user_id", "state"],
    records: [
      { id: 1, res_model: "sale.order", res_id: 41, res_name: "S00041", activity_type_id: [2, "Call"], summary: "Chase Acme on the Milo quote", note: false, date_deadline: "2026-09-10", user_id: [7, "Command Centre"], state: "overdue" },
      { id: 2, res_model: "res.partner", res_id: 10, res_name: "Jane Doe", activity_type_id: [4, "To-Do"], summary: "Send collet guide", note: "<p>PDF from the brain</p>", date_deadline: "2099-01-01", user_id: [7, "Command Centre"], state: "planned" },
    ],
  };
  extend("crm.lead", ["stage_id", "user_id", "probability", "active", "date_deadline", "priority", "lost_reason_id"], [
    { id: 1, name: "School makerspace: 6 Milo kits", type: "opportunity", partner_id: false, partner_name: "Leeds College", contact_name: "Sam Patel", email_from: "sam@leeds.example", stage_id: [2, "Qualified"], user_id: [7, "Command Centre"], expected_revenue: 7500, probability: 30, active: true, create_date: "2026-10-30 10:00:00" },
  ]);
  m["crm.stage"] = {
    fields: ["name", "is_won", "sequence"],
    records: [
      { id: 1, name: "New", is_won: false },
      { id: 2, name: "Qualified", is_won: false },
      { id: 3, name: "Proposition", is_won: false },
      { id: 4, name: "Won", is_won: true },
    ],
  };
  m["crm.lost.reason"] = { fields: ["name"], records: [{ id: 1, name: "Too expensive" }] };
  extend("helpdesk.ticket", ["user_id", "close_date", "fold"], [
    { id: 1, name: "Spindle runs hot", ticket_ref: "17", partner_id: [10, "Jane Doe"], partner_email: "jane@example.com", team_id: [1, "Support"], stage_id: [1, "New"], priority: "1", create_date: "2026-11-01 09:00:00", close_date: false, fold: false, user_id: false, description: "<p>After 10 minutes it is too hot to touch.</p>" },
  ]);
  m["helpdesk.stage"] = {
    fields: ["name", "team_ids"],
    records: [
      { id: 1, name: "New", team_ids: [1] },
      { id: 2, name: "In Progress", team_ids: [1] },
      { id: 3, name: "Solved", team_ids: [1] },
    ],
  };
  return m;
}

/**
 * `dailyModels` with real field metadata on the models the generic tools and actions
 * (describe_model, get_record, odoo.record.*) are tested on, plus pricelists, tags and the
 * protected models the denylist refuses.
 */
export function recordModels(): Record<string, FakeModel> {
  const m = dailyModels();
  const char = (string: string, more: Partial<FakeField> = {}): FakeField => ({ type: "char", string, ...more });
  m["res.partner"]!.defs = {
    name: char("Name", { required: true }),
    email: char("Email"),
    phone: char("Phone"),
    city: char("City"),
    ref: char("Reference"),
    comment: { type: "html", string: "Notes" },
    active: { type: "boolean", string: "Active" },
    is_company: { type: "boolean", string: "Is a Company" },
    parent_id: { type: "many2one", string: "Related Company", relation: "res.partner" },
    country_id: { type: "many2one", string: "Country", relation: "res.country" },
    customer_rank: { type: "integer", string: "Customer Rank" },
    credit_limit: { type: "float", string: "Credit Limit" },
    type: { type: "selection", string: "Address Type", selection: [["contact", "Contact"], ["invoice", "Invoice Address"], ["delivery", "Delivery Address"]] },
    category_id: { type: "many2many", string: "Tags", relation: "res.partner.category" },
    bank_ids: { type: "one2many", string: "Banks", relation: "res.partner.bank" },
    child_ids: { type: "one2many", string: "Contacts", relation: "res.partner" },
    user_ids: { type: "one2many", string: "Users", relation: "res.users" },
    image_1920: { type: "image", string: "Image" },
    x_bank_id: { type: "many2one", string: "Pays into", relation: "res.partner.bank" },
    commercial_partner_id: { type: "many2one", string: "Commercial Entity", relation: "res.partner", readonly: true },
    signup_token: char("Signup Token"),
    date: { type: "date", string: "Date" },
  };
  m["res.partner"]!.records!.push({ id: 7, name: "Command Centre", email: "bot@example.com", is_company: false, parent_id: false, active: true, user_ids: [7] });
  m["res.partner"]!.records!.push({ id: 31, name: "Old Supplier Co", email: "old@supplier.example", is_company: true, parent_id: false, customer_rank: 0, active: false });
  m["res.partner.category"] = { fields: ["name"], records: [{ id: 1, name: "Trade" }, { id: 2, name: "School" }] };
  m["res.partner.bank"] = { fields: ["acc_number", "partner_id"], records: [] };
  m["res.groups"] = { fields: ["name"], records: [{ id: 1, name: "Administrator" }] };
  m["ir.config_parameter"] = { fields: ["key", "value"], records: [] };
  m["product.template"] = {
    fields: ["name", "list_price", "active"],
    records: [{ id: 11, name: "ER11 collet set (7 pcs)", list_price: 24.5, active: true }, { id: 12, name: "300W spindle", list_price: 89, active: true }, { id: 13, name: "Milo v2 CNC kit", list_price: 1250, active: true }],
  };
  m["product.pricelist"] = { fields: ["name", "active"], records: [{ id: 1, name: "Trade (GBP)", active: true }] };
  m["product.pricelist.item"] = {
    fields: [],
    defs: {
      pricelist_id: { type: "many2one", string: "Pricelist", relation: "product.pricelist", required: true },
      product_tmpl_id: { type: "many2one", string: "Product", relation: "product.template" },
      applied_on: { type: "selection", string: "Apply On", required: true, selection: [["3_global", "All Products"], ["2_product_category", "Product Category"], ["1_product", "Product"], ["0_product_variant", "Product Variant"]] },
      compute_price: { type: "selection", string: "Compute Price", selection: [["fixed", "Fixed Price"], ["percentage", "Discount"], ["formula", "Formula"]] },
      fixed_price: { type: "float", string: "Fixed Price" },
      min_quantity: { type: "float", string: "Min. Quantity" },
      date_start: { type: "datetime", string: "Start Date" },
      date_end: { type: "datetime", string: "End Date" },
      price: char("Price", { readonly: true, store: false }),
    },
    records: [
      { id: 1, display_name: "300W spindle: 79.00", pricelist_id: [1, "Trade (GBP)"], product_tmpl_id: [12, "300W spindle"], applied_on: "1_product", compute_price: "fixed", fixed_price: 79, min_quantity: 1 },
      { id: 2, display_name: "ER11 collet set (7 pcs): 21.00", pricelist_id: [1, "Trade (GBP)"], product_tmpl_id: [11, "ER11 collet set (7 pcs)"], applied_on: "1_product", compute_price: "fixed", fixed_price: 21, min_quantity: 1 },
      { id: 3, display_name: "Milo v2 CNC kit: 1150.00", pricelist_id: [1, "Trade (GBP)"], product_tmpl_id: [13, "Milo v2 CNC kit"], applied_on: "1_product", compute_price: "fixed", fixed_price: 1150, min_quantity: 1 },
    ],
  };
  m["crm.stage"]!.defs = { name: char("Stage Name", { required: true }), sequence: { type: "integer", string: "Sequence" } };
  m["account.move"]!.defs = {
    state: { type: "selection", string: "Status", selection: [["draft", "Draft"], ["posted", "Posted"], ["cancel", "Cancelled"]], readonly: true },
    ref: char("Reference"),
    invoice_date: { type: "date", string: "Invoice Date" },
    invoice_date_due: { type: "date", string: "Due Date" },
  };
  m["sale.order"]!.defs = { state: { type: "selection", string: "Status", selection: [["draft", "Quotation"], ["sent", "Quotation Sent"], ["sale", "Sales Order"], ["cancel", "Cancelled"]], readonly: true } };
  m["ir.model"] = {
    fields: ["model", "name", "transient"],
    records: [
      { id: 101, model: "sale.order", name: "Sales Order", transient: false },
      { id: 102, model: "res.partner", name: "Contact", transient: false },
      { id: 103, model: "product.pricelist.item", name: "Pricelist Rule", transient: false },
      { id: 104, model: "product.pricelist", name: "Pricelist", transient: false },
      { id: 105, model: "sale.order.cancel", name: "Sales Order Cancel", transient: true },
      { id: 106, model: "res.users", name: "User", transient: false },
    ],
  };
  return m;
}
