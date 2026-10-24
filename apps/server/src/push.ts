import webpush from "web-push";
import type { Store } from "./db/store";

export interface PushMessage {
  title: string;
  body: string;
  /** App route opened on click, e.g. "/approvals". */
  url?: string;
  /** Notification buttons. The service worker POSTs to `url` (a pre-signed link) without opening the app. */
  actions?: { action: string; title: string; url: string }[];
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
}

export interface Notifier {
  readonly publicKey: string | null;
  notify(n: PushMessage): Promise<void>;
}

/** Web Push to every subscribed device (the installed PWA on phone and desktop). */
export class WebPushNotifier implements Notifier {
  readonly publicKey: string | null;

  constructor(
    private readonly store: Store,
    vapid?: { publicKey: string; privateKey: string; subject: string },
  ) {
    this.publicKey = vapid?.publicKey ?? null;
    if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async notify(n: PushMessage): Promise<void> {
    if (!this.publicKey) return;
    const payload = JSON.stringify(n);
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
