import { describe, expect, it } from "vitest";
import { CHAT_RESET_IDLE_MS, chatExpired } from "../src/chat-store";

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
