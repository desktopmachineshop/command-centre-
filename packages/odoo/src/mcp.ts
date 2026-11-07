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
 * READ-ONLY MCP server over Odoo: products, stock, orders, customers, chatter, websites, blogs,
 * discount/loyalty programs, and the day-to-day reads (registerDailyTools): invoices, what's owed,
 * payments, deliveries, purchases, sales figures, leads, tickets, activities and any other model. Results are compact JSON; fields or apps missing from the
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

  registerDailyTools(server, odoo, { tool, limit, message, max });

  return server;
}

const today = () => new Date().toISOString().slice(0, 10);
const Who = z.union([z.number().int(), z.string()]).optional().describe("Partner id (includes their contacts) or name");
const partnerLeaf = (who: number | string | undefined, field = "partner_id"): Domain =>
  typeof who === "number" ? [[field, "child_of", who]] : who ? [[field, "ilike", who]] : [];
const dateRange = (field: string, from?: string, to?: string, datetime = true): Domain => [
  ...(from ? [[field, ">=", datetime ? `${from} 00:00:00` : from]] : []),
  ...(to ? [[field, "<=", datetime ? `${to} 23:59:59` : to]] : []),
];
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" ? v : 0);

const MOVE_TYPES = {
  customer_invoice: ["out_invoice"],
  customer_credit_note: ["out_refund"],
  vendor_bill: ["in_invoice"],
  vendor_refund: ["in_refund"],
  customer: ["out_invoice", "out_refund"],
  vendor: ["in_invoice", "in_refund"],
} as const;

const PICKING_FIELDS = [
  "name", "state", "picking_type_code", "partner_id", "origin", "scheduled_date", "date_deadline", "date_done", "carrier_id",
  "carrier_tracking_ref", "carrier_tracking_url", "sale_id", "purchase_id",
];
const picking = (r: OdooRecord) =>
  compact(r, {
    name: "name",
    type: first("picking_type_code"),
    state: "state",
    partner: first("partner_id"),
    origin: first("origin"),
    scheduled: first("scheduled_date"),
    deadline: first("date_deadline"),
    done: first("date_done"),
    carrier: (x) => nameOf(x.carrier_id) ?? undefined,
    tracking_ref: first("carrier_tracking_ref"),
    tracking_url: first("carrier_tracking_url"),
    sale_order: (x) => nameOf(x.sale_id) ?? undefined,
    purchase_order: (x) => nameOf(x.purchase_id) ?? undefined,
  });

const PURCHASE_FIELDS = ["name", "state", "partner_id", "partner_ref", "date_order", "date_planned", "date_approve", "amount_untaxed", "amount_total", "currency_id", "receipt_status", "invoice_status", "origin"];
const purchase = (r: OdooRecord) =>
  compact(r, {
    name: "name",
    vendor: "partner_id",
    vendor_ref: first("partner_ref"),
    state: "state",
    date: first("date_order"),
    expected: first("date_planned"),
    confirmed: first("date_approve"),
    untaxed: first("amount_untaxed"),
    total: "amount_total",
    currency: (x) => nameOf(x.currency_id) ?? undefined,
    receipt_status: first("receipt_status"),
    billing_status: first("invoice_status"),
    origin: first("origin"),
  });

interface DailyHelpers {
  tool: <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
  limit: (fallback: number, cap?: number) => z.ZodDefault<z.ZodNumber>;
  message: (r: OdooRecord) => Record<string, unknown>;
  max: number;
}

/**
 * The day-to-day reads: invoices and bills, what's owed, payments, deliveries and receipts,
 * stock by location, purchase orders, sales figures, CRM leads, helpdesk tickets, activities,
 * and a generic read of any model for everything else. All read-only.
 */
function registerDailyTools(server: McpServer, odoo: Reader, { tool, limit, message, max }: DailyHelpers) {
  const invoiceRow = (r: OdooRecord) => ({
    ...invoice(r),
    ...compact(r, { partner: first("partner_id"), currency: (x) => nameOf(x.currency_id) ?? undefined, reference: first("ref") }),
  });
  const INVOICE_LIST_FIELDS = [...INVOICE_FIELDS, "partner_id", "currency_id", "ref"];

  server.registerTool(
    "search_invoices",
    {
      description:
        "Search invoices, credit notes and vendor bills. type: customer_invoice (default), customer_credit_note, vendor_bill, vendor_refund, customer (both customer kinds) or vendor. Filter by query (number, origin order, reference or partner name), partner, state (draft, posted, cancel), payment_state (not_paid, partial, in_payment, paid), overdue (posted, unpaid and past due) and invoice date range. Newest first.",
      inputSchema: {
        type: z.enum(Object.keys(MOVE_TYPES) as [keyof typeof MOVE_TYPES]).default("customer_invoice"),
        query: z.string().optional(),
        partner: Who,
        state: z.string().optional(),
        payment_state: z.string().optional(),
        overdue: z.boolean().default(false),
        date_from: Day.optional(),
        date_to: Day.optional(),
        limit: limit(20, 100),
      },
    },
    tool(async ({ type, query, partner: who, state, payment_state, overdue, date_from, date_to, limit }) => {
      const fields = await odoo.require("account.move", "is the Invoicing app installed?");
      const domain: Domain = [["move_type", "in", [...MOVE_TYPES[type]]], ...partnerLeaf(who), ...dateRange("invoice_date", date_from, date_to, false)];
      if (query) domain.push(...anyOf(fields, ["name", "invoice_origin", "ref", "partner_id"], "ilike", query));
      if (state) domain.push(["state", "=", state]);
      if (payment_state) domain.push(["payment_state", "=", payment_state]);
      if (overdue) domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]], ["invoice_date_due", "<", today()]);
      return (await odoo.find("account.move", domain, INVOICE_LIST_FIELDS, { limit, order: "invoice_date desc" })).map(invoiceRow);
    }),
  );

  server.registerTool(
    "get_invoice",
    {
      description: "Get one invoice, credit note or bill by number (e.g. INV/2026/00008) or id: partner, lines, taxes, totals, what is still owed, payment terms and recent chatter.",
      inputSchema: { name: z.string().optional(), id: z.number().int().optional() },
    },
    tool(async ({ name, id }) => {
      if (!name && !id) throw new OdooError("Pass name or id");
      await odoo.require("account.move", "is the Invoicing app installed?");
      const domain: Domain = id ? [["id", "=", id]] : [["name", "=ilike", name]];
      const extra = ["invoice_line_ids", "amount_untaxed", "amount_tax", "invoice_payment_term_id", "narration", "payment_reference", "invoice_user_id"];
      const [r] = await odoo.find("account.move", domain, [...INVOICE_LIST_FIELDS, ...extra], { limit: 1 });
      if (!r) throw new OdooError(`No invoice ${name ?? id}`);
      const [lines, messages] = await Promise.all([
        odoo.read("account.move.line", r.invoice_line_ids, ["product_id", "name", "quantity", "price_unit", "discount", "price_subtotal", "price_total", "tax_ids", "display_type"]),
        odoo.find("mail.message", [["model", "=", "account.move"], ["res_id", "=", r.id], ...NOT_NOTIFICATIONS], MESSAGE_FIELDS, { limit: 5, order: "date desc" }),
      ]);
      return {
        ...invoiceRow(r),
        ...compact(r, {
          untaxed: first("amount_untaxed"),
          tax: first("amount_tax"),
          payment_terms: (x) => nameOf(x.invoice_payment_term_id) ?? undefined,
          payment_reference: first("payment_reference"),
          salesperson: (x) => nameOf(x.invoice_user_id) ?? undefined,
          notes: (x) => (x.narration === undefined ? undefined : htmlToText(x.narration, max)),
        }),
        lines: lines
          .filter((l) => !l.display_type || l.display_type === "product")
          .map((l) =>
            compact(l, {
              product: (x) => nameOf(x.product_id),
              description: (x) => htmlToText(x.name, 120),
              qty: "quantity",
              unit_price: "price_unit",
              discount: first("discount"),
              subtotal: "price_subtotal",
              total: first("price_total"),
            }),
          ),
        messages: messages.map(message),
      };
    }),
  );

  server.registerTool(
    "aged_balances",
    {
      description:
        "Who owes us (receivable, default) or whom we owe (payable): posted, unpaid invoices or bills per partner, split into not yet due, 1-30, 31-60, 61-90 and over 90 days overdue, biggest balance first, with the oldest overdue invoices.",
      inputSchema: { kind: z.enum(["receivable", "payable"]).default("receivable"), as_of: Day.optional().describe("Default today"), limit: limit(20, 100) },
    },
    tool(async ({ kind, as_of, limit }) => {
      await odoo.require("account.move", "is the Invoicing app installed?");
      const asOf = as_of ?? today();
      const types = kind === "receivable" ? ["out_invoice", "out_refund"] : ["in_invoice", "in_refund"];
      const rows = await odoo.find(
        "account.move",
        [["move_type", "in", types], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]],
        ["name", "partner_id", "move_type", "invoice_date", "invoice_date_due", "amount_residual", "amount_total"],
        { limit: 2000, order: "invoice_date_due" },
      );
      const day = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
      const buckets = ["not_due", "1_30", "31_60", "61_90", "over_90"] as const;
      const by = new Map<string, { partner: unknown; total: number; overdue: number; invoices: number } & Record<(typeof buckets)[number], number>>();
      const overdueList: Record<string, unknown>[] = [];
      for (const r of rows) {
        const sign = r.move_type === "out_refund" || r.move_type === "in_refund" ? -1 : 1;
        const owed = sign * num(r.amount_residual);
        const due = typeof r.invoice_date_due === "string" ? r.invoice_date_due : typeof r.invoice_date === "string" ? r.invoice_date : asOf;
        const late = Math.floor((day(asOf) - day(due)) / 86_400_000);
        const bucket = late <= 0 ? "not_due" : late <= 30 ? "1_30" : late <= 60 ? "31_60" : late <= 90 ? "61_90" : "over_90";
        const key = Array.isArray(r.partner_id) ? String(r.partner_id[0]) : "none";
        const row = by.get(key) ?? { partner: value(r.partner_id), total: 0, overdue: 0, invoices: 0, not_due: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 };
        row.total += owed;
        row[bucket] += owed;
        if (late > 0) row.overdue += owed;
        row.invoices++;
        by.set(key, row);
        if (late > 0 && sign > 0) overdueList.push({ id: r.id, name: r.name, partner: nameOf(r.partner_id), due, days_overdue: late, owed: round2(owed) });
      }
      const partners = [...by.values()]
        .map((p) => ({ ...p, ...Object.fromEntries([...buckets, "total", "overdue"].map((b) => [b, round2(p[b as keyof typeof p] as number)])) }))
        .sort((a, b) => (b.total as number) - (a.total as number));
      const sum = (k: string) => round2(partners.reduce((t, p) => t + (p[k as keyof typeof p] as number), 0));
      return {
        kind,
        as_of: asOf,
        totals: Object.fromEntries([...buckets, "total", "overdue"].map((b) => [b, sum(b)])),
        partners: partners.slice(0, limit),
        oldest_overdue: overdueList.sort((a, b) => (b.days_overdue as number) - (a.days_overdue as number)).slice(0, 10),
      };
    }),
  );

  server.registerTool(
    "search_payments",
    {
      description: "Payments received (inbound) or sent (outbound), newest first: amount, partner, date, journal, state, memo and the invoices they paid.",
      inputSchema: {
        direction: z.enum(["inbound", "outbound", "any"]).default("inbound"),
        partner: Who,
        date_from: Day.optional(),
        date_to: Day.optional(),
        limit: limit(20, 100),
      },
    },
    tool(async ({ direction, partner: who, date_from, date_to, limit }) => {
      await odoo.require("account.payment", "is the Invoicing app installed?");
      const domain: Domain = [...partnerLeaf(who), ...dateRange("date", date_from, date_to, false)];
      if (direction !== "any") domain.push(["payment_type", "=", direction]);
      const rows = await odoo.find(
        "account.payment",
        domain,
        ["name", "date", "partner_id", "amount", "currency_id", "payment_type", "journal_id", "state", "memo", "ref", "reconciled_invoice_ids", "reconciled_bill_ids"],
        { limit, order: "date desc" },
      );
      const invoiceIds = [...new Set(rows.flatMap((r) => [r.reconciled_invoice_ids, r.reconciled_bill_ids].flatMap((v) => (Array.isArray(v) ? (v as number[]) : []))))];
      const invoices = new Map((await odoo.read("account.move", invoiceIds, ["name"])).map((m) => [m.id, m.name]));
      return rows.map((r) =>
        compact(r, {
          name: "name",
          date: "date",
          partner: "partner_id",
          amount: "amount",
          currency: (x) => nameOf(x.currency_id) ?? undefined,
          direction: "payment_type",
          journal: (x) => nameOf(x.journal_id) ?? undefined,
          state: "state",
          memo: first("memo", "ref"),
          paid: (x) =>
            [x.reconciled_invoice_ids, x.reconciled_bill_ids].flatMap((v) => (Array.isArray(v) ? (v as number[]) : [])).map((id) => invoices.get(id) ?? id),
        }),
      );
    }),
  );

  server.registerTool(
    "search_deliveries",
    {
      description:
        "Search transfers: deliveries to customers (type outgoing, default), receipts from suppliers (incoming), internal moves or any. Filter by query (reference or source document, e.g. S00042), partner, state (draft, waiting, confirmed, assigned = ready, done, cancel), open (not done or cancelled) and late (open and scheduled before now). Soonest first.",
      inputSchema: {
        type: z.enum(["outgoing", "incoming", "internal", "any"]).default("outgoing"),
        query: z.string().optional(),
        partner: Who,
        state: z.string().optional(),
        open: z.boolean().default(false),
        late: z.boolean().default(false),
        limit: limit(20, 100),
      },
    },
    tool(async ({ type, query, partner: who, state, open, late, limit }) => {
      const fields = await odoo.require("stock.picking", "is the Inventory app installed?");
      const domain: Domain = [...partnerLeaf(who)];
      if (type !== "any") domain.push(["picking_type_code", "=", type]);
      if (query) domain.push(...anyOf(fields, ["name", "origin", "carrier_tracking_ref"], "ilike", query));
      if (state) domain.push(["state", "=", state]);
      if (open || late) domain.push(["state", "not in", ["done", "cancel"]]);
      if (late) domain.push(["scheduled_date", "<", new Date().toISOString().slice(0, 19).replace("T", " ")]);
      return (await odoo.find("stock.picking", domain, PICKING_FIELDS, { limit, order: "scheduled_date" })).map(picking);
    }),
  );

  server.registerTool(
    "get_delivery",
    {
      description: "Get one transfer (delivery, receipt) by reference (e.g. WH/OUT/00017) or id: products with quantities demanded and done, carrier, tracking, source document and recent chatter.",
      inputSchema: { name: z.string().optional(), id: z.number().int().optional() },
    },
    tool(async ({ name, id }) => {
      if (!name && !id) throw new OdooError("Pass name or id");
      await odoo.require("stock.picking", "is the Inventory app installed?");
      const domain: Domain = id ? [["id", "=", id]] : [["name", "=ilike", name]];
      const [r] = await odoo.find("stock.picking", domain, [...PICKING_FIELDS, "move_ids", "note", "location_id", "location_dest_id"], { limit: 1 });
      if (!r) throw new OdooError(`No transfer ${name ?? id}`);
      const [moves, messages] = await Promise.all([
        odoo.read("stock.move", r.move_ids, ["product_id", "product_uom_qty", "quantity", "quantity_done", "product_uom", "state"]),
        odoo.find("mail.message", [["model", "=", "stock.picking"], ["res_id", "=", r.id], ...NOT_NOTIFICATIONS], MESSAGE_FIELDS, { limit: 5, order: "date desc" }),
      ]);
      return {
        ...picking(r),
        ...compact(r, {
          from: (x) => nameOf(x.location_id) ?? undefined,
          to: (x) => nameOf(x.location_dest_id) ?? undefined,
          note: (x) => (x.note === undefined ? undefined : htmlToText(x.note, max)),
        }),
        moves: moves.map((m) =>
          compact(m, {
            product: (x) => nameOf(x.product_id),
            demand: "product_uom_qty",
            done: first("quantity", "quantity_done"),
            uom: (x) => nameOf(x.product_uom) ?? undefined,
            state: "state",
          }),
        ),
        messages: messages.map(message),
      };
    }),
  );

  server.registerTool(
    "stock_by_location",
    {
      description: "Where a product's stock is: on-hand and reserved quantity per internal location (and lot/serial), with the total. Pass the product id or SKU.",
      inputSchema: { product_id: z.number().int().optional(), sku: z.string().optional() },
    },
    tool(async ({ product_id, sku }) => {
      if (!product_id && !sku) throw new OdooError("Pass product_id or sku");
      await odoo.require("stock.quant", "is the Inventory app installed?");
      const [p] = await odoo.find("product.product", product_id ? [["id", "=", product_id]] : [["default_code", "=ilike", sku]], ["default_code", "display_name", "name"], { limit: 1 });
      if (!p) throw new OdooError(`No product with ${product_id ? `id ${product_id}` : `SKU ${sku}`}`);
      const quants = await odoo.find("stock.quant", [["product_id", "=", p.id]], ["location_id", "quantity", "reserved_quantity", "lot_id"], { limit: 200 });
      const locationIds = [...new Set(quants.map((q) => (Array.isArray(q.location_id) ? (q.location_id[0] as number) : 0)).filter(Boolean))];
      const usage = new Map((await odoo.read("stock.location", locationIds, ["usage"])).map((l) => [l.id, l.usage]));
      const internal = quants.filter((q) => Array.isArray(q.location_id) && (usage.get(q.location_id[0] as number) ?? "internal") === "internal");
      return {
        product: compact(p, { sku: "default_code", name: stripSku }),
        on_hand: round2(internal.reduce((t, q) => t + num(q.quantity), 0)),
        reserved: round2(internal.reduce((t, q) => t + num(q.reserved_quantity), 0)),
        locations: internal.map((q) =>
          compact(q, { location: (x) => nameOf(x.location_id), quantity: "quantity", reserved: first("reserved_quantity"), lot: (x) => nameOf(x.lot_id) ?? undefined }),
        ),
      };
    }),
  );

  server.registerTool(
    "search_purchase_orders",
    {
      description: "Search purchase orders and RFQs by query (reference, vendor reference or vendor name), vendor, state (draft = RFQ, sent, to approve, purchase, done, cancel) and order date range. Newest first.",
      inputSchema: {
        query: z.string().optional(),
        vendor: Who,
        state: z.string().optional(),
        date_from: Day.optional(),
        date_to: Day.optional(),
        limit: limit(20, 100),
      },
    },
    tool(async ({ query, vendor, state, date_from, date_to, limit }) => {
      const fields = await odoo.require("purchase.order", "is the Purchase app installed?");
      const domain: Domain = [...partnerLeaf(vendor), ...dateRange("date_order", date_from, date_to)];
      if (query) domain.push(...anyOf(fields, ["name", "partner_ref", "partner_id", "origin"], "ilike", query));
      if (state) domain.push(["state", "=", state]);
      return (await odoo.find("purchase.order", domain, PURCHASE_FIELDS, { limit, order: "date_order desc" })).map(purchase);
    }),
  );

  server.registerTool(
    "get_purchase_order",
    {
      description: "Get one purchase order by reference (e.g. P00070) or id: lines with quantities ordered, received and billed, receipts, vendor bills and recent chatter.",
      inputSchema: { name: z.string().optional(), id: z.number().int().optional() },
    },
    tool(async ({ name, id }) => {
      if (!name && !id) throw new OdooError("Pass name or id");
      await odoo.require("purchase.order", "is the Purchase app installed?");
      const domain: Domain = id ? [["id", "=", id]] : [["name", "=ilike", name]];
      const [r] = await odoo.find("purchase.order", domain, [...PURCHASE_FIELDS, "order_line", "picking_ids", "invoice_ids", "notes"], { limit: 1 });
      if (!r) throw new OdooError(`No purchase order ${name ?? id}`);
      const [lines, pickings, bills, messages] = await Promise.all([
        odoo.read("purchase.order.line", r.order_line, ["product_id", "name", "product_qty", "qty_received", "qty_invoiced", "price_unit", "price_subtotal", "date_planned", "display_type"]),
        odoo.read("stock.picking", r.picking_ids, PICKING_FIELDS),
        odoo.read("account.move", r.invoice_ids, INVOICE_FIELDS),
        odoo.find("mail.message", [["model", "=", "purchase.order"], ["res_id", "=", r.id], ...NOT_NOTIFICATIONS], MESSAGE_FIELDS, { limit: 5, order: "date desc" }),
      ]);
      return {
        ...purchase(r),
        notes: htmlToText(r.notes, max),
        lines: lines
          .filter((l) => !l.display_type)
          .map((l) =>
            compact(l, {
              product: (x) => nameOf(x.product_id),
              description: (x) => htmlToText(x.name, 120),
              qty: "product_qty",
              received: first("qty_received"),
              billed: first("qty_invoiced"),
              unit_price: "price_unit",
              subtotal: "price_subtotal",
              expected: first("date_planned"),
            }),
          ),
        receipts: pickings.map(picking),
        bills: bills.map(invoice),
        messages: messages.map(message),
      };
    }),
  );

  server.registerTool(
    "product_suppliers",
    {
      description: "A product's vendors (purchase price lists): vendor, their product code, price, minimum quantity and lead time in days.",
      inputSchema: { product_id: z.number().int() },
    },
    tool(async ({ product_id }) => {
      await odoo.require("product.supplierinfo", "is the Purchase app installed?");
      const [p] = await odoo.read("product.product", [product_id], ["product_tmpl_id", "display_name"]);
      if (!p) throw new OdooError(`No product with id ${product_id}`);
      const tmpl = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : null;
      const domain: Domain = tmpl ? ["|", ["product_id", "=", product_id], "&", ["product_tmpl_id", "=", tmpl], ["product_id", "=", false]] : [["product_id", "=", product_id]];
      const rows = await odoo.find("product.supplierinfo", domain, ["partner_id", "product_code", "product_name", "price", "currency_id", "min_qty", "delay", "date_start", "date_end", "product_id"], { limit: 50, order: "sequence" });
      return rows.map((r) =>
        compact(r, {
          vendor: "partner_id",
          vendor_code: first("product_code"),
          vendor_name: first("product_name"),
          price: "price",
          currency: (x) => nameOf(x.currency_id) ?? undefined,
          min_qty: first("min_qty"),
          lead_days: first("delay"),
          valid_from: first("date_start"),
          valid_to: first("date_end"),
        }),
      );
    }),
  );

  server.registerTool(
    "sales_summary",
    {
      description:
        "Sales figures for a period (default the last 30 days): confirmed orders, revenue untaxed and with tax, average order, and the top products and customers by revenue. Optionally one website (id). Dates are order dates.",
      inputSchema: { date_from: Day.optional(), date_to: Day.optional(), website_id: z.number().int().optional(), top: limit(10, 50) },
    },
    tool(async ({ date_from, date_to, website_id, top }) => {
      await odoo.require("sale.order", "is the Sales app installed?");
      const to = date_to ?? today();
      const from = date_from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const domain: Domain = [["state", "in", ["sale", "done"]], ...dateRange("date_order", from, to)];
      if (website_id) domain.push(["website_id", "=", website_id]);
      const orders = await odoo.find("sale.order", domain, ["name", "partner_id", "amount_untaxed", "amount_total", "order_line"], { limit: 5000, order: "date_order" });
      const untaxed = orders.reduce((t, o) => t + num(o.amount_untaxed), 0);
      const total = orders.reduce((t, o) => t + num(o.amount_total), 0);
      const customers = new Map<string, { customer: unknown; orders: number; untaxed: number }>();
      for (const o of orders) {
        const key = Array.isArray(o.partner_id) ? String(o.partner_id[0]) : "none";
        const c = customers.get(key) ?? { customer: value(o.partner_id), orders: 0, untaxed: 0 };
        c.orders++;
        c.untaxed += num(o.amount_untaxed);
        customers.set(key, c);
      }
      const lineIds = orders.flatMap((o) => (Array.isArray(o.order_line) ? (o.order_line as number[]) : []));
      const lines = lineIds.length ? await odoo.read("sale.order.line", lineIds, ["product_id", "product_uom_qty", "price_subtotal", "display_type", "is_delivery"]) : [];
      const products = new Map<string, { product: unknown; qty: number; untaxed: number }>();
      for (const l of lines) {
        if (l.display_type || l.is_delivery || !Array.isArray(l.product_id)) continue;
        const key = String(l.product_id[0]);
        const p = products.get(key) ?? { product: value(l.product_id), qty: 0, untaxed: 0 };
        p.qty += num(l.product_uom_qty);
        p.untaxed += num(l.price_subtotal);
        products.set(key, p);
      }
      const ranked = <T extends { untaxed: number }>(m: Map<string, T>) =>
        [...m.values()].sort((a, b) => b.untaxed - a.untaxed).slice(0, top).map((x) => ({ ...x, untaxed: round2(x.untaxed) }));
      return {
        from,
        to,
        orders: orders.length,
        untaxed: round2(untaxed),
        total: round2(total),
        average_order_untaxed: orders.length ? round2(untaxed / orders.length) : 0,
        top_products: ranked(products),
        top_customers: ranked(customers),
        ...(orders.length === 5000 ? { note: "Only the first 5000 orders were counted; use a shorter period." } : {}),
      };
    }),
  );

  server.registerTool(
    "search_leads",
    {
      description: "Search CRM leads and opportunities by query (title, contact, company, email), type (lead, opportunity), stage name, salesperson (user id) and whether open (not won or lost; default). Newest first.",
      inputSchema: {
        query: z.string().optional(),
        type: z.enum(["lead", "opportunity"]).optional(),
        stage: z.string().optional(),
        user_id: z.number().int().optional(),
        open: z.boolean().default(true),
        limit: limit(20, 100),
      },
    },
    tool(async ({ query, type, stage, user_id, open, limit }) => {
      const fields = await odoo.require("crm.lead", "is the CRM app installed?");
      const domain: Domain = [];
      if (query) domain.push(...anyOf(fields, ["name", "contact_name", "partner_name", "email_from", "partner_id"], "ilike", query));
      if (type) domain.push(["type", "=", type]);
      if (stage) domain.push(["stage_id", "ilike", stage]);
      if (user_id) domain.push(["user_id", "=", user_id]);
      if (open && fields.has("active")) domain.push(["active", "=", true]);
      if (open && fields.has("probability")) domain.push(["probability", "<", 100]);
      const rows = await odoo.find(
        "crm.lead",
        domain,
        ["name", "type", "partner_id", "partner_name", "contact_name", "email_from", "phone", "stage_id", "user_id", "expected_revenue", "probability", "date_deadline", "priority", "create_date", "description"],
        { limit, order: "create_date desc" },
      );
      return rows.map((r) =>
        compact(r, {
          title: "name",
          type: first("type"),
          customer: (x) => value(x.partner_id) ?? value(x.partner_name),
          contact: first("contact_name"),
          email: first("email_from"),
          phone: first("phone"),
          stage: (x) => nameOf(x.stage_id) ?? undefined,
          salesperson: (x) => nameOf(x.user_id) ?? undefined,
          expected_revenue: first("expected_revenue"),
          probability: first("probability"),
          deadline: first("date_deadline"),
          priority: first("priority"),
          created: first("create_date"),
          description: (x) => (x.description === undefined ? undefined : htmlToText(x.description, 300)),
        }),
      );
    }),
  );

  server.registerTool(
    "search_tickets",
    {
      description: "Search helpdesk tickets by query (subject, reference, customer name or email), stage name, team, customer and whether open (not in a closing stage; default). Newest first.",
      inputSchema: { query: z.string().optional(), stage: z.string().optional(), team: z.string().optional(), partner: Who, open: z.boolean().default(true), limit: limit(20, 100) },
    },
    tool(async ({ query, stage, team, partner: who, open, limit }) => {
      const fields = await odoo.require("helpdesk.ticket", "is the Helpdesk app installed?");
      const domain: Domain = [...partnerLeaf(who)];
      if (query) domain.push(...anyOf(fields, ["name", "ticket_ref", "partner_name", "partner_email", "partner_id"], "ilike", query));
      if (stage) domain.push(["stage_id", "ilike", stage]);
      if (team) domain.push(["team_id", "ilike", team]);
      if (open) {
        if (fields.has("fold")) domain.push(["fold", "=", false]);
        else if (fields.has("close_date")) domain.push(["close_date", "=", false]);
      }
      const rows = await odoo.find(
        "helpdesk.ticket",
        domain,
        ["name", "ticket_ref", "partner_id", "partner_name", "partner_email", "team_id", "stage_id", "user_id", "priority", "create_date", "close_date", "description"],
        { limit, order: "create_date desc" },
      );
      return rows.map((r) =>
        compact(r, {
          subject: "name",
          ref: first("ticket_ref"),
          customer: (x) => value(x.partner_id) ?? value(x.partner_name),
          email: first("partner_email"),
          team: (x) => nameOf(x.team_id) ?? undefined,
          stage: (x) => nameOf(x.stage_id) ?? undefined,
          assigned: (x) => nameOf(x.user_id) ?? undefined,
          priority: first("priority"),
          created: first("create_date"),
          closed: first("close_date"),
          description: (x) => (x.description === undefined ? undefined : htmlToText(x.description, 300)),
        }),
      );
    }),
  );

  server.registerTool(
    "search_activities",
    {
      description:
        "Scheduled activities (to-dos, calls, emails, meetings on records), soonest due first. when: overdue, today, upcoming or all (default). Optionally one model (e.g. sale.order) or user (user id). Use the ids with odoo.activity.done.",
      inputSchema: {
        when: z.enum(["overdue", "today", "upcoming", "all"]).default("all"),
        model: z.string().optional(),
        user_id: z.number().int().optional(),
        limit: limit(30, 100),
      },
    },
    tool(async ({ when, model, user_id, limit }) => {
      await odoo.require("mail.activity", "activities");
      const d = today();
      const domain: Domain = [];
      if (when === "overdue") domain.push(["date_deadline", "<", d]);
      if (when === "today") domain.push(["date_deadline", "=", d]);
      if (when === "upcoming") domain.push(["date_deadline", ">", d]);
      if (model) domain.push(["res_model", "=", model]);
      if (user_id) domain.push(["user_id", "=", user_id]);
      const rows = await odoo.find("mail.activity", domain, ["res_model", "res_id", "res_name", "activity_type_id", "summary", "note", "date_deadline", "user_id", "state"], {
        limit,
        order: "date_deadline",
      });
      return rows.map((r) =>
        compact(r, {
          on: (x) => `${String(x.res_model)},${String(x.res_id)}`,
          record: first("res_name"),
          type: (x) => nameOf(x.activity_type_id) ?? undefined,
          summary: first("summary"),
          note: (x) => (x.note === undefined ? undefined : htmlToText(x.note, 300)),
          due: "date_deadline",
          assigned: (x) => nameOf(x.user_id) ?? undefined,
          state: first("state"),
        }),
      );
    }),
  );

  server.registerTool(
    "search_records",
    {
      description:
        "Read any Odoo model the other tools don't cover (e.g. res.users, stock.lot, account.journal, product.pricelist, uom.uom, crm.stage, helpdesk.stage, mail.activity.type, product.category, delivery.carrier). domain is Odoo's, e.g. [[\"name\",\"ilike\",\"x\"]]; fields lists what to return (unknown ones are dropped). Returns the matching count and records. Read-only.",
      inputSchema: {
        model: z.string().regex(/^[a-z0-9_.]+$/, "an Odoo model name, e.g. stock.lot"),
        domain: z.array(z.unknown()).default([]),
        fields: z.array(z.string()).min(1).max(40),
        order: z.string().optional(),
        limit: limit(20, 200),
        offset: z.number().int().min(0).default(0),
      },
    },
    tool(async ({ model, domain, fields, order, limit, offset }) => {
      const available = await odoo.has(model);
      if (!available) throw new OdooRpcError(`Odoo has no ${model} model`, "missing_model", "KeyError");
      const unknown = fields.filter((f) => !available.has(f));
      const [count, rows] = await Promise.all([
        odoo.count(model, domain as Domain),
        odoo.find(model, domain as Domain, fields, { limit, offset, order }),
      ]);
      return {
        count,
        records: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > max * 2 ? `${v.slice(0, max * 2)}…` : value(v)]))),
        ...(unknown.length ? { unknown_fields: unknown } : {}),
      };
    }),
  );
}
