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
  it("learns steady noise louder than the starting threshold (a car), so pauses still end the turn", () => {
    const engine = 0.05; // louder than the 0.02 minimum: every frame starts out as "speech"
    let floor = 0;
    let ticks = 0;
    while (engine > speechThreshold(floor) && ticks < 1000) {
      floor = updateNoiseFloor(floor, engine, true);
      ticks++;
    }
    expect(ticks).toBeLessThan(60); // under 6 s at the recorder's 100 ms tick
    expect(engine).toBeLessThanOrEqual(speechThreshold(floor));
    // Speech well above the engine still counts.
    expect(0.3).toBeGreaterThan(speechThreshold(floor));
  });
});
