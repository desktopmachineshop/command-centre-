import { describe, expect, it } from "vitest";
import {
  describeRecurrence,
  firstOccurrence,
  formatRecurrence,
  formatUk,
  nextOccurrence,
  parseInstant,
  parseRecurrence,
  RecurrenceError,
  resolveReminder,
  zonedToUtc,
} from "../src";

const TZ = "Europe/London";

describe("Europe/London wall-clock times", () => {
  it("converts local times in GMT and BST", () => {
    expect(zonedToUtc("2026-07-01", "09:00", TZ).toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedToUtc("2026-12-01", "09:00", TZ).toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });

  it("moves a time skipped by the spring change forward, and takes the first of a repeated autumn time", () => {
    // 29 Mar 2026: 01:00 GMT jumps to 02:00 BST, so 01:30 doesn't exist.
    expect(zonedToUtc("2026-03-29", "01:30", TZ).toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
    // 25 Oct 2026: 01:30 happens twice (BST, then GMT); the first is 00:30Z.
    expect(zonedToUtc("2026-10-25", "01:30", TZ).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("parses local and offset date-times", () => {
    expect(parseInstant("2026-10-30T10:00", TZ).toISOString()).toBe("2026-10-30T10:00:00.000Z");
    expect(parseInstant("2026-10-23 14:30", TZ).toISOString()).toBe("2026-10-23T13:30:00.000Z");
    expect(parseInstant("2026-10-23T14:30:00+01:00", TZ).toISOString()).toBe("2026-10-23T13:30:00.000Z");
    expect(() => parseInstant("next tuesday", TZ)).toThrow(/YYYY-MM-DDTHH:MM/);
  });

  it("formats UK style", () => {
    expect(formatUk(new Date("2026-10-23T13:30:00Z"), TZ)).toBe("Fri 23 Oct, 14:30");
  });
});

describe("recurrence", () => {
  it("parses shorthands and the RRULE subset", () => {
    expect(formatRecurrence(parseRecurrence("daily"))).toBe("FREQ=DAILY");
    expect(formatRecurrence(parseRecurrence("weekdays"))).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(formatRecurrence(parseRecurrence("weekly: thu, mon"))).toBe("FREQ=WEEKLY;BYDAY=MO,TH");
    expect(formatRecurrence(parseRecurrence("RRULE:FREQ=WEEKLY;BYDAY=SA"))).toBe("FREQ=WEEKLY;BYDAY=SA");
    expect(formatRecurrence(parseRecurrence("monthly:15"))).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    expect(formatRecurrence(parseRecurrence("FREQ=DAILY;INTERVAL=1"))).toBe("FREQ=DAILY");
    expect(describeRecurrence(parseRecurrence("weekdays"))).toBe("weekdays");
    expect(describeRecurrence(parseRecurrence("monthly:2"))).toBe("monthly on the 2nd");
  });

  it("rejects what it can't do", () => {
    for (const bad of ["FREQ=YEARLY", "FREQ=DAILY;INTERVAL=2", "FREQ=WEEKLY", "weekly:funday", "monthly:32", "FREQ=MONTHLY;BYDAY=1MO"]) {
      expect(() => parseRecurrence(bad), bad).toThrow(RecurrenceError);
    }
  });

  it("keeps 09:00 local across the autumn DST change", () => {
    const daily = parseRecurrence("daily");
    const sat = new Date("2026-10-24T08:00:00Z"); // Sat 09:00 BST
    const sun = nextOccurrence(daily, sat, "09:00", TZ);
    expect(sun.toISOString()).toBe("2026-10-25T09:00:00.000Z"); // Sun 09:00 GMT
    expect(nextOccurrence(daily, sun, "09:00", TZ).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("keeps 09:00 local across the spring DST change", () => {
    const daily = parseRecurrence("daily");
    const sat = new Date("2026-03-28T09:00:00Z"); // Sat 09:00 GMT
    expect(nextOccurrence(daily, sat, "09:00", TZ).toISOString()).toBe("2026-03-29T08:00:00.000Z"); // Sun 09:00 BST
  });

  it("handles a time that doesn't exist on the spring-change day without drifting after it", () => {
    const daily = parseRecurrence("daily");
    const skipped = nextOccurrence(daily, new Date("2026-03-28T01:30:00Z"), "01:30", TZ);
    expect(skipped.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST that day
    expect(nextOccurrence(daily, skipped, "01:30", TZ).toISOString()).toBe("2026-03-30T00:30:00.000Z"); // back to 01:30 BST
  });

  it("walks weekdays over the weekend and weekly days", () => {
    const fri = new Date("2026-10-23T07:00:00Z"); // Fri 08:00 BST
    expect(nextOccurrence(parseRecurrence("weekdays"), fri, "08:00", TZ).toISOString()).toBe("2026-10-26T08:00:00.000Z"); // Mon 08:00 GMT
    expect(nextOccurrence(parseRecurrence("weekly:sun"), fri, "18:00", TZ).toISOString()).toBe("2026-10-25T18:00:00.000Z");
  });

  it("puts monthly-on-the-31st on the last day of shorter months", () => {
    const m = parseRecurrence("monthly:31");
    expect(nextOccurrence(m, new Date("2026-10-31T12:00:00Z"), "10:00", TZ).toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(nextOccurrence(m, new Date("2027-01-31T12:00:00Z"), "10:00", TZ).toISOString()).toBe("2027-02-28T10:00:00.000Z");
  });

  it("starts a recurring reminder on its first matching day, never in the past", () => {
    const now = new Date("2026-10-24T10:00:00Z"); // Saturday
    const r = resolveReminder({ text: "Bins out", due: "2026-10-24T19:00", recurrence: "weekly:tue" }, TZ, now);
    expect(r.dueAt.toISOString()).toBe("2026-10-27T19:00:00.000Z");
    expect(r.localTime).toBe("19:00");
    expect(firstOccurrence(parseRecurrence("daily"), new Date("2026-10-24T18:00:00Z"), "19:00", TZ).toISOString()).toBe("2026-10-24T18:00:00.000Z");
  });
});
