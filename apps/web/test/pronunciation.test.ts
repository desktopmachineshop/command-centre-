import { afterEach, describe, expect, it } from "vitest";
import { pronounce, refreshPronunciation, setPronunciation, setPronunciationSource } from "../src/voice/pronunciation";

afterEach(() => {
  setPronunciationSource(null);
  setPronunciation([]);
});

describe("browser pronunciation", () => {
  it("says terms the list's way and leaves other text alone", () => {
    setPronunciation([["EtherCAT", "ether-cat"], ["CANopen", "can-open"]]);
    expect(pronounce("EtherCAT and CANopen, not ethercat")).toBe("ether-cat and can-open, not ethercat");
  });

  it("loads from the source, at most once a minute", async () => {
    let calls = 0;
    setPronunciationSource(async () => (calls++, [["EtherCAT", "ether-cat"]]));
    await refreshPronunciation(1_000_000);
    await refreshPronunciation(1_030_000);
    expect(calls).toBe(1);
    expect(pronounce("EtherCAT")).toBe("ether-cat");
    await refreshPronunciation(1_100_000);
    expect(calls).toBe(2);
  });

  it("keeps the last list when loading fails", async () => {
    setPronunciation([["EtherCAT", "ether-cat"]]);
    setPronunciationSource(async () => {
      throw new Error("offline");
    });
    await refreshPronunciation(5_000_000);
    expect(pronounce("EtherCAT")).toBe("ether-cat");
  });
});
