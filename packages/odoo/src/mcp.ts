import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Domain, OdooError, type OdooReader, type OdooRecord, OdooRpcError, type SearchReadOptions } from "./client";

export interface OdooMcpOptions {
  /** Longest text (message bodies, descriptions) returned before truncating. Default 600. */
  textChars?: number;
}

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** HTML (chatter, blog content) to short plain text. */
export function htmlToText(html: unknown, max: number): string | null {
  if (typeof html !== "string" || !html) return null;
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Odoo values made agent-friendly: False → null, many2one [id, name] → { id, name }. */
function value(v: unknown): unknown {
  if (v === false || v === undefined) return null;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") return { id: v[0], name: v[1] };
  return v;
}

function compact(r: OdooRecord, map: Record<string, string | ((r: OdooRecord) => unknown)>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id };
  for (const [key, src] of Object.entries(map)) {
    const v = typeof src === "function" ? src(r) : value(r[src]);
    if (v !== undefined) out[key] = v ?? null;
  }
  return out;
}

const first = (...keys: string[]) => (r: OdooRecord) => {
  for (const k of keys) if (k in r) return value(r[k]);
  return undefined; // field absent in this Odoo: leave it out
};
const nameOf = (v: unknown) => (Array.isArray(v) ? v[1] : null);
const stripSku = (r: OdooRecord) => {
  const name = (r.display_name || r.name) as unknown;
  return typeof name === "string" ? name.replace(/^\[[^\]]*\]\s*/, "") : null;
};

/** Field-aware reads: asks only for fields the instance has, and knows when a model is missing. */
class Reader {
  constructor(private readonly client: OdooReader) {}

  has(model: string) {
    return this.client.fields(model);
  }

  async require(model: string, hint: string): Promise<Set<string>> {
    const fields = await this.client.fields(model);
    if (!fields) throw new OdooRpcError(`Odoo has no ${model} model (${hint})`, "missing_model", "KeyError");
    return fields;
  }

  /** search_read with unknown fields dropped; [] when the model isn't installed. */
  async find(model: string, domain: Domain, wanted: string[], options: SearchReadOptions = {}): Promise<OdooRecord[]> {
    const fields = await this.client.fields(model);
    if (!fields) return [];
    const order = options.order?.split(",").every((part) => fields.has(part.trim().split(/\s+/)[0]!)) ? options.order : undefined;
    return this.client.searchRead(model, domain, wanted.filter((f) => fields.has(f)), { ...options, order });
  }

  async read(model: string, ids: unknown, wanted: string[]): Promise<OdooRecord[]> {
    const fields = await this.client.fields(model);
    if (!fields || !Array.isArray(ids) || ids.length === 0) return [];
    return this.client.read(model, ids as number[], wanted.filter((f) => fields.has(f)));
  }

  count(model: string, domain: Domain) {
    return this.client.searchCount(model, domain);
  }
}

/** `['|', a, '|', b, c]` over whichever of `fields` exist. */
function anyOf(available: Set<string>, fields: string[], op: string, v: unknown): Domain {
  const leaves = fields.filter((f) => available.has(f)).map((f) => [f, op, v]);
  if (leaves.length === 0) return [];
  return [...Array(leaves.length - 1).fill("|"), ...leaves];
}

const PRODUCT_FIELDS = [
  "default_code", "display_name", "name", "lst_price", "list_price", "standard_price", "qty_available", "virtual_available",
  "weight", "categ_id", "is_published", "website_published", "barcode", "product_tmpl_id",
];
const product = (r: OdooRecord) =>
  compact(r, {
    sku: "default_code",
    name: stripSku,
    list_price: first("lst_price", "list_price"),
    standard_price: first("standard_price"),
    qty_available: first("qty_available"),
    virtual_available: first("virtual_available"),
    weight: first("weight"),
    category: (x) => nameOf(x.categ_id) ?? undefined,
    website_published: first("is_published", "website_published"),
    barcode: "barcode",
    template_id: (x) => (Array.isArray(x.product_tmpl_id) ? x.product_tmpl_id[0] : undefined),
  });

const ORDER_FIELDS = [
  "name", "partner_id", "date_order", "state", "amount_total", "currency_id", "invoice_status", "delivery_status",
  "client_order_ref", "commitment_date", "website_id",
];
const order = (r: OdooRecord) =>
  compact(r, {
    name: "name",
    customer: "partner_id",
    date: "date_order",
    state: "state",
    total: "amount_total",
    currency: (x) => nameOf(x.currency_id) ?? undefined,
    invoice_status: first("invoice_status"),
    delivery_status: first("delivery_status"),
    customer_ref: first("client_order_ref"),
    promised_date: first("commitment_date"),
    website: (x) => nameOf(x.website_id) ?? undefined,
  });

const INVOICE_FIELDS = ["name", "state", "payment_state", "move_type", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "invoice_origin"];
const invoice = (r: OdooRecord) =>
  compact(r, {
    name: "name",
    type: "move_type",
    state: "state",
    payment_state: first("payment_state"),
    date: "invoice_date",
    due: first("invoice_date_due"),
    total: "amount_total",
    outstanding: first("amount_residual"),
    origin: first("invoice_origin"),
  });

const MESSAGE_FIELDS = ["date", "author_id", "email_from", "message_type", "subtype_id", "subject", "body", "model", "res_id"];
const NOT_NOTIFICATIONS: Domain = [["message_type", "not in", ["notification", "user_notification"]]];

const PARTNER_FIELDS = ["name", "email", "phone", "mobile", "city", "country_id", "is_company", "parent_id", "ref", "customer_rank"];
const partner = (r: OdooRecord) =>
  compact(r, {
    name: "name",
    email: "email",
    phone: first("phone"),
    mobile: first("mobile"),
    city: first("city"),
    country: (x) => nameOf(x.country_id) ?? undefined,
    company: (x) => (x.is_company ? true : (nameOf(x.parent_id) ?? undefined)),
    ref: first("ref"),
  });

/**
 * READ-ONLY MCP server over Odoo: products, stock, orders, customers, chatter,
 * websites, blogs and discount/loyalty programs. Results are compact JSON; fields or apps missing from the
 * instance are left out rather than failing. Writes are action executors only.
 */
export function createOdooMcpServer(client: OdooReader, options: OdooMcpOptions = {}): McpServer {
  const server = new McpServer({ name: "odoo", version: "0.1.0" });
  const odoo = new Reader(client);
  const max = options.textChars ?? 600;

  const message = (r: OdooRecord) =>
    compact(r, {
      date: "date",
      author: (x) => nameOf(x.author_id) ?? value(x.email_from),
      type: "message_type",
      subtype: (x) => nameOf(x.subtype_id),
      subject: first("subject"),
      body: (x) => htmlToText(x.body, max),
      on: (x) => (x.model ? `${x.model},${x.res_id}` : undefined),
    });

  /** Every tool returns Odoo errors as a short tool error, never a crash or a traceback. */
  const tool = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof OdooError) return fail(`${err.name}: ${err.message}`);
      throw err;
    }
  };
  const limit = (fallback: number, cap = 100) => z.number().int().min(1).max(cap).default(fallback);

  server.registerTool(
    "search_products",
    {
      description:
        "Search products (variants) by name, SKU or barcode. Returns sku, name, list_price, standard_price (cost), qty_available, virtual_available (forecast), weight, category, website_published, barcode.",
      inputSchema: { query: z.string().describe("Name, SKU or barcode fragment"), limit: limit(10, 50) },
    },
    tool(async ({ query, limit }) => {
      const fields = await odoo.require("product.product", "is the Sales or Inventory app installed?");
      const domain = anyOf(fields, ["name", "default_code", "barcode"], "ilike", query);
      return (await odoo.find("product.product", domain, PRODUCT_FIELDS, { limit, order: "default_code" })).map(product);
    }),
  );

  server.registerTool(
    "get_product",
    {
      description: "Get one product by id (from search_products) or exact SKU, with taxes, stock moves in/out, sale description and website URL.",
      inputSchema: { id: z.number().int().optional(), sku: z.string().optional() },
    },
    tool(async ({ id, sku }) => {
      if (!id && !sku) throw new OdooError("Pass id or sku");
      const domain: Domain = id ? [["id", "=", id]] : [["default_code", "=ilike", sku]];
      const extra = ["description_sale", "uom_id", "type", "is_storable", "sale_ok", "active", "taxes_id", "volume", "incoming_qty", "outgoing_qty", "website_url"];
      const [r] = await odoo.find("product.product", domain, [...PRODUCT_FIELDS, ...extra], { limit: 1 });
      if (!r) throw new OdooError(`No product with ${id ? `id ${id}` : `SKU ${sku}`}`);
      const taxes = await odoo.read("account.tax", r.taxes_id, ["name", "amount", "amount_type", "price_include", "price_include_override"]);
      return {
        ...product(r),
        ...compact(r, {
          description: (x) => htmlToText(x.description_sale, max),
          uom: (x) => nameOf(x.uom_id) ?? undefined,
          type: first("type"),
          storable: first("is_storable"),
          sale_ok: first("sale_ok"),
          active: first("active"),
          volume: first("volume"),
          incoming_qty: first("incoming_qty"),
          outgoing_qty: first("outgoing_qty"),
          website_url: first("website_url"),
        }),
        taxes: taxes.map((t) => compact(t, { name: "name", amount: "amount", type: "amount_type", price_include: first("price_include_override", "price_include") })),
      };
    }),
  );

  server.registerTool(
    "search_orders",
    {
      description:
        "Search sales orders by order number / customer reference / customer name (query), customer (partner id or name), state (draft, sent, sale, cancel) and order date range. Newest first.",
      inputSchema: {
        query: z.string().optional(),
        partner: z.union([z.number().int(), z.string()]).optional().describe("Partner id (includes their contacts) or name"),
        state: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        limit: limit(10, 50),
      },
    },
    tool(async ({ query, partner: who, state, date_from, date_to, limit }) => {
      const fields = await odoo.require("sale.order", "is the Sales app installed?");
      const domain: Domain = [];
      if (query) domain.push(...anyOf(fields, ["name", "client_order_ref", "partner_id"], "ilike", query));
      if (typeof who === "number") domain.push(["partner_id", "child_of", who]);
      else if (who) domain.push(["partner_id", "ilike", who]);
      if (state) domain.push(["state", "=", state]);
      if (date_from) domain.push(["date_order", ">=", `${date_from} 00:00:00`]);
      if (date_to) domain.push(["date_order", "<=", `${date_to} 23:59:59`]);
      return (await odoo.find("sale.order", domain, ORDER_FIELDS, { limit, order: "date_order desc" })).map(order);
    }),
  );

  server.registerTool(
    "get_order",
    {
      description:
        "Get one sales order by name (e.g. S00042) or id: lines, deliveries (state, dates, carrier, tracking ref), invoices (payment state) and recent chatter.",
      inputSchema: { name: z.string().optional(), id: z.number().int().optional() },
    },
    tool(async ({ name, id }) => {
      if (!name && !id) throw new OdooError("Pass name or id");
      await odoo.require("sale.order", "is the Sales app installed?");
      const domain: Domain = id ? [["id", "=", id]] : [["name", "=ilike", name]];
      const [r] = await odoo.find("sale.order", domain, [...ORDER_FIELDS, "order_line", "picking_ids", "invoice_ids", "note"], { limit: 1 });
      if (!r) throw new OdooError(`No sales order ${name ?? id}`);

      const [lines, pickings, invoices, messages] = await Promise.all([
        odoo.read("sale.order.line", r.order_line, ["product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "display_type"]),
        odoo.read("stock.picking", r.picking_ids, ["name", "state", "picking_type_code", "scheduled_date", "date_done", "carrier_id", "carrier_tracking_ref", "carrier_tracking_url"]),
        odoo.read("account.move", r.invoice_ids, INVOICE_FIELDS),
        odoo.find("mail.message", [["model", "=", "sale.order"], ["res_id", "=", r.id], ...NOT_NOTIFICATIONS], MESSAGE_FIELDS, { limit: 5, order: "date desc" }),
      ]);
      return {
        ...order(r),
        note: htmlToText(r.note, max),
        lines: lines.map((l) =>
          l.display_type
            ? { section: htmlToText(l.name, 120) }
            : compact(l, {
                product: (x) => nameOf(x.product_id),
                description: (x) => htmlToText(x.name, 120),
                qty: "product_uom_qty",
                delivered: first("qty_delivered"),
                invoiced: first("qty_invoiced"),
                unit_price: "price_unit",
                discount: first("discount"),
                subtotal: "price_subtotal",
              }),
        ),
        deliveries: pickings.map((p) =>
          compact(p, {
            name: "name",
            type: first("picking_type_code"),
            state: "state",
            scheduled: first("scheduled_date"),
            done: first("date_done"),
            carrier: (x) => nameOf(x.carrier_id) ?? undefined,
            tracking_ref: first("carrier_tracking_ref"),
            tracking_url: first("carrier_tracking_url"),
          }),
        ),
        invoices: invoices.map(invoice),
        messages: messages.map(message),
      };
    }),
  );

  server.registerTool(
    "search_customers",
    {
      description: "Search customers and contacts by name, email, phone or reference.",
      inputSchema: { query: z.string(), limit: limit(10, 50) },
    },
    tool(async ({ query, limit }) => {
      const fields = await odoo.require("res.partner", "contacts");
      const domain = anyOf(fields, ["name", "email", "phone", "mobile", "ref"], "ilike", query);
      return (await odoo.find("res.partner", domain, PARTNER_FIELDS, { limit, order: "customer_rank desc" })).map(partner);
    }),
  );

  server.registerTool(
    "get_customer_history",
    {
      description: "A customer's recent orders, invoices and chatter (on the contact and their orders), with their order count.",
      inputSchema: { partner_id: z.number().int(), limit: limit(10, 50) },
    },
    tool(async ({ partner_id, limit }) => {
      const [p] = await odoo.read("res.partner", [partner_id], PARTNER_FIELDS);
      if (!p) throw new OdooError(`No contact with id ${partner_id}`);
      const mine: Domain = [["partner_id", "child_of", partner_id]];
      const hasOrders = !!(await odoo.has("sale.order"));
      const [orders, orderCount, invoices] = await Promise.all([
        odoo.find("sale.order", mine, ORDER_FIELDS, { limit, order: "date_order desc" }),
        hasOrders ? odoo.count("sale.order", mine) : Promise.resolve(null),
        odoo.find("account.move", [...mine, ["move_type", "in", ["out_invoice", "out_refund"]]], INVOICE_FIELDS, { limit, order: "invoice_date desc" }),
      ]);
      const onRecords: Domain = orders.length
        ? ["|", "&", ["model", "=", "res.partner"], ["res_id", "=", partner_id], "&", ["model", "=", "sale.order"], ["res_id", "in", orders.map((o) => o.id)]]
        : [["model", "=", "res.partner"], ["res_id", "=", partner_id]];
      const messages = await odoo.find("mail.message", [...onRecords, ...NOT_NOTIFICATIONS], MESSAGE_FIELDS, { limit, order: "date desc" });
      return { customer: partner(p), order_count: orderCount, orders: orders.map(order), invoices: invoices.map(invoice), messages: messages.map(message) };
    }),
  );

  server.registerTool(
    "get_record_messages",
    {
      description: "Chatter (mail.message) on any record, newest first: emails, messages and internal notes. System tracking notifications are left out unless asked for.",
      inputSchema: {
        model: z.string().describe("e.g. sale.order, res.partner, helpdesk.ticket"),
        id: z.number().int(),
        limit: limit(10, 50),
        include_notifications: z.boolean().default(false),
      },
    },
    tool(async ({ model, id, limit, include_notifications }) => {
      await odoo.require("mail.message", "messaging");
      const domain: Domain = [["model", "=", model], ["res_id", "=", id], ...(include_notifications ? [] : NOT_NOTIFICATIONS)];
      return (await odoo.find("mail.message", domain, MESSAGE_FIELDS, { limit, order: "date desc" })).map(message);
    }),
  );

  server.registerTool(
    "list_websites",
    {
      description: "Websites on this Odoo (e.g. Desktop Machine Shop and 3dpandme) with their blogs. Use the ids with search_blog_posts and odoo.blog.draft.",
      inputSchema: {},
    },
    tool(async () => {
      const sites = await odoo.find("website", [], ["name", "domain", "company_id"], { order: "id" });
      const blogs = await odoo.find("blog.blog", [], ["name", "website_id"], { order: "id" });
      return sites.map((s) => ({
        ...compact(s, { name: "name", domain: first("domain") }),
        blogs: blogs.filter((b) => Array.isArray(b.website_id) && b.website_id[0] === s.id).map((b) => ({ id: b.id, name: b.name })),
      }));
    }),
  );

  server.registerTool(
    "search_blog_posts",
    {
      description: "Search blog posts, optionally on one website (id or name, see list_websites). Newest first; includes unpublished drafts unless published is set.",
      inputSchema: {
        website: z.union([z.number().int(), z.string()]).optional(),
        query: z.string().optional().describe("Matches title or subtitle"),
        published: z.boolean().optional(),
        limit: limit(10, 50),
      },
    },
    tool(async ({ website, query, published, limit }) => {
      const fields = await odoo.require("blog.post", "is the Blog app installed?");
      const domain: Domain = [];
      if (website !== undefined) {
        const siteIds =
          typeof website === "number"
            ? [website]
            : (await odoo.find("website", anyOf((await odoo.has("website")) ?? new Set(), ["name", "domain"], "ilike", website), ["name"])).map((s) => s.id);
        if (fields.has("website_id")) domain.push(["website_id", "in", siteIds]);
        else {
          const blogs = await odoo.find("blog.blog", [["website_id", "in", siteIds]], ["name"]);
          domain.push(["blog_id", "in", blogs.map((b) => b.id)]);
        }
      }
      if (query) domain.push(...anyOf(fields, ["name", "subtitle"], "ilike", query));
      if (published !== undefined) domain.push(["is_published", "=", published]);
      const posts = await odoo.find(
        "blog.post",
        domain,
        ["name", "subtitle", "blog_id", "website_id", "is_published", "post_date", "published_date", "website_url", "author_id"],
        { limit, order: "post_date desc" },
      );
      return posts.map((p) =>
        compact(p, {
          title: "name",
          subtitle: first("subtitle"),
          blog: "blog_id",
          website: (x) => nameOf(x.website_id) ?? undefined,
          published: first("is_published"),
          date: first("post_date", "published_date"),
          url: first("website_url"),
          author: (x) => nameOf(x.author_id) ?? undefined,
        }),
      );
    }),
  );

  server.registerTool(
    "search_loyalty_programs",
    {
      description:
        "Discount and loyalty programs (promotions, promo codes, buy X get Y, loyalty cards, coupons, gift cards) with their rules (who qualifies, codes) and rewards. Active only unless include_archived. Use the ids with odoo.loyalty.archive.",
      inputSchema: {
        query: z.string().optional().describe("Matches the program name"),
        program_type: z.string().optional().describe("e.g. promotion, promo_code, buy_x_get_y, loyalty, coupons, gift_card"),
        include_archived: z.boolean().default(false),
        limit: limit(20, 100),
      },
    },
    tool(async ({ query, program_type, include_archived, limit }) => {
      await odoo.require("loyalty.program", "is Sales > Discount & Loyalty enabled?");
      const domain: Domain = [["active", "in", include_archived ? [true, false] : [true]]];
      if (query) domain.push(["name", "ilike", query]);
      if (program_type) domain.push(["program_type", "=", program_type]);
      const programs = await odoo.find(
        "loyalty.program",
        domain,
        ["name", "program_type", "trigger", "applies_on", "active", "date_from", "date_to", "website_id", "limit_usage", "max_usage", "rule_ids", "reward_ids"],
        { limit, order: "id desc" },
      );
      const ids = (key: string) => programs.flatMap((p) => (Array.isArray(p[key]) ? (p[key] as number[]) : []));
      const [rules, rewards] = await Promise.all([
        odoo.read("loyalty.rule", ids("rule_ids"), ["code", "mode", "minimum_amount", "minimum_qty", "product_ids", "product_category_id", "reward_point_amount", "reward_point_mode"]),
        odoo.read("loyalty.reward", ids("reward_ids"), ["reward_type", "description", "discount", "discount_mode", "discount_applicability", "discount_max_amount", "reward_product_id", "reward_product_qty", "required_points"]),
      ]);
      const pick = <T extends OdooRecord>(rows: T[], wanted: unknown) => rows.filter((r) => Array.isArray(wanted) && wanted.includes(r.id));
      return programs.map((p) => ({
        ...compact(p, {
          name: "name",
          type: "program_type",
          trigger: first("trigger"),
          applies_on: first("applies_on"),
          active: (x) => x.active === true,
          date_from: first("date_from"),
          date_to: first("date_to"),
          website: (x) => nameOf(x.website_id) ?? undefined,
          max_usage: (x) => (x.limit_usage ? value(x.max_usage) : undefined),
        }),
        rules: pick(rules, p.rule_ids).map((r) =>
          compact(r, {
            code: first("code"),
            mode: first("mode"),
            minimum_amount: first("minimum_amount"),
            minimum_qty: first("minimum_qty"),
            product_ids: first("product_ids"),
            category: (x) => nameOf(x.product_category_id) ?? undefined,
            points: first("reward_point_amount"),
            points_mode: first("reward_point_mode"),
          }),
        ),
        rewards: pick(rewards, p.reward_ids).map((r) =>
          compact(r, {
            type: "reward_type",
            description: first("description"),
            discount: first("discount"),
            discount_mode: first("discount_mode"),
            applies_to: first("discount_applicability"),
            discount_max_amount: first("discount_max_amount"),
            product: (x) => nameOf(x.reward_product_id) ?? undefined,
            product_qty: first("reward_product_qty"),
            required_points: first("required_points"),
          }),
        ),
      }));
    }),
  );

  server.registerTool(
    "low_stock",
    {
      description: "Stocked, sellable products with on-hand quantity at or below a threshold, lowest first, with forecast and incoming quantities.",
      inputSchema: { threshold: z.number().default(5), limit: limit(50) },
    },
    tool(async ({ threshold, limit }) => {
      const fields = await odoo.require("product.product", "is the Inventory app installed?");
      if (!fields.has("qty_available")) throw new OdooError("This Odoo has no stock quantities (Inventory app not installed)");
      const storable: Domain = fields.has("is_storable") ? [["is_storable", "=", true]] : [["type", "=", "product"]];
      const domain: Domain = [...storable, ["qty_available", "<=", threshold], ...(fields.has("sale_ok") ? [["sale_ok", "=", true]] : [])];
      const rows = await odoo.find("product.product", domain, ["default_code", "display_name", "name", "qty_available", "virtual_available", "incoming_qty"], { limit: 500 });
      return rows
        .sort((a, b) => (a.qty_available as number) - (b.qty_available as number))
        .slice(0, limit)
        .map((r) =>
          compact(r, {
            sku: "default_code",
            name: stripSku,
            qty_available: "qty_available",
            virtual_available: first("virtual_available"),
            incoming_qty: first("incoming_qty"),
          }),
        );
    }),
  );

  return server;
}
