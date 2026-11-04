import type { Proposal } from "@cc/core";
import { describe, expect, it } from "vitest";
import { approvalUnits } from "../src/pages/Approvals";

const p = (id: string, batchId: string | null = null): Proposal => ({
  id,
  taskId: "t1",
  batchId,
  batchSummary: batchId ? "Delivery updates" : null,
  vertical: "dms",
  actionType: "odoo.message.post",
  summary: id,
  payload: {},
  policy: "draft",
  status: "pending",
  createdAt: "2026-11-04T10:00:00Z",
  decidedAt: null,
  result: null,
});

describe("Approvals page cards", () => {
  it("shows a batch as one card with its items oldest first, at its newest item's place", () => {
    // Newest first, as the API returns them.
    const units = approvalUnits([p("single-new"), p("b3", "b"), p("b2", "b"), p("single-old"), p("b1", "b")]);
    expect(units.map((u) => u.map((x) => x.id))).toEqual([["single-new"], ["b1", "b2", "b3"], ["single-old"]]);
  });
});
