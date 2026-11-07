import { z } from "zod";
import { type Domain, OdooError, type OdooRecord, OdooRpcError } from "./client";
import type { OdooActionExecutor, OdooWriter } from "./executors";
import { defined, parse } from "./payload";
import { previewExistingQuote, QuoteLookupError, quoteNote } from "./quote-preview";

/**
 * The day-to-day Odoo writes: confirming, changing and cancelling orders, invoicing and
 * payments, deliveries and stock counts, purchasing, products, contacts, activities, CRM and
 * helpdesk. Like every `odoo.*` action they always wait for Dave's approval
 * (ODOO_WRITE_POLICY in @cc/core); `prepare` adds what Odoo says now to the approval.
 */

const Id = z.number().int().positive();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const ById = z.object({ id: Id });

const name = (v: unknown) => (Array.isArray(v) ? String(v[1]) : null);
const money = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "?");

/** A button's answer when Odoo wants more input first: a wizard window. */
interface WindowAction {
  type?: string;
  res_model?: string;
  res_id?: number;
  context?: Record<string, unknown>;
}
const isWindow = (r: unknown): r is WindowAction & { res_model: string } =>
  !!r && typeof r === "object" && (r as WindowAction).type === "ir.actions.act_window" && typeof (r as WindowAction).res_model === "string";

/** Opens the wizard an action names (or the one it already created) and presses `method` on it. */
async function finishWizard(client: OdooWriter, action: WindowAction & { res_model: string }, method: string, values: Record<string, unknown> = {}) {
  const context = action.context ?? {};
  const id = action.res_id || (await client.create(action.res_model, values, context));
  return client.call(action.res_model, method, [[id]], { context });
}

/** Creates a wizard for records of `model` (as its form button would) and presses `method`. */
async function runWizard(client: OdooWriter, wizard: string, model: string, ids: number[], values: Record<string, unknown>, method: string) {
  const context = { active_model: model, active_ids: ids, active_id: ids[0] };
  const id = await client.create(wizard, values, context);
  return client.call(wizard, method, [[id]], { context });
}

/** Emails a record the way its Send button does: the composer that `method` opens, then sent. */
async function sendByComposer(client: OdooWriter, model: string, id: number, method: string) {
  const action = (await client.call(model, method, [[id]])) as WindowAction | null;
  const context = action?.context;
  if (!context || (action.res_model && action.res_model !== "mail.compose.message")) throw new OdooError("Odoo did not open the email composer");
  const composer = await client.create("mail.compose.message", {}, context);
  await client.call("mail.compose.message", "action_send_mail", [[composer]], { context });
}

async function one(client: OdooWriter, model: string, id: number, fields: string[], what: string): Promise<OdooRecord> {
  const available = await client.fields(model);
  if (!available) throw new OdooRpcError(`Odoo has no ${model} model`, "missing_model", "KeyError");
  const [r] = await client.read(model, [id], fields.filter((f) => available.has(f)));
  if (!r) throw new OdooError(`No ${what} with id ${id}`);
  return r;
}

async function requireFields(client: OdooWriter, model: string, hint: string): Promise<Set<string>> {
  const fields = await client.fields(model);
  if (!fields) throw new OdooRpcError(`Odoo has no ${model} model (${hint})`, "missing_model", "KeyError");
  return fields;
}

/** Refuses values for fields this Odoo doesn't have, rather than letting a change half-apply. */
function onlyKnown(fields: Set<string>, values: Record<string, unknown>, what: string) {
  for (const key of Object.keys(values)) if (!fields.has(key)) throw new OdooError(`This Odoo's ${what} have no ${key}`);
  return values;
}

/** The id of the record whose name is `wanted` (exact first, then contains), or an error listing the choices. */
async function byName(client: OdooWriter, model: string, wanted: string, extra: Domain = []): Promise<number> {
  const exact = await client.searchRead(model, [...extra, ["name", "=ilike", wanted]], ["name"], { limit: 1 });
  if (exact[0]) return exact[0].id;
  const like = await client.searchRead(model, [...extra, ["name", "ilike", wanted]], ["name"], { limit: 2 });
  if (like.length === 1) return like[0]!.id;
  const all = await client.searchRead(model, extra, ["name"], { limit: 30 });
  throw new OdooError(`No single ${model} named "${wanted}". Choose one of: ${all.map((r) => r.name).join(", ")}`);
}

/** Note for an approval, or a note that Odoo couldn't be read; a record that doesn't exist refuses the proposal. */
async function noted(payload: Record<string, unknown>, look: () => Promise<string>) {
  try {
    return { payload, note: await look() };
  } catch (err) {
    // A record that doesn't exist (a plain OdooError) or a refusal from Odoo is the proposal's problem.
    if (!(err instanceof OdooError) || err.constructor === OdooError || err instanceof QuoteLookupError || (err instanceof OdooRpcError && err.kind === "user")) throw err;
    return { payload, note: `[Could not look this up in Odoo: ${err.message}]` };
  }
}

const OrderLine = z.object({
  product_id: Id,
  qty: z.number().positive(),
  price_unit: z.number().nonnegative().optional(),
  discount: z.number().min(0).max(100).optional(),
  description: z.string().min(1).optional(),
});

const QuoteUpdate = z
  .object({
    id: Id,
    add_lines: z.array(OrderLine).optional(),
    update_lines: z
      .array(z.object({ line_id: Id, qty: z.number().positive().optional(), price_unit: z.number().nonnegative().optional(), discount: z.number().min(0).max(100).optional(), description: z.string().min(1).optional() }))
      .optional(),
    remove_line_ids: z.array(Id).optional(),
    validity_date: Day.optional(),
    commitment_date: Day.optional(),
    client_order_ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "id"), "nothing to change");

const PaymentRegister = z.object({
  id: Id,
  amount: z.number().positive().optional(),
  date: Day.optional(),
  journal_id: Id.optional(),
  memo: z.string().min(1).optional(),
});

const PurchaseCreate = z.object({
  partner_id: Id,
  lines: z.array(OrderLine.omit({ discount: true })).min(1),
  date_planned: Day.optional(),
  partner_ref: z.string().min(1).optional(),
  send: z.boolean().default(false),
});

const DeliveryValidate = z.object({ id: Id, backorder: z.boolean().default(true) });
const Tracking = z.object({ id: Id, tracking_ref: z.string().trim().min(3), carrier_id: Id.optional() });
const StockAdjust = z.object({ product_id: Id, quantity: z.number().nonnegative(), location_id: Id.optional() });

const ProductCreate = z.object({
  name: z.string().trim().min(2),
  sku: z.string().trim().min(1).optional(),
  list_price: z.number().nonnegative(),
  standard_price: z.number().nonnegative().optional(),
  kind: z.enum(["goods", "service"]).default("goods"),
  storable: z.boolean().default(true),
  weight: z.number().nonnegative().optional(),
  barcode: z.string().trim().min(1).optional(),
  category_id: Id.optional(),
  description_sale: z.string().min(1).optional(),
  sale_ok: z.boolean().default(true),
  purchase_ok: z.boolean().default(true),
});

const ProductUpdate = z
  .object({
    id: Id,
    name: z.string().trim().min(2).optional(),
    sku: z.string().trim().min(1).optional(),
    description_sale: z.string().optional(),
    standard_price: z.number().nonnegative().optional(),
    weight: z.number().nonnegative().optional(),
    barcode: z.string().trim().min(1).optional(),
    category_id: Id.optional(),
    sale_ok: z.boolean().optional(),
    purchase_ok: z.boolean().optional(),
    website_published: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "id"), "nothing to change");

const CustomerUpdate = z
  .object({
    id: Id,
    name: z.string().trim().min(2).optional(),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().min(5).optional(),
    mobile: z.string().trim().min(5).optional(),
    street: z.string().trim().optional(),
    street2: z.string().trim().optional(),
    city: z.string().trim().optional(),
    zip: z.string().trim().optional(),
    country_code: z.string().regex(/^[A-Za-z]{2}$/, "a two-letter country code, e.g. GB").optional(),
    vat: z.string().trim().optional(),
    ref: z.string().trim().optional(),
    company_id: Id.optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "id"), "nothing to change");

const ACTIVITY_TYPES = { todo: "mail.mail_activity_data_todo", call: "mail.mail_activity_data_call", email: "mail.mail_activity_data_email", meeting: "mail.mail_activity_data_meeting" } as const;
const ActivitySchedule = z.object({
  model: z.string().regex(/^[a-z0-9_.]+$/, "an Odoo model name, e.g. sale.order"),
  id: Id,
  summary: z.string().trim().min(1),
  note: z.string().min(1).optional(),
  due: Day,
  type: z.enum(["todo", "call", "email", "meeting"]).default("todo"),
  user_id: Id.optional(),
});
const ActivityDone = z.object({ id: Id, feedback: z.string().min(1).optional() });

const LeadCreate = z
  .object({
    name: z.string().trim().min(2),
    type: z.enum(["lead", "opportunity"]).default("opportunity"),
    partner_id: Id.optional(),
    contact_name: z.string().trim().min(1).optional(),
    company_name: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().min(5).optional(),
    expected_revenue: z.number().nonnegative().optional(),
    description: z.string().min(1).optional(),
    user_id: Id.optional(),
  })
  .refine((p) => p.partner_id || p.email || p.phone || p.contact_name, "partner_id, email, phone or contact_name is required");

const LeadUpdate = z
  .object({
    id: Id,
    stage: z.string().trim().min(1).optional(),
    expected_revenue: z.number().nonnegative().optional(),
    probability: z.number().min(0).max(100).optional(),
    user_id: Id.optional(),
    outcome: z.enum(["won", "lost"]).optional(),
    lost_reason: z.string().trim().min(1).optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "id"), "nothing to change")
  .refine((p) => !p.lost_reason || p.outcome === "lost", "lost_reason is only for outcome lost");

const TicketUpdate = z
  .object({ id: Id, stage: z.string().trim().min(1).optional(), user_id: Id.optional(), priority: z.enum(["0", "1", "2", "3"]).optional() })
  .refine((p) => p.stage || p.user_id || p.priority, "nothing to change");

const lineValues = (l: { product_id?: number; qty?: number; price_unit?: number; discount?: number; description?: string }, qtyField: string) =>
  defined({ product_id: l.product_id, [qtyField]: l.qty, price_unit: l.price_unit, discount: l.discount, name: l.description });

async function countryId(client: OdooWriter, code: string | undefined) {
  if (!code) return undefined;
  const [country] = await client.searchRead("res.country", [["code", "=ilike", code]], ["name"], { limit: 1 });
  if (!country) throw new OdooError(`No country with code ${code.toUpperCase()}`);
  return country.id;
}

const ids = (v: unknown) => (Array.isArray(v) ? (v as number[]) : []);

export function createDailyExecutors(client: OdooWriter): Record<string, OdooActionExecutor> {
  const quoteLook = (id: number) => async () => quoteNote(await previewExistingQuote(client, id));

  const invoiceNote = async (id: number) => {
    const m = await one(client, "account.move", id, ["name", "partner_id", "state", "payment_state", "amount_total", "amount_residual", "move_type"], "invoice");
    return `[${String(m.name || "Draft")} for ${name(m.partner_id) ?? "?"}: ${m.state}, ${m.payment_state ?? "?"}, total ${money(m.amount_total)}, owed ${money(m.amount_residual)}.]`;
  };

  return {
    "odoo.order.confirm": {
      description:
        "Confirm a quotation into a sales order (Odoo's Confirm button): reserves stock and creates the delivery. payload: { id } (sales order id, from search_orders/get_order; draft or sent). The approval shows the quote's customer, lines and totals.",
      async prepare(payload) {
        const p = parse(ById, payload);
        return noted(payload, quoteLook(p.id));
      },
      async execute(payload) {
        const p = parse(ById, payload);
        const o = await one(client, "sale.order", p.id, ["name", "state"], "sales order");
        if (o.state !== "draft" && o.state !== "sent") throw new OdooError(`${o.name} is ${o.state}, not a quotation`);
        await client.call("sale.order", "action_confirm", [[p.id]]);
        const after = await one(client, "sale.order", p.id, ["name", "state"], "sales order");
        return { id: p.id, name: after.name, state: after.state };
      },
    },

    "odoo.order.cancel": {
      description:
        "Cancel a quotation or sales order (Odoo's Cancel button); its open deliveries are cancelled too. payload: { id }. Can't undo a done delivery or a posted invoice: refund those in Odoo.",
      async prepare(payload) {
        const p = parse(ById, payload);
        return noted(payload, quoteLook(p.id));
      },
      async execute(payload) {
        const p = parse(ById, payload);
        const o = await one(client, "sale.order", p.id, ["name", "state"], "sales order");
        if (o.state === "cancel") return { id: p.id, name: o.name, state: "cancel", was: "cancel" };
        const context = { disable_cancel_warning: true };
        const result = await client.call("sale.order", "action_cancel", [[p.id]], { context });
        if (isWindow(result)) await finishWizard(client, { ...result, context: { ...result.context, ...context } }, "action_cancel");
        const after = await one(client, "sale.order", p.id, ["name", "state"], "sales order");
        return { id: p.id, name: after.name, state: after.state, was: o.state };
      },
    },

    "odoo.quote.update": {
      description:
        "Change a quotation (draft or sent): add_lines [{ product_id, qty, price_unit?, discount?, description? }], update_lines [{ line_id, qty?, price_unit?, discount?, description? }], remove_line_ids [line ids], validity_date?, commitment_date? (promised delivery, YYYY-MM-DD), client_order_ref?, note?. payload: { id, ... }. Line ids from get_order. The approval shows the quote as it is now.",
      async prepare(payload) {
        const p = parse(QuoteUpdate, payload);
        return noted(payload, quoteLook(p.id));
      },
      async execute(payload) {
        const p = parse(QuoteUpdate, payload);
        const o = await one(client, "sale.order", p.id, ["name", "state", "order_line"], "sales order");
        if (o.state !== "draft" && o.state !== "sent") throw new OdooError(`${o.name} is ${o.state}; only a quotation can be changed this way`);
        const own = new Set(ids(o.order_line));
        for (const id of [...(p.update_lines?.map((l) => l.line_id) ?? []), ...(p.remove_line_ids ?? [])]) {
          if (!own.has(id)) throw new OdooError(`Line ${id} is not on ${o.name}`);
        }
        const commands = [
          ...(p.add_lines ?? []).map((l) => [0, 0, lineValues(l, "product_uom_qty")]),
          ...(p.update_lines ?? []).map((l) => [1, l.line_id, lineValues(l, "product_uom_qty")]),
          ...(p.remove_line_ids ?? []).map((id) => [2, id]),
        ];
        const values = defined({
          order_line: commands.length ? commands : undefined,
          validity_date: p.validity_date,
          commitment_date: p.commitment_date,
          client_order_ref: p.client_order_ref,
          note: p.note,
        });
        await client.write("sale.order", [p.id], values);
        const after = await one(client, "sale.order", p.id, ["name", "state", "amount_untaxed", "amount_total"], "sales order");
        return { id: p.id, name: after.name, untaxed: after.amount_untaxed ?? null, total: after.amount_total ?? null };
      },
    },

    "odoo.invoice.create": {
      description:
        "Create the draft invoice for a confirmed sales order, for what has been delivered (or ordered, per the product's invoicing policy), like Odoo's Create Invoice button. payload: { order_id }. The invoice stays a draft: post it with odoo.invoice.post.",
      async prepare(payload) {
        const p = parse(z.object({ order_id: Id }), payload);
        return noted(payload, quoteLook(p.order_id));
      },
      async execute(payload) {
        const p = parse(z.object({ order_id: Id }), payload);
        const o = await one(client, "sale.order", p.order_id, ["name", "state", "invoice_status", "invoice_ids"], "sales order");
        if (o.state !== "sale") throw new OdooError(`${o.name} is ${o.state}; only a confirmed sales order can be invoiced`);
        if (o.invoice_status && o.invoice_status !== "to invoice") throw new OdooError(`${o.name} has nothing to invoice (invoice status ${o.invoice_status})`);
        const before = new Set(ids(o.invoice_ids));
        await runWizard(client, "sale.advance.payment.inv", "sale.order", [p.order_id], { advance_payment_method: "delivered" }, "create_invoices");
        const after = await one(client, "sale.order", p.order_id, ["invoice_ids"], "sales order");
        const created = ids(after.invoice_ids).filter((id) => !before.has(id));
        const invoices = created.length ? await client.read("account.move", created, ["name", "state", "amount_total"]) : [];
        return { order: o.name, invoices: invoices.map((i) => ({ id: i.id, name: i.name || null, state: i.state, total: i.amount_total })) };
      },
    },

    "odoo.invoice.post": {
      description: "Post (validate) a draft invoice, credit note or vendor bill so it gets its number and counts in the books. payload: { id } (from search_invoices). The approval shows the partner and total.",
      async prepare(payload) {
        const p = parse(ById, payload);
        return noted(payload, () => invoiceNote(p.id));
      },
      async execute(payload) {
        const p = parse(ById, payload);
        const m = await one(client, "account.move", p.id, ["name", "state"], "invoice");
        if (m.state !== "draft") throw new OdooError(`${String(m.name)} is ${m.state}, not a draft`);
        await client.call("account.move", "action_post", [[p.id]]);
        const after = await one(client, "account.move", p.id, ["name", "state", "amount_total"], "invoice");
        return { id: p.id, name: after.name, state: after.state, total: after.amount_total };
      },
    },

    "odoo.invoice.send": {
      description:
        "Email a posted customer invoice or credit note to the customer with Odoo's invoice template (PDF and payment link), like the Send button. payload: { id }. Also use it to resend an unpaid invoice as a reminder.",
      async prepare(payload) {
        const p = parse(ById, payload);
        return noted(payload, () => invoiceNote(p.id));
      },
      async execute(payload) {
        const p = parse(ById, payload);
        const m = await one(client, "account.move", p.id, ["name", "state", "move_type", "partner_id"], "invoice");
        if (m.state !== "posted") throw new OdooError(`${String(m.name)} is ${m.state}; post it before sending`);
        if (m.move_type !== "out_invoice" && m.move_type !== "out_refund") throw new OdooError(`${String(m.name)} is not a customer invoice`);
        const action = await client.call("account.move", "action_invoice_sent", [[p.id]]);
        if (!isWindow(action)) throw new OdooError("Odoo did not open the invoice sending wizard");
        await finishWizard(client, action, action.res_model === "mail.compose.message" ? "action_send_mail" : "action_send_and_print");
        return { id: p.id, name: m.name, to: name(m.partner_id), sent: true };
      },
    },

    "odoo.invoice.register_payment": {
      description:
        "Record a payment received (or made, for a vendor bill) against a posted invoice, like Odoo's Register Payment button. payload: { id, amount? (default what is owed), date? (YYYY-MM-DD, default today), journal_id? (bank or cash journal, default Odoo's), memo? }. The approval shows what is owed.",
      async prepare(payload) {
        const p = parse(PaymentRegister, payload);
        return noted(payload, () => invoiceNote(p.id));
      },
      async execute(payload) {
        const p = parse(PaymentRegister, payload);
        const m = await one(client, "account.move", p.id, ["name", "state", "payment_state", "amount_residual"], "invoice");
        if (m.state !== "posted") throw new OdooError(`${String(m.name)} is ${m.state}; only a posted invoice can be paid`);
        if (m.payment_state === "paid" || m.payment_state === "in_payment") throw new OdooError(`${String(m.name)} is already ${m.payment_state}`);
        const values = defined({ amount: p.amount, payment_date: p.date, journal_id: p.journal_id, communication: p.memo });
        await runWizard(client, "account.payment.register", "account.move", [p.id], values, "action_create_payments");
        const after = await one(client, "account.move", p.id, ["name", "payment_state", "amount_residual"], "invoice");
        return { id: p.id, name: after.name, paid: p.amount ?? m.amount_residual, payment_state: after.payment_state, still_owed: after.amount_residual };
      },
    },

    "odoo.purchase.create": {
      description:
        "Create a request for quotation (draft purchase order) to a vendor, and optionally email it. payload: { partner_id (vendor), lines: [{ product_id, qty, price_unit? (default the vendor's price), description? }], date_planned? (YYYY-MM-DD), partner_ref? (vendor's reference), send? }.",
      async execute(payload) {
        const p = parse(PurchaseCreate, payload);
        const vendor = await one(client, "res.partner", p.partner_id, ["name", "email"], "contact");
        if (p.send && !vendor.email) throw new OdooError(`${String(vendor.name)} has no email address, so the RFQ can't be sent`);
        const values = defined({
          partner_id: p.partner_id,
          partner_ref: p.partner_ref,
          date_planned: p.date_planned ? `${p.date_planned} 09:00:00` : undefined,
          order_line: p.lines.map((l) => [0, 0, lineValues(l, "product_qty")]),
        });
        const id = await client.create("purchase.order", values);
        if (p.send) await sendByComposer(client, "purchase.order", id, "action_rfq_send");
        const po = await one(client, "purchase.order", id, ["name", "state", "amount_total"], "purchase order");
        return { id, name: po.name, vendor: vendor.name, state: po.state, total: po.amount_total ?? null, sent: p.send };
      },
    },

    "odoo.purchase.send": {
      description: "Email a request for quotation or purchase order to its vendor with Odoo's template (PDF), like the Send by Email button. payload: { id }.",
      async execute(payload) {
        const p = parse(ById, payload);
        const po = await one(client, "purchase.order", p.id, ["name", "state", "partner_id"], "purchase order");
        if (po.state === "cancel") throw new OdooError(`${String(po.name)} is cancelled`);
        await sendByComposer(client, "purchase.order", p.id, "action_rfq_send");
        const after = await one(client, "purchase.order", p.id, ["state"], "purchase order");
        return { id: p.id, name: po.name, to: name(po.partner_id), state: after.state, sent: true };
      },
    },

    "odoo.purchase.confirm": {
      description: "Confirm an RFQ into a purchase order (Odoo's Confirm Order button), creating the incoming receipt. payload: { id } (draft or sent).",
      async execute(payload) {
        const p = parse(ById, payload);
        const po = await one(client, "purchase.order", p.id, ["name", "state"], "purchase order");
        if (po.state !== "draft" && po.state !== "sent") throw new OdooError(`${String(po.name)} is ${po.state}, not an RFQ`);
        await client.call("purchase.order", "button_confirm", [[p.id]]);
        const after = await one(client, "purchase.order", p.id, ["name", "state"], "purchase order");
        return { id: p.id, name: after.name, state: after.state };
      },
    },

    "odoo.purchase.bill": {
      description: "Create the draft vendor bill for a confirmed purchase order (Odoo's Create Bill button), for what was received or ordered per the product's policy. payload: { id }. Post it with odoo.invoice.post.",
      async execute(payload) {
        const p = parse(ById, payload);
        const po = await one(client, "purchase.order", p.id, ["name", "state", "invoice_ids"], "purchase order");
        if (po.state !== "purchase" && po.state !== "done") throw new OdooError(`${String(po.name)} is ${po.state}; confirm it first`);
        const before = new Set(ids(po.invoice_ids));
        await client.call("purchase.order", "action_create_invoice", [[p.id]]);
        const after = await one(client, "purchase.order", p.id, ["invoice_ids"], "purchase order");
        const created = ids(after.invoice_ids).filter((id) => !before.has(id));
        const bills = created.length ? await client.read("account.move", created, ["name", "state", "amount_total"]) : [];
        return { order: po.name, bills: bills.map((b) => ({ id: b.id, name: b.name || null, state: b.state, total: b.amount_total })) };
      },
    },

    "odoo.delivery.validate": {
      description:
        "Validate a delivery or receipt (Odoo's Validate button): ships or receives the reserved quantities. payload: { id (from search_deliveries), backorder? }. When less than ordered is available, backorder=true (default) keeps the rest as a backorder, false drops it.",
      async prepare(payload) {
        const p = parse(DeliveryValidate, payload);
        return noted(payload, async () => {
          const t = await one(client, "stock.picking", p.id, ["name", "state", "partner_id", "origin", "move_ids"], "transfer");
          const moves = await client.read("stock.move", ids(t.move_ids), ["product_id", "product_uom_qty", "quantity"]).catch(() => [] as OdooRecord[]);
          const lines = moves.map((m) => `${m.quantity ?? "?"}/${String(m.product_uom_qty)} × ${name(m.product_id) ?? "?"}`).join("; ");
          return `[${String(t.name)} for ${name(t.partner_id) ?? "?"} (${String(t.origin || "no source")}), ${t.state}${lines ? `: ${lines}` : ""}.]`;
        });
      },
      async execute(payload) {
        const p = parse(DeliveryValidate, payload);
        const t = await one(client, "stock.picking", p.id, ["name", "state"], "transfer");
        if (t.state === "done" || t.state === "cancel") throw new OdooError(`${String(t.name)} is already ${t.state}`);
        let result = await client.call("stock.picking", "button_validate", [[p.id]]);
        for (let step = 0; step < 3 && isWindow(result); step++) {
          const method =
            result.res_model === "stock.backorder.confirmation" ? (p.backorder ? "process" : "process_cancel_backorder") : result.res_model === "stock.immediate.transfer" ? "process" : null;
          if (!method) throw new OdooError(`Odoo asked for ${result.res_model} to validate ${String(t.name)}; finish it in Odoo`);
          result = await finishWizard(client, result, method);
        }
        const after = await one(client, "stock.picking", p.id, ["name", "state", "backorder_ids"], "transfer");
        return { id: p.id, name: after.name, state: after.state, backorders: ids(after.backorder_ids).length };
      },
    },

    "odoo.delivery.set_tracking": {
      description: "Set the carrier tracking number (and optionally the carrier, by delivery.carrier id) on a delivery. payload: { id, tracking_ref, carrier_id? }.",
      async execute(payload) {
        const p = parse(Tracking, payload);
        const fields = await requireFields(client, "stock.picking", "is the Inventory app installed?");
        const t = await one(client, "stock.picking", p.id, ["name", "carrier_tracking_ref"], "transfer");
        await client.write("stock.picking", [p.id], onlyKnown(fields, defined({ carrier_tracking_ref: p.tracking_ref, carrier_id: p.carrier_id }), "transfers"));
        return { id: p.id, name: t.name, from: t.carrier_tracking_ref || null, to: p.tracking_ref };
      },
    },

    "odoo.stock.adjust": {
      description:
        "Set a product's counted on-hand quantity at a location (an inventory adjustment), e.g. after a stock count or finding damaged stock. payload: { product_id, quantity (the new total there, not a difference), location_id? (default the main warehouse's stock location) }. The approval shows the quantity now.",
      async prepare(payload) {
        const p = parse(StockAdjust, payload);
        return noted(payload, async () => {
          const product = await one(client, "product.product", p.product_id, ["display_name", "qty_available"], "product");
          return `[${String(product.display_name)}: ${String(product.qty_available ?? "?")} on hand in all locations now, counted ${p.quantity}.]`;
        });
      },
      async execute(payload) {
        const p = parse(StockAdjust, payload);
        await requireFields(client, "stock.quant", "is the Inventory app installed?");
        const product = await one(client, "product.product", p.product_id, ["display_name"], "product");
        let locationId = p.location_id;
        if (!locationId) {
          const [warehouse] = await client.searchRead("stock.warehouse", [], ["lot_stock_id"], { limit: 1, order: "id" });
          if (!warehouse || !Array.isArray(warehouse.lot_stock_id)) throw new OdooError("Odoo has no warehouse stock location; pass location_id");
          locationId = warehouse.lot_stock_id[0] as number;
        }
        const [quant] = await client.searchRead("stock.quant", [["product_id", "=", p.product_id], ["location_id", "=", locationId], ["lot_id", "=", false]], ["quantity", "location_id"], { limit: 1 });
        let quantId: number;
        if (quant) {
          quantId = quant.id;
          await client.write("stock.quant", [quantId], { inventory_quantity: p.quantity }, { inventory_mode: true });
        } else {
          quantId = await client.create("stock.quant", { product_id: p.product_id, location_id: locationId, inventory_quantity: p.quantity }, { inventory_mode: true });
        }
        await client.call("stock.quant", "action_apply_inventory", [[quantId]]);
        return { product: product.display_name, location_id: locationId, from: quant?.quantity ?? 0, to: p.quantity };
      },
    },

    "odoo.product.create": {
      description:
        "Create a product. payload: { name, sku?, list_price (net), standard_price? (cost), kind?: goods (default) | service, storable? (track stock, default true for goods), weight? (kg), barcode?, category_id?, description_sale?, sale_ok?, purchase_ok? }. search_products first; the approval lists products with the same SKU or barcode.",
      async prepare(payload) {
        const p = parse(ProductCreate, payload);
        return noted(payload, async () => {
          const checks: Domain[] = [];
          if (p.sku) checks.push([["default_code", "=ilike", p.sku]]);
          if (p.barcode) checks.push([["barcode", "=", p.barcode]]);
          checks.push([["name", "=ilike", p.name]]);
          const found = (await Promise.all(checks.map((d) => client.searchRead("product.product", d, ["display_name"], { limit: 3 })))).flat();
          const unique = [...new Map(found.map((f) => [f.id, f])).values()];
          return unique.length ? `[Already in Odoo: ${unique.map((f) => `${String(f.display_name)} #${f.id}`).join("; ")}.]` : "[No product with this SKU, barcode or name in Odoo.]";
        });
      },
      async execute(payload) {
        const p = parse(ProductCreate, payload);
        const fields = await requireFields(client, "product.product", "is the Sales or Inventory app installed?");
        const odoo18 = fields.has("is_storable");
        const stock = p.kind === "goods" && p.storable;
        const values = defined({
          name: p.name,
          default_code: p.sku,
          list_price: p.list_price,
          standard_price: p.standard_price,
          type: p.kind === "service" ? "service" : odoo18 ? "consu" : stock ? "product" : "consu",
          is_storable: odoo18 && p.kind === "goods" ? stock : undefined,
          weight: p.weight,
          barcode: p.barcode,
          categ_id: p.category_id,
          description_sale: p.description_sale,
          sale_ok: p.sale_ok,
          purchase_ok: fields.has("purchase_ok") ? p.purchase_ok : undefined,
        });
        const id = await client.create("product.product", onlyKnown(fields, values, "products"));
        return { id, name: p.name, sku: p.sku ?? null, list_price: p.list_price };
      },
    },

    "odoo.product.update": {
      description:
        "Change a product's details (not its sale price: that is odoo.product.update_price). payload: { id, name?, sku?, description_sale?, standard_price? (cost), weight?, barcode?, category_id?, sale_ok?, purchase_ok?, website_published? }. The approval shows the current values.",
      async prepare(payload) {
        const p = parse(ProductUpdate, payload);
        return noted(payload, async () => {
          const r = await one(client, "product.product", p.id, ["display_name", "default_code", "standard_price", "weight", "barcode", "is_published", "website_published", "sale_ok"], "product");
          return `[Now: ${String(r.display_name)}, cost ${money(r.standard_price)}, weight ${String(r.weight ?? "?")}, barcode ${String(r.barcode || "none")}.]`;
        });
      },
      async execute(payload) {
        const p = parse(ProductUpdate, payload);
        const fields = await requireFields(client, "product.product", "is the Sales or Inventory app installed?");
        const published = fields.has("is_published") ? "is_published" : "website_published";
        const values = defined({
          name: p.name,
          default_code: p.sku,
          description_sale: p.description_sale,
          standard_price: p.standard_price,
          weight: p.weight,
          barcode: p.barcode,
          categ_id: p.category_id,
          sale_ok: p.sale_ok,
          purchase_ok: p.purchase_ok,
          [published]: p.website_published,
        });
        onlyKnown(fields, values, "products");
        const [before] = await client.read("product.product", [p.id], Object.keys(values));
        if (!before) throw new OdooError(`No product with id ${p.id}`);
        await client.write("product.product", [p.id], values);
        const { id: _id, ...from } = before;
        return { id: p.id, from, to: values };
      },
    },

    "odoo.customer.update": {
      description:
        "Change a contact's details. payload: { id, name?, email?, phone?, mobile?, street?, street2?, city?, zip?, country_code? (e.g. GB), vat?, ref?, company_id? (the company contact a person works for) }. The approval shows the current details.",
      async prepare(payload) {
        const p = parse(CustomerUpdate, payload);
        return noted(payload, async () => {
          const r = await one(client, "res.partner", p.id, ["name", "email", "phone", "city", "parent_id"], "contact");
          return `[Now: ${String(r.name)}${r.email ? ` <${String(r.email)}>` : ""}${r.phone ? `, ${String(r.phone)}` : ""}${r.city ? `, ${String(r.city)}` : ""}${name(r.parent_id) ? ` at ${name(r.parent_id)}` : ""}.]`;
        });
      },
      async execute(payload) {
        const p = parse(CustomerUpdate, payload);
        const fields = await requireFields(client, "res.partner", "contacts");
        const mobileAsPhone = !fields.has("mobile") && p.mobile && !p.phone;
        const values = defined({
          name: p.name,
          email: p.email,
          phone: mobileAsPhone ? p.mobile : p.phone,
          mobile: mobileAsPhone ? undefined : p.mobile,
          street: p.street,
          street2: p.street2,
          city: p.city,
          zip: p.zip,
          country_id: await countryId(client, p.country_code),
          vat: p.vat,
          ref: p.ref,
          parent_id: p.company_id,
        });
        onlyKnown(fields, values, "contacts");
        const [before] = await client.read("res.partner", [p.id], Object.keys(values));
        if (!before) throw new OdooError(`No contact with id ${p.id}`);
        await client.write("res.partner", [p.id], values);
        const { id: _id, ...from } = before;
        return { id: p.id, from, to: values };
      },
    },

    "odoo.activity.schedule": {
      description:
        "Schedule an activity (a follow-up) on any record, shown in Odoo's chatter and the assignee's activities. payload: { model (e.g. sale.order, res.partner, crm.lead), id, summary, note?, due (YYYY-MM-DD), type?: todo (default) | call | email | meeting, user_id? (default the API user) }.",
      async execute(payload) {
        const p = parse(ActivitySchedule, payload);
        // As activity_schedule does (it returns a recordset, which the external API can't send back).
        const [model] = await client.searchRead("ir.model", [["model", "=", p.model]], ["model"], { limit: 1 });
        if (!model) throw new OdooError(`Odoo has no ${p.model} model`);
        await one(client, p.model, p.id, ["display_name"], p.model);
        const [module, xmlName] = ACTIVITY_TYPES[p.type].split(".") as [string, string];
        const [type] = await client.searchRead("ir.model.data", [["module", "=", module], ["name", "=", xmlName], ["model", "=", "mail.activity.type"]], ["res_id"], { limit: 1 });
        const activityId = await client.create(
          "mail.activity",
          defined({ res_model_id: model.id, res_id: p.id, activity_type_id: type?.res_id, summary: p.summary, note: p.note, date_deadline: p.due, user_id: p.user_id }),
        );
        return { activityId, model: p.model, id: p.id, summary: p.summary, due: p.due, type: p.type };
      },
    },

    "odoo.activity.done": {
      description: "Mark a scheduled activity done (Odoo's Mark Done), with optional feedback logged in the chatter. payload: { id (from search_activities), feedback? }.",
      async execute(payload) {
        const p = parse(ActivityDone, payload);
        const a = await one(client, "mail.activity", p.id, ["summary", "res_model", "res_id"], "activity");
        await client.call("mail.activity", "action_feedback", [[p.id]], defined({ feedback: p.feedback }));
        return { id: p.id, summary: a.summary || null, on: `${String(a.res_model)},${String(a.res_id)}`, done: true };
      },
    },

    "odoo.lead.create": {
      description:
        "Create a CRM lead or opportunity. payload: { name (title), type?: opportunity (default) | lead, partner_id?, contact_name?, company_name?, email?, phone?, expected_revenue?, description?, user_id? (salesperson) }. search_leads first to avoid duplicates.",
      async execute(payload) {
        const p = parse(LeadCreate, payload);
        const fields = await requireFields(client, "crm.lead", "is the CRM app installed?");
        const values = defined({
          name: p.name,
          type: p.type,
          partner_id: p.partner_id,
          contact_name: p.contact_name,
          partner_name: p.company_name,
          email_from: p.email,
          phone: p.phone,
          expected_revenue: p.expected_revenue,
          description: p.description,
          user_id: p.user_id,
        });
        const id = await client.create("crm.lead", onlyKnown(fields, values, "leads"));
        return { id, name: p.name, type: p.type };
      },
    },

    "odoo.lead.update": {
      description:
        "Move a lead or opportunity on: stage? (stage name, e.g. Proposition), expected_revenue?, probability?, user_id? (salesperson), outcome?: won | lost, lost_reason? (name of a lost reason). payload: { id, ... }.",
      async execute(payload) {
        const p = parse(LeadUpdate, payload);
        const fields = await requireFields(client, "crm.lead", "is the CRM app installed?");
        const lead = await one(client, "crm.lead", p.id, ["name", "stage_id"], "lead");
        const values = defined({
          stage_id: p.stage ? await byName(client, "crm.stage", p.stage) : undefined,
          expected_revenue: p.expected_revenue,
          probability: p.probability,
          user_id: p.user_id,
        });
        if (Object.keys(values).length) await client.write("crm.lead", [p.id], onlyKnown(fields, values, "leads"));
        if (p.outcome === "won") await client.call("crm.lead", "action_set_won", [[p.id]]);
        if (p.outcome === "lost") {
          const reason = p.lost_reason && (await client.fields("crm.lost.reason")) ? await byName(client, "crm.lost.reason", p.lost_reason) : undefined;
          await client.call("crm.lead", "action_set_lost", [[p.id]], defined({ lost_reason_id: reason }));
        }
        const after = await one(client, "crm.lead", p.id, ["stage_id", "active", "probability"], "lead");
        return { id: p.id, name: lead.name, stage: name(after.stage_id), outcome: p.outcome ?? null };
      },
    },

    "odoo.ticket.update": {
      description: "Change a helpdesk ticket: stage? (stage name, e.g. Solved), user_id? (assignee), priority? (\"0\" low to \"3\" urgent). payload: { id, ... }. Reply to the customer with odoo.message.post on the helpdesk.ticket.",
      async execute(payload) {
        const p = parse(TicketUpdate, payload);
        const fields = await requireFields(client, "helpdesk.ticket", "is the Helpdesk app installed?");
        const ticket = await one(client, "helpdesk.ticket", p.id, ["name", "team_id"], "ticket");
        const team = Array.isArray(ticket.team_id) ? (ticket.team_id[0] as number) : undefined;
        const stageFields = p.stage ? await client.fields("helpdesk.stage") : null;
        const values = defined({
          stage_id: p.stage ? await byName(client, "helpdesk.stage", p.stage, team && stageFields?.has("team_ids") ? [["team_ids", "in", [team]]] : []) : undefined,
          user_id: p.user_id,
          priority: p.priority,
        });
        await client.write("helpdesk.ticket", [p.id], onlyKnown(fields, values, "tickets"));
        const after = await one(client, "helpdesk.ticket", p.id, ["stage_id", "user_id", "priority"], "ticket");
        return { id: p.id, name: ticket.name, stage: name(after.stage_id), assigned: name(after.user_id), priority: after.priority ?? null };
      },
    },
  };
}
