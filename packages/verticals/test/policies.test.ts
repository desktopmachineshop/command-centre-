import { policyFor, proposalPolicy } from "@cc/core";
import { describe, expect, it } from "vitest";
import { chiefOfStaff, INTERNAL_AUTO_POLICIES, verticals } from "../src";

const INTERNAL = ["pa.reminder.add", "pa.reminder.update", "pa.reminder.complete", "pa.reminder.cancel", "pa.items.add", "pa.item.complete", "notify"];
/** Customer-facing, financial and publishing actions: never auto in code, in any vertical. */
const OUTWARD = [
  "email.reply",
  "email.send",
  "odoo.message.post",
  "odoo.product.update_price",
  "odoo.blog.draft",
  "odoo.customer.create",
  "odoo.quote.create",
  "odoo.quote.send",
  "odoo.loyalty.create",
  "odoo.loyalty.archive",
  "social.post",
  "social.reply",
  "social.dm",
  "social.campaign",
  "calendar.create",
  "github.pr.merge",
  "video.produce",
  "video.revise",
  "video.rerender",
  "video.export",
  "video.archive",
  "odoo.record.create",
  "odoo.record.update",
  "odoo.record.archive",
  "odoo.record.unarchive",
  "odoo.record.action",
];

describe("action policies", () => {
  it("runs internal reminders, to-dos and chasers without approval in every vertical", () => {
    for (const v of verticals) {
      for (const type of INTERNAL) expect(policyFor(v, type), `${v.id} ${type}`).not.toBe("draft");
      expect(policyFor(v, "notify"), v.id).toBe("auto-with-digest");
      expect(policyFor(v, "pa.reminder.add"), v.id).toBe("auto");
    }
  });

  it("keeps customer-facing, financial and publishing actions waiting for Dave", () => {
    for (const v of verticals) {
      for (const type of OUTWARD) expect(policyFor(v, type), `${v.id} ${type}`).toBe("draft");
    }
    expect(Object.keys(INTERNAL_AUTO_POLICIES).filter((k) => OUTWARD.includes(k))).toEqual([]);
  });

  it("runs an internal Odoo note without approval, and makes every other Odoo write wait, whatever the policy says", () => {
    const dms = verticals.find((v) => v.id === "dms")!;
    expect(proposalPolicy(dms, "odoo.message.post", { model: "sale.order", id: 1, body: "x", internal: true })).toBe("auto-with-digest");
    // A message to the record's followers (the customer) still waits, however `internal` is spelled.
    for (const internal of [false, undefined, "true", 1]) {
      expect(proposalPolicy(dms, "odoo.message.post", { model: "sale.order", id: 1, body: "x", internal }), String(internal)).toBe("draft");
    }
    // Without its own policy, an internal note waits like any other Odoo write.
    expect(proposalPolicy({ ...dms, policies: {} }, "odoo.message.post", { internal: true })).toBe("draft");
    const loose = { ...dms, defaultPolicy: "auto" as const, policies: { "odoo.invoice.post": "auto" as const, "odoo.message.post": "auto" as const } };
    for (const type of ["odoo.invoice.post", "odoo.message.post", "odoo.order.confirm", "odoo.anything", "odoo.record.create", "odoo.record.update", "odoo.record.archive", "odoo.record.action"]) {
      expect(proposalPolicy(loose, type, {}), type).toBe("draft");
    }
    // Other actions keep the business's policy.
    expect(proposalPolicy(loose, "pa.reminder.add", {})).toBe("auto");
  });
});

describe("briefings", () => {
  it("turns the morning brief on, at the end of quiet hours, without mail", () => {
    const brief = chiefOfStaff.schedules.find((s) => s.id === "morning-brief")!;
    expect(brief).toMatchObject({ cron: "0 7 * * 1-5", timezone: "Europe/London", enabled: true });
    expect(brief.prompt).toContain('category "briefing"');
    expect(brief.prompt).toContain("do not use the mail tools");
  });

  it("leaves the evening wrap off", () => {
    const wrap = verticals.flatMap((v) => v.schedules).find((s) => s.id === "evening-wrap")!;
    expect(wrap.enabled).toBe(false);
  });
});
