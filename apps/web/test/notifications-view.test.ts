import { describe, expect, it } from "vitest";
import { dayLabel } from "../src/format";
import { notificationLinks, statusNote } from "../src/pages/Notifications";

describe("notification centre", () => {
  it("groups by day in words", () => {
    const now = new Date(2026, 10, 16, 9, 0);
    expect(dayLabel(new Date(2026, 10, 16, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 15, 23, 55).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 12, 12, 0).toISOString(), now)).toBe("Thu 12 Nov");
  });

  it("says where a notification leads, and back to the task it came from", () => {
    expect(notificationLinks({ url: "/approvals/p1", data: {}, category: "approval" })).toEqual([{ label: "Review it", route: "approvals/p1" }]);
    expect(notificationLinks({ url: "/task/t1", data: { taskId: "t1" }, category: "agent" })).toEqual([{ label: "Open the conversation", route: "task/t1" }]);
    expect(notificationLinks({ url: "/brain/digests%2F2026-11-16.md", data: {}, category: "digest" })).toEqual([{ label: "Read the note", route: "brain/digests%2F2026-11-16.md" }]);
    // An agent's own message has no link of its own: it leads back to its conversation.
    expect(notificationLinks({ url: null, data: { taskId: "t9" }, category: "agent" })).toEqual([{ label: "Open the conversation", route: "task/t9" }]);
    expect(notificationLinks({ url: "/social", data: { taskId: "t9" }, category: "social" })).toEqual([
      { label: "Open", route: "social" },
      { label: "Open the conversation", route: "task/t9" },
    ]);
    expect(notificationLinks({ url: null, data: {}, category: "reminder" })).toEqual([]);
  });

  it("explains in words why something wasn't pushed", () => {
    expect(statusNote({ status: "sent" })).toBeNull();
    expect(statusNote({ status: "held" })).toMatch(/quiet hours/);
    expect(statusNote({ status: "batched" })).toMatch(/daily digest/);
    expect(statusNote({ status: "collapsed" })).toMatch(/one summary/);
  });
});
