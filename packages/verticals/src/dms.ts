import { defineVertical } from "@cc/core";
import { howWeWork } from "./how-we-work";
import { INTERNAL_AUTO_POLICIES } from "./policies";

const LOW_STOCK_CHECK = `Check Desktop Machine Shop stock.

1. Call the odoo tool low_stock (threshold 3) and read the brain note "dms/suppliers.md" if it exists.
2. For each product at or below the threshold, note its forecast and incoming quantities and, from the brain, its usual supplier and lead time.
3. Write the result to the brain as "dms/stock/<today>.md" (brain.write): product, SKU, on hand, incoming, supplier, suggested reorder quantity.
4. If anything is out of stock with nothing incoming, propose one "notify" titled "Low stock" listing those SKUs. Do not contact suppliers.`;

/** The shop's areas of work (the old org chart's roles), for its how-we-work note. */
const AREAS = [
    {
      id: "shop-lead",
      title: "Shop Lead",
      reportsTo: "chief-of-staff",
      aliases: ["shop"],
      mission:
        "Running the shop day to day on Dave's behalf: nothing left unowned, and the shop's notes in the brain kept current. Anything that needs Dave's attention across the business goes to him with notify.",
      skills: ["brain-notes", "email-triage-and-reply", "dms-customer-reply", "dms-order-status", "odoo-daily"],
      actions: ["brain.write", "notify", "email.reply", "email.label"],
      kpis: ["Nothing unowned for more than a day", "Weekly shop summary in the brain"],
      autonomyNotes:
        "Anything that reaches a customer, supplier or the storefront is a draft for Dave.",
    },
    {
      id: "customer-support",
      title: "Customer Support",
      reportsTo: "shop-lead",
      aliases: ["support"],
      mission:
        "Answers customers the way Dave would: pre-sales and compatibility questions, where an order is, returns and warranty claims. Works from live Odoo data and the brain, never from memory, and keeps each customer's history in the brain.",
      intents: ["presales-question", "order-status", "return-warranty", "customer-message", "review", "rfq"],
      skills: ["brain-notes", "email-triage-and-reply", "dms-customer-reply", "dms-order-status", "dms-ops", "odoo-daily", "social-platform-guide", "social-voice-dms"],
      mcpServers: ["brain", "odoo", "mail", "sendcloud"],
      actions: [
        "email.reply", "email.label", "odoo.message.post", "odoo.customer.create", "odoo.customer.update", "odoo.quote.create", "odoo.quote.update",
        "odoo.quote.send", "odoo.order.confirm", "odoo.invoice.send", "odoo.delivery.set_tracking", "odoo.activity.schedule", "odoo.activity.done",
        "odoo.lead.create", "odoo.lead.update", "odoo.ticket.update", "odoo.record.create", "odoo.record.update", "social.reply", "social.dm", "brain.write",
      ],
      kpis: ["First reply drafted within 1 hour", "Approval rate of drafted replies", "Returns resolved within policy"],
      autonomyNotes:
        "Drafts every customer reply, new customer contact and quotation for approval. Refunds, exchanges outside the returns policy, discounts and warranty decisions always need Dave.",
    },
    {
      id: "catalogue-pricing",
      title: "Catalogue & Pricing",
      reportsTo: "shop-lead",
      aliases: ["pricing", "catalogue", "catalog"],
      mission:
        "Keeps the Odoo catalogue accurate and the prices competitive: product facts, descriptions, gaps in the range and price checks against competitors. Proposes price changes with the net and VAT-inclusive figures and the reason, and sets up and ends discount and loyalty deals.",
      skills: ["brain-notes", "dms-catalogue-pricing", "odoo-daily"],
      // Supplier costs come from the price lists Ops & Admin files under dms/pricelists/ in the brain.
      mcpServers: ["brain", "odoo"],
      actions: [
        "odoo.product.update_price", "odoo.product.update", "odoo.product.create", "odoo.loyalty.create", "odoo.loyalty.archive",
        // Everything else in the catalogue (pricelist rules, categories, retiring a product): the generic record actions.
        "odoo.record.create", "odoo.record.update", "odoo.record.archive", "odoo.record.unarchive", "brain.write",
      ],
      kpis: ["Price review of top sellers each month", "Catalogue facts with no gaps (SKU, weight, HS code)"],
      autonomyNotes:
        "Every price change, new discount or loyalty deal and archived deal is a draft with what changes, the margin effect and the reason. Never edits product records directly.",
    },
    {
      id: "marketing-social",
      title: "Marketing & Social",
      reportsTo: "shop-lead",
      aliases: ["marketing", "social"],
      mission:
        "Gets the shop in front of hobbyist machinists: product posts, launch announcements and shop blog posts built from real Odoo facts. Keeps a steady, never pushy cadence across the DMS social accounts.",
      skills: ["brain-notes", "social-voice-dms", "social-platform-guide", "video-reel"],
      mcpServers: ["brain", "odoo", "video"],
      actions: ["social.post", "social.campaign", "video.produce", "video.revise", "video.export", "odoo.blog.draft"],
      kpis: ["2 to 3 posts a week", "Every post grounded in live product data"],
      autonomyNotes: "All posts, campaigns and blog drafts wait for Dave. Paid ads and promotions are never proposed without his ask.",
    },
    {
      id: "ops-admin",
      title: "Ops & Admin",
      reportsTo: "shop-lead",
      aliases: ["ops", "suppliers", "pricelists", "pricelist", "price-lists"],
      mission:
        "Handles the back office: supplier emails, stock and lead times, purchase prices, supplier price lists, invoices and bills. Files each one in the brain (price lists by vendor and date under dms/pricelists/), flags low stock early and keeps supplier notes current.",
      intents: ["supplier", "invoice-admin", "new-order", "stock-low", "delivery-late", "supplier-reply"],
      skills: ["brain-notes", "email-triage-and-reply", "dms-ops", "dms-order-status", "dms-supplier-pricelists", "odoo-daily"],
      mcpServers: ["brain", "odoo", "pa", "mail", "sendcloud"],
      actions: [
        "email.reply", "email.label", "email.send", "odoo.message.post", "odoo.order.confirm", "odoo.order.cancel", "odoo.invoice.create",
        "odoo.invoice.post", "odoo.invoice.send", "odoo.invoice.register_payment", "odoo.delivery.validate", "odoo.delivery.set_tracking",
        "odoo.stock.adjust", "odoo.purchase.create", "odoo.purchase.send", "odoo.purchase.confirm", "odoo.purchase.bill", "odoo.activity.schedule",
        "odoo.activity.done", "odoo.record.create", "odoo.record.update", "odoo.record.archive", "odoo.record.unarchive", "odoo.record.action", "notify", "brain.write",
      ],
      kpis: ["No stock-out without warning", "Every invoice filed within a day", "Every supplier price list in the brain within a day"],
      autonomyNotes:
        "May file notes in the brain and post internal Odoo notes. Every other Odoo change (invoices, payments, deliveries, stock counts, purchase orders) is a proposal Dave approves.",
    },
];

export default defineVertical({
  id: "dms",
  name: "Desktop Machine Shop",
  description: "Online retail of CNC accessories and kits, hosted on Odoo Online.",
  brainFolder: "dms",
  color: "#d9822b",
  intents: [
    "presales-question", "order-status", "return-warranty", "supplier", "invoice-admin", "spam",
    // Odoo events (rules triager, see @cc/triage odoo.ts)
    "new-order", "customer-message", "stock-low", "delivery-late", "review", "rfq", "supplier-reply",
  ],
  skills: ["brain-notes", "email-triage-and-reply", "dms-customer-reply", "dms-order-status", "dms-ops", "dms-supplier-pricelists", "odoo-daily", "social-voice-dms", "social-platform-guide", "video-reel"],
  // mail: read-only search and attachments of the DMS mailboxes, for work that didn't start from that email.
  mcpServers: ["brain", "odoo", "pa", "mail", "sendcloud", "video"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  schedules: [
    // Turn on once the Odoo low_stock threshold is agreed.
    { id: "low-stock-check", cron: "15 8 * * 1-5", timezone: "Europe/London", prompt: LOW_STOCK_CHECK, enabled: false },
  ],
  guidance: howWeWork("Desktop Machine Shop", AREAS),
});