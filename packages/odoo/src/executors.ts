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

export type OdooWriter = Pick<OdooClient, "call" | "create" | "write" | "read" | "searchRead">;

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
  };
}
