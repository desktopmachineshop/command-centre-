import { z } from "zod";
import { type OdooClient, OdooError, OdooRpcError } from "./client";

/**
 * Structurally the server's `ActionExecutor`, so `createOdooExecutors(client)`
 * spreads straight into the server's executor registry. Odoo executors don't
 * need the server's context.
 */
export interface OdooActionExecutor {
  description: string;
  execute(payload: Record<string, unknown>, ctx?: unknown): Promise<unknown>;
}

export type OdooWriter = Pick<OdooClient, "call" | "create" | "write" | "read" | "searchRead" | "fields">;

const MessagePost = z.object({
  model: z.string().regex(/^[a-z0-9_.]+$/, "an Odoo model name, e.g. sale.order"),
  id: z.number().int().positive(),
  body: z.string().min(1),
  internal: z.boolean().default(false),
});

const BlogDraft = z
  .object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    content: z.string().min(1).describe("HTML"),
    blog_id: z.number().int().positive().optional(),
    website_id: z.number().int().positive().optional(),
  })
  .refine((p) => p.blog_id || p.website_id, "blog_id or website_id is required");

const UpdatePrice = z.object({
  id: z.number().int().positive(),
  list_price: z.number().nonnegative(),
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const Id = z.number().int().positive();

const QuoteLine = z.object({
  product_id: Id,
  qty: z.number().positive(),
  /** Net unit price; Odoo's pricelist price when left out. */
  price_unit: z.number().nonnegative().optional(),
  discount: z.number().min(0).max(100).optional().describe("percent"),
  description: z.string().min(1).optional(),
});

const QuoteCreate = z.object({
  partner_id: Id,
  lines: z.array(QuoteLine).min(1),
  validity_date: Day.optional(),
  client_order_ref: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  website_id: Id.optional(),
  send: z.boolean().default(false),
});

const QuoteSend = z.object({ id: Id });

const LoyaltyRule = z
  .object({
    minimum_amount: z.number().nonnegative().optional(),
    minimum_qty: z.number().int().nonnegative().optional(),
    product_ids: z.array(Id).optional(),
    product_category_id: Id.optional(),
    points: z.number().positive().optional(),
    points_mode: z.enum(["order", "money", "unit"]).optional(),
  })
  .default({});

const LoyaltyReward = z
  .object({
    type: z.enum(["discount", "product", "shipping"]),
    discount: z.number().positive().optional(),
    discount_mode: z.enum(["percent", "per_order", "per_point"]).default("percent"),
    applies_to: z.enum(["order", "cheapest", "specific"]).default("order"),
    discount_product_ids: z.array(Id).optional(),
    discount_max_amount: z.number().positive().optional(),
    product_id: Id.optional(),
    product_qty: z.number().int().positive().optional(),
    required_points: z.number().positive().optional(),
    description: z.string().min(1).optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (r.type === "discount") {
      if (!r.discount) issue("discount", "is required for a discount reward");
      else if (r.discount_mode === "percent" && r.discount > 100) issue("discount", "can't be over 100 percent");
      if (r.applies_to === "specific" && !r.discount_product_ids?.length) issue("discount_product_ids", "is required when applies_to is specific");
    }
    if (r.type === "product" && !r.product_id) issue("product_id", "is required for a free-product reward");
  });

const LoyaltyCreate = z
  .object({
    name: z.string().min(1),
    program_type: z.enum(["promotion", "promo_code", "buy_x_get_y", "loyalty"]),
    code: z.string().min(1).regex(/^\S+$/, "has no spaces").optional(),
    date_from: Day.optional(),
    date_to: Day.optional(),
    website_id: Id.optional(),
    max_usage: z.number().int().positive().optional(),
    rule: LoyaltyRule,
    reward: LoyaltyReward,
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (p.program_type === "promo_code" && !p.code) issue("code", "is required for a promo_code program");
    if (p.program_type !== "promo_code" && p.code) issue("code", "is only for promo_code programs");
    if (p.program_type === "buy_x_get_y" && p.reward.type !== "product") issue("reward.type", "must be product for buy_x_get_y");
    if (p.date_from && p.date_to && p.date_to < p.date_from) issue("date_to", "is before date_from");
  });

const LoyaltyArchive = z.object({ id: Id });

/** `[[6, 0, ids]]`: set a many2many to exactly these ids. */
const setMany = (ids: number[] | undefined) => (ids?.length ? [[6, 0, ids]] : undefined);
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Emails a quotation the way Odoo's Send button does: the composer opened by
 * action_quotation_send, with its context (template, mark_so_as_sent), then sent.
 * The composer renders the template on create (Odoo 17+, which Odoo Online runs).
 */
async function sendQuote(client: OdooWriter, id: number) {
  const [order] = await client.read("sale.order", [id], ["name", "state", "partner_id"]);
  if (!order) throw new OdooError(`No sales order with id ${id}`);
  if (order.state !== "draft" && order.state !== "sent") throw new OdooError(`${order.name} is ${order.state}, not a quotation`);
  const action = (await client.call("sale.order", "action_quotation_send", [[id]])) as { res_model?: string; context?: Record<string, unknown> } | null;
  const context = action?.context;
  if (!context || (action.res_model && action.res_model !== "mail.compose.message")) throw new OdooError("Odoo did not open the quotation email composer");
  const composer = await client.create("mail.compose.message", {}, context);
  await client.call("mail.compose.message", "action_send_mail", [[composer]], { context });
  const [after] = await client.read("sale.order", [id], ["name", "state"]);
  return { id, name: order.name, to: Array.isArray(order.partner_id) ? order.partner_id[1] : null, state: after?.state ?? null };
}

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new OdooError(`Invalid payload: ${r.error.issues.map((i) => `${i.path.join(".") || "payload"} ${i.message}`).join("; ")}`);
  return r.data;
}

/** Write actions on Odoo. All of them default to `draft` policy: Dave approves each one. */
export function createOdooExecutors(client: OdooWriter): Record<string, OdooActionExecutor> {
  return {
    "odoo.message.post": {
      description:
        "Post on an Odoo record's chatter. payload: { model, id, body, internal? }. internal=true logs a note only staff see; otherwise it is a message emailed to the record's followers, i.e. the customer.",
      async execute(payload) {
        const p = parse(MessagePost, payload);
        const kwargs = { body: p.body, message_type: "comment", subtype_xmlid: p.internal ? "mail.mt_note" : "mail.mt_comment" };
        // Odoo 17+ escapes HTML sent over RPC unless body_is_html is set; older versions reject that argument.
        const html = /<[a-z][^>]*>/i.test(p.body);
        const messageId = await client
          .call(p.model, "message_post", [[p.id]], html ? { ...kwargs, body_is_html: true } : kwargs)
          .catch((err) => {
            if (html && err instanceof OdooRpcError && err.kind !== "access") return client.call(p.model, "message_post", [[p.id]], kwargs);
            throw err;
          });
        return { messageId, model: p.model, id: p.id, internal: p.internal };
      },
    },

    "odoo.blog.draft": {
      description:
        "Create an UNPUBLISHED blog post for Dave to review in Odoo. payload: { title, subtitle?, content (HTML), blog_id? | website_id? } (ids from the odoo list_websites tool; with only website_id, that site's first blog is used).",
      async execute(payload) {
        const p = parse(BlogDraft, payload);
        let blogId = p.blog_id;
        if (!blogId) {
          const [blog] = await client.searchRead("blog.blog", [["website_id", "=", p.website_id]], ["id"], { limit: 1, order: "id" });
          if (!blog) throw new OdooError(`Website ${p.website_id} has no blog`);
          blogId = blog.id;
        }
        const values: Record<string, unknown> = { name: p.title, content: p.content, blog_id: blogId, is_published: false };
        if (p.subtitle) values.subtitle = p.subtitle;
        const id = await client.create("blog.post", values);
        return { id, blog_id: blogId, published: false };
      },
    },

    "odoo.product.update_price": {
      description:
        "Change a product's sale price. payload: { id, list_price } where id is the product id from search_products/get_product. The price is the template's, shared by all its variants.",
      async execute(payload) {
        const p = parse(UpdatePrice, payload);
        const [before] = await client.read("product.product", [p.id], ["list_price", "display_name"]);
        if (!before) throw new OdooError(`No product with id ${p.id}`);
        await client.write("product.product", [p.id], { list_price: p.list_price });
        return { id: p.id, name: before.display_name, from: before.list_price, to: p.list_price };
      },
    },

    "odoo.quote.create": {
      description:
        "Create a quotation (a draft sales order) for a customer, and optionally email it. payload: { partner_id, lines: [{ product_id, qty, price_unit?, discount? (percent), description? }], validity_date? (YYYY-MM-DD), client_order_ref?, note?, website_id?, send? }. Ids from search_customers and search_products; price_unit is net and defaults to Odoo's price. send=true emails it to the customer with Odoo's quotation template (PDF and portal link) right after creating it.",
      async execute(payload) {
        const p = parse(QuoteCreate, payload);
        const [customer] = await client.read("res.partner", [p.partner_id], ["name", "email"]);
        if (!customer) throw new OdooError(`No contact with id ${p.partner_id}`);
        if (p.send && !customer.email) throw new OdooError(`${customer.name} has no email address, so the quote can't be sent`);
        const lines = p.lines.map((l) => [
          0,
          0,
          defined({ product_id: l.product_id, product_uom_qty: l.qty, price_unit: l.price_unit, discount: l.discount, name: l.description }),
        ]);
        const values = defined({
          partner_id: p.partner_id,
          order_line: lines,
          validity_date: p.validity_date,
          client_order_ref: p.client_order_ref,
          note: p.note,
          website_id: p.website_id,
        });
        const id = await client.create("sale.order", values);
        const [quote] = await client.read("sale.order", [id], ["name", "state", "amount_untaxed", "amount_total"]);
        const created = { id, name: quote?.name ?? null, customer: customer.name, untaxed: quote?.amount_untaxed ?? null, total: quote?.amount_total ?? null };
        if (!p.send) return { ...created, state: quote?.state ?? "draft", sent: false };
        const sent = await sendQuote(client, id);
        return { ...created, state: sent.state, sent: true };
      },
    },

    "odoo.quote.send": {
      description:
        "Email an existing quotation to its customer with Odoo's quotation template (PDF and portal link), marking it sent. payload: { id } (the sales order id, from search_orders/get_order). Only a quotation in draft or sent state.",
      async execute(payload) {
        const p = parse(QuoteSend, payload);
        return { ...(await sendQuote(client, p.id)), sent: true };
      },
    },

    "odoo.loyalty.create": {
      description:
        "Create a live discount or loyalty program in Odoo (Sales > Discount & Loyalty). payload: { name, program_type: promotion (automatic) | promo_code (needs code) | buy_x_get_y | loyalty (points card), code?, date_from?, date_to? (YYYY-MM-DD), website_id?, max_usage?, rule: { minimum_amount?, minimum_qty?, product_ids?, product_category_id?, points?, points_mode?: order|money|unit }, reward: { type: discount|product|shipping, discount?, discount_mode?: percent|per_order|per_point, applies_to?: order|cheapest|specific, discount_product_ids?, discount_max_amount?, product_id?, product_qty?, required_points?, description? } }. Amounts are in the company currency; the rule decides who qualifies, the reward what they get.",
      async execute(payload) {
        const p = parse(LoyaltyCreate, payload);
        const fields = await client.fields("loyalty.program");
        if (!fields) throw new OdooRpcError("Odoo has no loyalty.program model (is Sales > Discount & Loyalty enabled?)", "missing_model", "KeyError");
        const { rule: r, reward: w } = p;
        const rule = defined({
          mode: p.code ? "with_code" : "auto",
          code: p.code,
          minimum_amount: r.minimum_amount,
          minimum_qty: r.minimum_qty,
          product_ids: setMany(r.product_ids),
          product_category_id: r.product_category_id,
          reward_point_amount: r.points,
          reward_point_mode: r.points_mode,
        });
        const reward = defined({
          reward_type: w.type,
          ...(w.type === "discount"
            ? {
                discount: w.discount,
                discount_mode: w.discount_mode,
                discount_applicability: w.applies_to,
                discount_product_ids: w.applies_to === "specific" ? setMany(w.discount_product_ids) : undefined,
                discount_max_amount: w.discount_max_amount,
              }
            : {}),
          reward_product_id: w.type === "product" ? w.product_id : undefined,
          reward_product_qty: w.type === "product" ? w.product_qty : undefined,
          required_points: w.required_points,
          description: w.description,
        });
        const values = defined({
          name: p.name,
          program_type: p.program_type,
          trigger: p.code ? "with_code" : "auto",
          applies_on: p.program_type === "loyalty" ? "both" : "current",
          date_from: p.date_from,
          date_to: p.date_to,
          website_id: p.website_id,
          limit_usage: p.max_usage ? true : undefined,
          max_usage: p.max_usage,
          active: true,
          rule_ids: [[0, 0, rule]],
          reward_ids: [[0, 0, reward]],
        });
        // A date this Odoo can't store would make the deal run longer than proposed: refuse instead.
        for (const key of ["date_from", "date_to", "website_id", "max_usage"] as const) {
          if (key in values && !fields.has(key)) throw new OdooError(`This Odoo's loyalty programs have no ${key}`);
        }
        const id = await client.create("loyalty.program", values);
        return { id, name: p.name, program_type: p.program_type, code: p.code ?? null, date_from: p.date_from ?? null, date_to: p.date_to ?? null, active: true };
      },
    },

    "odoo.loyalty.archive": {
      description:
        "Archive (switch off) a discount or loyalty program so it no longer applies; it can be restored in Odoo. payload: { id } (from search_loyalty_programs).",
      async execute(payload) {
        const p = parse(LoyaltyArchive, payload);
        const [before] = await client.read("loyalty.program", [p.id], ["name", "active"]);
        if (!before) throw new OdooError(`No discount or loyalty program with id ${p.id}`);
        if (before.active !== false) await client.write("loyalty.program", [p.id], { active: false });
        return { id: p.id, name: before.name, archived: true, was_active: before.active !== false };
      },
    },
  };
}
