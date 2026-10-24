import type { NotificationInput } from "@cc/core";
import webpush from "web-push";
import type { Store } from "./db/store";

export type { NotificationInput } from "@cc/core";

/**
 * Anything that can notify Dave. `{title, body, url?}` is all a caller needs;
 * the optional `category`, `priority`, `vertical`, `tag`, `actions` and `data`
 * decide how it is delivered (see NotificationService in ./notifications).
 */
export interface Notifier {
  readonly publicKey: string | null;
  notify(n: NotificationInput): Promise<void>;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

/** Sends one push to one subscription. Errors carry `statusCode` (404/410 = gone). */
export interface PushTransport {
  readonly publicKey: string | null;
  send(subscription: any, payload: string, options: { urgency: PushUrgency; TTL: number; topic?: string }): Promise<void>;
}

/** Web Push with VAPID keys; without them `publicKey` is null and nothing is sent. */
export class WebPushTransport implements PushTransport {
  readonly publicKey: string | null;

  constructor(vapid?: { publicKey: string; privateKey: string; subject: string }) {
    this.publicKey = vapid?.publicKey ?? null;
    if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(subscription: any, payload: string, options: { urgency: PushUrgency; TTL: number; topic?: string }): Promise<void> {
    if (!this.publicKey) return;
    await webpush.sendNotification(subscription, payload, options);
  }
}

/**
 * The original fan-out: every notification to every device, unfiltered.
 * Kept for compatibility; the app uses NotificationService.
 */
export class WebPushNotifier implements Notifier {
  readonly publicKey: string | null;

  constructor(
    private readonly store: Store,
    vapid?: { publicKey: string; privateKey: string; subject: string },
  ) {
    this.publicKey = vapid?.publicKey ?? null;
    if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async notify(n: NotificationInput): Promise<void> {
    if (!this.publicKey) return;
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url });
    for (const sub of await this.store.listPushSubscriptions()) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err: any) {
        // Expired or revoked subscriptions are removed; anything else is retried next time.
        if (err?.statusCode === 404 || err?.statusCode === 410) await this.store.deletePushSubscription(sub.endpoint);
      }
    }
  }
}
