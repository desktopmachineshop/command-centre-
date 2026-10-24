import { defineVertical, type Event } from "@cc/core";
import { describe, expect, it } from "vitest";
import { ChainTriager, RulesTriager, type Triager } from "../src";

const context = {
  verticals: [
    defineVertical({ id: "personal", name: "Personal", description: "", brainFolder: "personal" }),
    defineVertical({ id: "dms", name: "Desktop Machine Shop", description: "", brainFolder: "dms" }),
    defineVertical({ id: "3dpandme", name: "3dpandme", description: "", brainFolder: "3dpandme" }),
  ],
  defaultVertical: "personal",
};

const odoo = (kind: string, payload: Record<string, unknown> = {}, vertical: string | null = "dms"): Event => ({
  id: "e1",
  source: "odoo",
  vertical,
  kind,
  title: kind,
  payload,
  dedupeKey: null,
  receivedAt: new Date().toISOString(),
});

describe("RulesTriager on Odoo events", () => {
  const rules = new RulesTriager();

  it.each([
    ["order.created", "new-order", "file"],
    ["message.received", "customer-message", "agent"],
    ["stock.low", "stock-low", "agent"],
    ["delivery.late", "delivery-late", "agent"],
    ["review.received", "review", "agent"],
  ])("%s → intent %s, route %s, without a model", async (kind, intent, route) => {
    expect(await rules.triage(odoo(kind), context)).toMatchObject({ vertical: "dms", intent, route, confidence: 1, triager: "rules" });
  });

  it("hands a flagged order (e.g. over the big-order threshold) to an agent", async () => {
    const r = await rules.triage(odoo("order.created", { attention: ["large order (1250.00 ≥ 500 threshold)"] }), context);
    expect(r).toMatchObject({ intent: "new-order", route: "agent", urgency: 0.6 });
    expect(r?.notes).toContain("large order");
  });

  it("treats a poor review as more urgent", async () => {
    expect((await rules.triage(odoo("review.received", { rating: 1 }), context))?.urgency).toBe(0.7);
    expect((await rules.triage(odoo("review.received", { rating: 5 }), context))?.urgency).toBe(0.4);
  });

  it("keeps the vertical the poller mapped, and falls back to dms rather than the default vertical", async () => {
    expect((await rules.triage(odoo("order.created", {}, "3dpandme"), context))?.vertical).toBe("3dpandme");
    expect((await rules.triage(odoo("stock.low", {}, null), context))?.vertical).toBe("dms");
    expect((await rules.triage(odoo("stock.low", {}, "nope"), context))?.vertical).toBe("dms");
  });

  it("leaves unknown Odoo kinds to the generic known-vertical rule", async () => {
    expect(await rules.triage(odoo("invoice.paid"), context)).toMatchObject({ intent: "other", confidence: 0.5 });
  });

  it("wins the chain, so no model triager is called", async () => {
    let called = false;
    const model: Triager = { name: "model", triage: async () => ((called = true), null) };
    const r = await new ChainTriager([rules, model], 0.7).triage(odoo("delivery.late"), context);
    expect(r?.intent).toBe("delivery-late");
    expect(called).toBe(false);
  });
});
