import { defineVertical, type Event, type TriageResult } from "@cc/core";
import { describe, expect, it } from "vitest";
import { ChainTriager, RulesTriager, type Triager } from "../src";

const context = {
  verticals: [
    defineVertical({ id: "personal", name: "Personal", description: "", brainFolder: "personal" }),
    defineVertical({ id: "dms", name: "Desktop Machine Shop", description: "", brainFolder: "dms" }),
  ],
  defaultVertical: "personal",
};

const event = (over: Partial<Event>): Event => ({
  id: "e1",
  source: "chat",
  vertical: null,
  kind: "message",
  title: "hello",
  payload: {},
  dedupeKey: null,
  receivedAt: new Date().toISOString(),
  ...over,
});

describe("RulesTriager", () => {
  const rules = new RulesTriager();

  it("routes chat to the agent in the default vertical", async () => {
    expect(await rules.triage(event({}), context)).toMatchObject({ vertical: "personal", route: "agent", confidence: 1 });
  });

  it("routes a handoff between org roles to the agent with full confidence", async () => {
    const r = await rules.triage(event({ source: "system", kind: "handoff", vertical: "dms", payload: { role: "ops-admin" } }), context);
    expect(r).toMatchObject({ vertical: "dms", intent: "handoff", route: "agent", confidence: 1 });
  });

  it("picks up a vertical mentioned in chat", async () => {
    const r1 = await rules.triage(event({ title: "dms: check stock of ER11" }), context);
    const r2 = await rules.triage(event({ title: "anything new at desktop machine shop?" }), context);
    expect(r1?.vertical).toBe("dms");
    expect(r2?.vertical).toBe("dms");
  });

  it("does not match vertical ids inside other words", async () => {
    expect((await rules.triage(event({ title: "admsomething" }), context))?.vertical).toBe("personal");
  });

  it("routes cron events to their vertical", async () => {
    expect(await rules.triage(event({ source: "cron", vertical: "dms" }), context)).toMatchObject({ vertical: "dms", intent: "scheduled" });
  });

  it("gives up on unknown webhooks", async () => {
    expect(await rules.triage(event({ source: "webhook" }), context)).toBeNull();
  });
});

describe("ChainTriager", () => {
  const fixed = (name: string, confidence: number): Triager => ({
    name,
    triage: async (): Promise<TriageResult> => ({ vertical: "dms", intent: name, urgency: 0, route: "agent", confidence, triager: name }),
  });

  it("returns the first confident result", async () => {
    const r = await new ChainTriager([fixed("low", 0.4), fixed("high", 0.9), fixed("later", 1)]).triage(event({}), context);
    expect(r?.intent).toBe("high");
  });

  it("falls back to the most confident result", async () => {
    const r = await new ChainTriager([fixed("a", 0.4), fixed("b", 0.6)]).triage(event({}), context);
    expect(r?.intent).toBe("b");
  });

  it("skips triagers that throw", async () => {
    const broken: Triager = { name: "broken", triage: async () => { throw new Error("down"); } };
    expect((await new ChainTriager([broken, fixed("ok", 1)]).triage(event({}), context))?.intent).toBe("ok");
  });
});
