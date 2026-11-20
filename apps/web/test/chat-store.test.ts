import { describe, expect, it } from "vitest";
import { CHAT_RESET_IDLE_MS, chatExpired, proposalsByTurn } from "../src/chat-store";

/** A time on this device's clock: day of November 2026, hour, minute. */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

describe("chatExpired: the chat lasts all day, and resets after two quiet hours past midnight", () => {
  it("keeps it all day, however long it sits", () => {
    expect(chatExpired(at(5, 8), at(5, 23, 59))).toBe(false);
    expect(chatExpired(at(5, 0, 1), at(5, 23))).toBe(false);
  });

  it("keeps a chat carried on past midnight until it has been quiet for two hours", () => {
    expect(chatExpired(at(4, 23, 30), at(5, 0, 30))).toBe(false);
    expect(chatExpired(at(4, 23, 30), at(5, 1, 29))).toBe(false);
    expect(chatExpired(at(4, 23, 30), at(5, 1, 30))).toBe(true);
  });

  it("starts fresh the next day, or later", () => {
    expect(chatExpired(at(4, 18), at(5, 7))).toBe(true);
    expect(chatExpired(at(1, 12), at(5, 12))).toBe(true);
  });

  it("is two hours", () => {
    expect(CHAT_RESET_IDLE_MS).toBe(2 * 60 * 60_000);
  });
});

describe("proposalsByTurn: a card stays on the turn it was made during", () => {
  const turns = [{ at: "2026-11-20T10:00:00Z" }, { at: "2026-11-20T10:05:00Z" }];
  it("keeps an earlier failed card above a later message", () => {
    const old = { id: "a", createdAt: "2026-11-20T10:02:00Z" };
    const fresh = { id: "b", createdAt: "2026-11-20T10:06:00Z" };
    expect(proposalsByTurn(turns, [fresh, old])).toEqual([[old], [fresh]]);
  });
  it("puts anything from before the first turn on the first", () => {
    const early = { id: "c", createdAt: "2026-11-20T09:59:59Z" };
    expect(proposalsByTurn(turns, [early])).toEqual([[early], []]);
  });
});
