import type { Policy } from "@cc/core";

/**
 * Internal actions that run without an approval step in every vertical: they only touch Dave's
 * own reminders, to-do lists and devices. A "chaser" is one of these: a reminder (pa.reminder.*),
 * a to-do (pa.items.add) or a nudge to Dave's devices (notify). Chasing anyone else (email.*,
 * social.*) keeps the vertical's policy, which is draft. Odoo writes, internal notes included,
 * always wait for Dave (ODOO_WRITE_POLICY in @cc/core). A task triggered by outside input still
 * gets drafts for all of these (ActionService).
 */
export const INTERNAL_AUTO_POLICIES = {
  "pa.reminder.add": "auto",
  "pa.reminder.update": "auto",
  "pa.reminder.complete": "auto",
  "pa.reminder.cancel": "auto",
  "pa.items.add": "auto",
  "pa.item.complete": "auto",
  notify: "auto-with-digest",
} as const satisfies Record<string, Policy>;
