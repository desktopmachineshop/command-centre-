import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Load the service worker's pure helpers the way importScripts does: as a classic script on `self`.
const self: Record<string, any> = {};
runInNewContext(readFileSync(new URL("../public/sw-notify.js", import.meta.url), "utf8"), { self });
const { clickTarget, appUrl, notificationOptions } = self.CCNotify;

describe("service worker notification logic", () => {
  it("opens the confirm step for Approve/Reject instead of acting from the lock screen", () => {
    const data = { proposalId: "p-1", notificationId: "n-1", url: "/approvals/p-1" };
    expect(clickTarget(data, "approve")).toBe("/approvals/p-1?action=approve&n=n-1");
    expect(clickTarget(data, "reject")).toBe("/approvals/p-1?action=reject&n=n-1");
    // A plain click on the approval opens the proposal.
    expect(clickTarget(data, "")).toBe("/approvals/p-1?n=n-1");
    expect(appUrl(clickTarget(data, "approve"))).toBe("/#/approvals/p-1?action=approve&n=n-1");
  });

  it("opens other categories at their URL", () => {
    expect(clickTarget({ url: "/briefing/n-2", notificationId: "n-2" }, "")).toBe("/briefing/n-2?n=n-2");
    expect(clickTarget({ url: "/notifications?category=agent" }, "")).toBe("/notifications?category=agent");
    expect(clickTarget({ url: "https://evil.example" }, "")).toBe("/notifications");
    expect(clickTarget(undefined, "approve")).toBe("/notifications");
  });

  it("builds showNotification options with tag, renotify, silent and actions", () => {
    const { title, options } = notificationOptions({
      id: "n-1",
      title: "Approve: DMS",
      body: "Reply to Bob",
      url: "/approvals/p-1",
      category: "approval",
      tag: "approvals",
      renotify: true,
      silent: false,
      actions: [
        { action: "approve", title: "Approve" },
        { action: "reject", title: "Reject" },
        { action: "extra", title: "Extra" },
      ],
      data: { proposalId: "p-1", notificationId: "n-1" },
    });
    expect(title).toBe("Approve: DMS");
    expect(options).toMatchObject({ body: "Reply to Bob", tag: "approvals", renotify: true, silent: false });
    expect(options.actions.map((a: any) => a.action)).toEqual(["approve", "reject"]);
    expect(options.data).toMatchObject({ url: "/approvals/p-1", proposalId: "p-1", notificationId: "n-1", category: "approval" });
  });

  it("shows an http(s) image as the large picture, and ignores anything else", () => {
    expect(notificationOptions({ title: "A", image: "https://cc.example/media/b.png" }).options.image).toBe("https://cc.example/media/b.png");
    expect(notificationOptions({ title: "A", image: "javascript:alert(1)" }).options.image).toBeUndefined();
    expect(notificationOptions({ title: "A" }).options.image).toBeUndefined();
  });

  it("still shows old {title, body, url} payloads, with no renotify without a tag", () => {
    const { title, options } = notificationOptions({ title: "Hi", body: "There", url: "/" });
    expect(title).toBe("Hi");
    expect(options.tag).toBeUndefined();
    expect(options.renotify).toBeUndefined();
    expect(options.silent).toBe(false);
    expect(options.data.url).toBe("/");
  });

  it("runs reminder Done/Snooze in the background through their signed links, and nothing else", () => {
    const { backgroundAction } = self.CCNotify;
    const data = { actionUrls: { done: "/api/pa/reminders/r1/push/done?sig=x", snooze: "/api/pa/reminders/r1/push/snooze?sig=y", evil: "https://evil.example/" } };
    expect(backgroundAction(data, "done")).toBe("/api/pa/reminders/r1/push/done?sig=x");
    expect(backgroundAction(data, "snooze")).toBe("/api/pa/reminders/r1/push/snooze?sig=y");
    expect(backgroundAction(data, "evil")).toBeNull();
    expect(backgroundAction(data, "")).toBeNull();
    expect(backgroundAction({ proposalId: "p" }, "approve")).toBeNull();
  });
});
