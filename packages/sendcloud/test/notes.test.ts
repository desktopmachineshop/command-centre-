import { describe, expect, it } from "vitest";
import { carrierName, parcelNote } from "../src/notes";

describe("delivery order notes", () => {
  it("names carriers", () => {
    expect(carrierName("royal_mail")).toBe("Royal Mail");
    expect(carrierName("inpost_uk")).toBe("Inpost UK");
    expect(carrierName(null)).toBeNull();
  });

  it("escapes what Sendcloud sends and only links http(s) tracking pages", () => {
    const html = parcelNote(
      { id: 1, carrier: { code: "dpd" }, status: { id: 8, message: "<b>Failed</b> & retrying" }, tracking_number: "X<1>", tracking_url: "javascript:alert(1)", date_updated: "06-11-2026 15:00:00" },
      "problem",
    );
    expect(html).toContain("Delivery problem</b>: &lt;b&gt;Failed&lt;/b&gt; &amp; retrying.");
    expect(html).toContain("Tracking: X&lt;1&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Updated Fri 6 Nov, 14:00");
  });

  it("says how long a stalled parcel has been quiet", () => {
    const html = parcelNote({ id: 1, carrier: { code: "evri" }, status: { message: "Sorted" } }, "stalled", { daysSinceUpdate: 6 });
    expect(html).toContain("⏳ <b>No tracking update for 6 days</b>: last status “Sorted”.");
    expect(html).toContain("Check with Evri");
  });
});
