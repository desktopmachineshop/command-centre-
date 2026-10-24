// Service worker: offline app shell + web push notifications for approvals.
const SHELL = "cc-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])));
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

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Command Centre", body: "" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      tag: data.tag,
      // Reminder buttons ("Done", "Snooze 1h"): each carries a pre-signed URL the click POSTs to.
      actions: (data.actions ?? []).map((a) => ({ action: a.action, title: a.title })),
      data: { url: data.url ?? "/", actions: data.actions ?? [] },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const button = (event.notification.data?.actions ?? []).find((a) => a.action === event.action);
  if (button) {
    event.waitUntil(fetch(button.url, { method: "POST" }).catch(() => {}));
    return;
  }
  const target = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const existing = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        existing.focus();
        return existing.navigate(`/#${target}`);
      }
      return self.clients.openWindow(`/#${target}`);
    }),
  );
});
