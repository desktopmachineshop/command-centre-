import { z } from "zod";

/**
 * Notification model shared by the server (NotificationService) and the PWA
 * (notification centre and settings). See docs/SETUP.md, "Notifications".
 */

export const NOTIFICATION_CATEGORIES = [
  "approval",
  "briefing",
  "reminder",
  "alert",
  "digest",
  "social",
  "orders",
  "quotes",
  "system",
  "agent",
] as const;
export const NotificationCategory = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

/** Highest first. */
export const NOTIFICATION_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const NotificationPriority = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof NotificationPriority>;

/** How a category reaches Dave: a push now, folded into the next digest push, or in the app only. */
export const NotificationDelivery = z.enum(["push", "digest", "silent"]);
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  approval: "Approvals",
  briefing: "Briefings",
  reminder: "Reminders",
  alert: "Alerts",
  digest: "Digests",
  social: "Social",
  orders: "Orders",
  quotes: "RFQs and purchasing",
  system: "System",
  agent: "Agent messages",
};

/** A button on a push notification. The service worker maps `action` to what the click does. */
export interface NotificationAction {
  action: string;
  title: string;
}

/**
 * A picture or video a notification is about (a finished render, a generated
 * image). The notification centre and briefing view show it in place; a push
 * shows the first image as its large picture. `url` is absolute http(s).
 */
export interface NotificationMedia {
  url: string;
  type: "image" | "video";
  alt?: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

/**
 * What callers pass to `Notifier.notify`. Only `title` and `body` are
 * required, so `{title, body, url?}` from before categories keeps working:
 * the category is then inferred (see `inferCategory` on the server), else `agent`.
 */
export interface NotificationInput {
  title: string;
  body: string;
  /** In-app route opened on click, e.g. "/approvals". */
  url?: string;
  category?: NotificationCategory;
  /** Defaults to the category's priority in the preferences. */
  priority?: NotificationPriority;
  vertical?: string;
  /** Same tag replaces the previous notification on the device instead of stacking. */
  tag?: string;
  /** Alert again when replacing a notification with the same tag. Default: only for urgent/high. */
  renotify?: boolean;
  actions?: NotificationAction[];
  /** Images or videos to show with the notification (at most 4 are kept). */
  media?: NotificationMedia[];
  data?: Record<string, unknown>;
}

/** Where a stored notification went. */
export type NotificationStatus =
  | "sent" // pushed
  | "held" // quiet hours: waiting for the end-of-quiet summary
  | "released" // included in the end-of-quiet summary
  | "collapsed" // over the rate limit: folded into an "and N more" push
  | "batched" // waiting for the next digest push
  | "digested" // included in a digest push
  | "inapp" // delivery "silent": in the notification centre only
  | "muted"; // category turned off (kept, marked read)

/** A notification in the in-app notification centre (GET /api/notifications). */
export interface StoredNotification {
  id: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  vertical: string | null;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
  actions: NotificationAction[];
  media: NotificationMedia[];
  data: Record<string, unknown>;
  status: NotificationStatus;
  createdAt: string;
  pushedAt: string | null;
  readAt: string | null;
}

export const CategoryPrefs = z.object({
  enabled: z.boolean(),
  delivery: NotificationDelivery,
  /** false: the push is shown silently (Notification `silent: true`, no sound or vibration). */
  sound: z.boolean(),
  priority: NotificationPriority,
});
export type CategoryPrefs = z.infer<typeof CategoryPrefs>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const NotificationPrefs = z.object({
  categories: z.record(NotificationCategory, CategoryPrefs),
  /** Per-vertical overrides, e.g. `{ "3dpandme": { social: { enabled: false } } }`. */
  verticals: z.record(z.string(), z.partialRecord(NotificationCategory, CategoryPrefs.omit({ priority: true }).partial())),
  quietHours: z.object({
    enabled: z.boolean(),
    start: HHMM,
    end: HHMM,
    timezone: z.string().min(1),
    /** Let approval requests push during quiet hours too (urgent always does). */
    allowApprovals: z.boolean(),
  }),
  rateLimit: z.object({
    /** Pushes per category per window; extras collapse into one "and N more" push. 0 = unlimited. */
    perCategory: z.number().int().min(0).max(100),
    windowMinutes: z.number().int().min(1).max(1440),
  }),
  /** Deterministic counts push (no agent run) at `time` in the quiet-hours timezone. */
  quickBriefing: z.object({ enabled: z.boolean(), time: HHMM }),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** A push subscription with its device metadata (GET /api/notifications/devices). */
export interface NotificationDevice {
  id: string;
  name: string | null;
  platform: string | null;
  userAgent: string | null;
  /** Lowest priority this device receives: "low" = everything, "urgent" = urgent only. */
  minPriority: NotificationPriority;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}
