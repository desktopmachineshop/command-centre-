import { describe, expect, it } from "vitest";
import { addDays, dayRange, dayStart, isDay, localDay } from "../src/days";

const LON = "Europe/London";

describe("local days", () => {
  it("uses the local date, not the UTC one", () => {
    expect(localDay(new Date("2026-06-30T23:30:00Z"), LON)).toBe("2026-07-01");
    expect(localDay(new Date("2026-12-31T23:30:00Z"), LON)).toBe("2026-12-31");
  });

  it("finds local midnight across DST changes", () => {
    expect(dayStart("2026-07-01", LON).toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(dayStart("2026-01-15", LON).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    // Clocks go back at 02:00 BST on 25 Oct 2026: a 25-hour day.
    const { start, end } = dayRange("2026-10-25", LON);
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    // Clocks go forward at 01:00 GMT on 29 Mar 2026: midnight is still GMT.
    expect(dayStart("2026-03-29", LON).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(dayStart("2026-03-30", LON).toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("does date arithmetic and validation", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isDay("2026-10-23")).toBe(true);
    expect(isDay("23/10/2026")).toBe(false);
  });
});
