import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "dms",
  name: "Desktop Machine Shop",
  description: "Online retail of CNC accessories and kits, hosted on Odoo Online.",
  brainFolder: "dms",
  intents: [
    "presales-question", "order-status", "return-warranty", "supplier", "invoice-admin", "spam",
    // Odoo events (rules triager, see @cc/triage odoo.ts)
    "new-order", "customer-message", "stock-low", "delivery-late", "review",
  ],
  skills: ["brain-notes", "email-triage-and-reply", "dms-customer-reply", "dms-order-status", "dms-ops", "social-voice-dms", "social-platform-guide"],
  mcpServers: ["brain", "odoo"],
  policies: { "brain.write": "auto" },
});
