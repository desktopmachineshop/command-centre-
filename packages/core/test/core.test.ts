import { describe, expect, it } from "vitest";
import { defineVertical, NewEvent, parseInbound, policyFor } from "../src";

describe("vertical manifests", () => {
  const v = defineVertical({
    id: "dms",
    name: "Desktop Machine Shop",
    description: "CNC retail",
    brainFolder: "dms",
    policies: { "brain.write": "auto" },
  });

  it("applies defaults", () => {
    expect(v.defaultPolicy).toBe("draft");
    expect(v.schedules).toEqual([]);
  });

  it("resolves per-action policy with fallback", () => {
    expect(policyFor(v, "brain.write")).toBe("auto");
    expect(policyFor(v, "email.send")).toBe("draft");
  });

  it("rejects bad ids", () => {
    expect(() => defineVertical({ id: "Bad Id", name: "x", description: "x", brainFolder: "x" })).toThrow();
  });
});

describe("events", () => {
  it("defaults payload", () => {
    const e = NewEvent.parse({ source: "chat", kind: "message", title: "hi" });
    expect(e.payload).toEqual({});
  });
});

describe("protocol", () => {
  it("parses a worker hello", () => {
    const msg = parseInbound(
      JSON.stringify({ type: "hello", role: "worker", token: "t", node: { id: "desk", name: "Desktop", capabilities: ["gpu"] } }),
    );
    expect(msg?.type).toBe("hello");
  });

  it("returns null on garbage", () => {
    expect(parseInbound("{nope")).toBeNull();
    expect(parseInbound(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});
