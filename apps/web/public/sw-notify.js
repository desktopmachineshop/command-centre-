// Pure notification logic for the service worker (sw.js loads it with importScripts).
// Tested in apps/web/test/sw-notify.test.ts. No DOM, no network: input in, output out.
(function (root) {
  /** The in-app route a push links to, with `n=<notification id>` so the app marks it read. */
  function withNotification(path, id) {
    if (!id) return path;
    return path + (path.includes("?") ? "&" : "?") + "n=" + encodeURIComponent(id);
  }

  /**
   * Where a click goes. Approve/Reject buttons never act from the lock screen:
   * they open the app at the proposal with `action=approve|reject`, and the
   * Approvals page asks to confirm (and sends the request with the app's own
   * credentials). Everything else opens the notification's URL.
   */
  function clickTarget(data, action) {
    data = data || {};
    var id = data.notificationId || data.id;
    var proposalId = data.proposalId;
    if ((action === "approve" || action === "reject") && proposalId) {
      return withNotification("/approvals/" + encodeURIComponent(proposalId) + "?action=" + action, id);
    }
    var url = typeof data.url === "string" && data.url.charAt(0) === "/" ? data.url : "/notifications";
    return withNotification(url, id);
  }

  /**
   * A button that acts without opening the app: reminder Done/Snooze carry a
   * pre-signed link in `data.actionUrls[action]`. Only same-origin
   * `/api/pa/reminders/...` links are allowed. Null for every other click.
   */
  function backgroundAction(data, action) {
    var urls = (data && data.actionUrls) || {};
    var url = action ? urls[action] : null;
    return typeof url === "string" && url.indexOf("/api/pa/reminders/") === 0 ? url : null;
  }

  /** The PWA uses hash routes. */
  function appUrl(path) {
    return "/#" + path;
  }

  /** showNotification(title, options) arguments for a push payload (old `{title, body, url}` payloads too). */
  function notificationOptions(payload) {
    var p = payload || {};
    var options = {
      body: p.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      silent: Boolean(p.silent),
      requireInteraction: Boolean(p.requireInteraction),
      data: Object.assign({}, p.data || {}, { url: p.url || "/", notificationId: (p.data && p.data.notificationId) || p.id, category: p.category }),
      actions: Array.isArray(p.actions) ? p.actions.slice(0, 2) : [],
    };
    // renotify is only valid with a tag.
    if (p.tag) {
      options.tag = p.tag;
      options.renotify = Boolean(p.renotify);
    }
    return { title: p.title || "Command Centre", options: options };
  }

  var api = { clickTarget: clickTarget, appUrl: appUrl, notificationOptions: notificationOptions, backgroundAction: backgroundAction };
  root.CCNotify = api;
})(typeof self !== "undefined" ? self : globalThis);
