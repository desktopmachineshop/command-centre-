// Service worker: offline app shell + web push notifications.
importScripts("/sw-notify.js"); // notifications
const SHELL = "cc-shell-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/sw-notify.js"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (["/api", "/ws", "/mcp", "/media"].some((p) => url.pathname.startsWith(p))) return;
  // Network first so deploys show up immediately; cache is the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});

// --- notifications: categories, tags, actions, badge (pure logic in sw-notify.js) ---
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Command Centre", body: event.data ? event.data.text() : "" };
  }
  const { title, options } = self.CCNotify.notificationOptions(payload);
  const badge =
    typeof payload.unread === "number" && self.navigator.setAppBadge
      ? (payload.unread > 0 ? self.navigator.setAppBadge(payload.unread) : self.navigator.clearAppBadge()).catch(() => {})
      : Promise.resolve();
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), badge]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Reminder buttons (Done, Snooze 1h) act in the background through their pre-signed link.
  const background = self.CCNotify.backgroundAction(event.notification.data, event.action);
  if (background) {
    event.waitUntil(fetch(background, { method: "POST" }).catch(() => {}));
    return;
  }
  // Approve/Reject open the confirm step in the app; nothing is approved from the lock screen.
  const target = self.CCNotify.appUrl(self.CCNotify.clickTarget(event.notification.data, event.action));
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        return existing.focus().then((w) => (w || existing).navigate(target));
      }
      return self.clients.openWindow(target);
    }),
  );
});
// --- end notifications ---
