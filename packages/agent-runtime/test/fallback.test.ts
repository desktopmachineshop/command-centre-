import { describe, expect, it } from "vitest";
import { fallbackChain, isUsageLimit, limitResetAt, ScriptedRunner } from "../src";

const failed = (error: string) => ({ status: "failed" as const, result: null, error, costUsd: null, sessionId: null });

describe("isUsageLimit", () => {
  it("recognises each provider's wording of a limit", () => {
    for (const error of [
      "You've hit your 5-hour limit · resets 10pm (UTC)",
      "You've hit your weekly limit · resets Mon 9am (Europe/London)",
      "Claude AI usage limit reached|1764021600",
      "You've hit your usage limit. Upgrade to Pro or try again later.",
      "429 rate limit exceeded",
      "Resource has been exhausted (e.g. check quota).",
      "Overloaded",
    ])
      expect(isUsageLimit(failed(error)), error).toBe(true);
  });

  it("doesn't take other failures for a limit", () => {
    for (const error of ["Timed out after 900000ms", "Failed to start claude: ENOENT", "something broke"]) expect(isUsageLimit(failed(error)), error).toBe(false);
    expect(isUsageLimit({ ...failed("usage limit reached"), status: "succeeded" })).toBe(false);
  });
});

describe("limitResetAt", () => {
  const now = new Date("2026-11-23T15:20:00Z");

  it("reads the reset time, today or tomorrow", () => {
    expect(limitResetAt("You've hit your 5-hour limit · resets 10pm (UTC)", now)?.toISOString()).toBe("2026-11-23T22:00:00.000Z");
    expect(limitResetAt("resets at 3:30am (UTC)", now)?.toISOString()).toBe("2026-11-24T03:30:00.000Z");
    expect(limitResetAt("resets 12am (UTC)", now)?.toISOString()).toBe("2026-11-24T00:00:00.000Z");
    expect(limitResetAt("resets at 03:00", now)?.toISOString()).toBe("2026-11-24T03:00:00.000Z");
  });

  it("uses the time zone the limit names", () => {
    // London is on GMT in November and BST (UTC+1) in July.
    expect(limitResetAt("resets 10pm (Europe/London)", now)?.toISOString()).toBe("2026-11-23T22:00:00.000Z");
    expect(limitResetAt("resets 10pm (Europe/London)", new Date("2026-07-01T12:00:00Z"))?.toISOString()).toBe("2026-07-01T21:00:00.000Z");
    expect(limitResetAt("resets 9am (America/New_York)", now)?.toISOString()).toBe("2026-11-24T14:00:00.000Z");
    expect(limitResetAt("resets 10pm (Nowhere/Special)", now)?.toISOString()).toBe("2026-11-23T22:00:00.000Z");
  });

  it("is null when no reset time is given", () => {
    expect(limitResetAt("Claude AI usage limit reached", now)).toBeNull();
    expect(limitResetAt("resets 13pm", now)).toBeNull();
  });
});

describe("a route at Claude's 5-hour limit", () => {
  it("hands the task to the backup agent, even after tools were used", async () => {
    const claude = new ScriptedRunner("claude", () => ({
      messages: [{ type: "tool_use", name: "mcp__brain__search", input: {} }],
      result: failed("You've hit your 5-hour limit · resets 10pm (UTC)"),
    }));
    const backup = new ScriptedRunner("gemini");
    const result = await fallbackChain([claude, backup]).run({ prompt: "reply to the customer" });
    expect(result.status).toBe("succeeded");
    expect(backup.calls).toHaveLength(1);
  });
});
