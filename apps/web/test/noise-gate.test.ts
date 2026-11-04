import { describe, expect, it } from "vitest";
import { speechThreshold, updateNoiseFloor } from "../src/voice/level";

describe("noise gate", () => {
  it("never goes below the minimum threshold", () => {
    expect(speechThreshold(0)).toBe(0.02);
  });
  it("rises above steady background noise", () => {
    expect(speechThreshold(0.03)).toBeCloseTo(0.09);
  });
  it("tracks the noise floor slowly", () => {
    let f = 0;
    for (let i = 0; i < 100; i++) f = updateNoiseFloor(f, 0.01);
    expect(f).toBeCloseTo(0.01, 3);
    expect(updateNoiseFloor(0, 0.01)).toBeCloseTo(0.0005);
  });
});
