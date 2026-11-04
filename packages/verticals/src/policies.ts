import type { Policy } from "@cc/core";

/**
 * Internal actions that run without an approval step in every vertical: they only touch Dave's
 * own reminders, to-do lists and devices, or a staff-only Odoo note. A "chaser" is one of these:
 * a reminder (pa.reminder.*), a to-do (pa.items.add), a nudge to Dave's devices (notify) or an
 * internal note on an Odoo record (odoo.message.post with internal: true). Chasing anyone else
 * (email.*, a non-internal odoo.message.post, social.*) keeps the vertical's policy, which is
 * draft. A task triggered by outside input still gets drafts for all of these (ActionService).
 */
export const INTERNAL_AUTO_POLICIES = {
  "pa.reminder.add": "auto",
  "pa.reminder.update": "auto",
  "pa.reminder.complete": "auto",
  "pa.reminder.cancel": "auto",
  "pa.items.add": "auto",
  "pa.item.complete": "auto",
  notify: "auto-with-digest",
  // Policy key for odoo.message.post with internal: true (see proposalPolicy in @cc/core).
  "odoo.message.post.internal": "auto-with-digest",
} as const satisfies Record<string, Policy>;
