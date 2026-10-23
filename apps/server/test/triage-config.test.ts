import type { Triager } from "@cc/triage";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createTriager } from "../src/triage";

const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "admin-token-for-tests-0123456789" };
const names = (t: Triager) => (t as unknown as { triagers: Triager[] }).triagers.map((x) => x.name);

describe("triage config", () => {
  it("is rules-only with a 0.7 threshold by default", () => {
    const config = loadConfig({ ...base, TRIAGE_MIN_CONFIDENCE: "" });
    expect(config.triage).toEqual({ minConfidence: 0.7 });
    expect(names(createTriager(config))).toEqual(["rules"]);
  });

  it("adds Jev and Haiku when their keys are set", () => {
    const config = loadConfig({
      ...base,
      JEV_API_KEY: "jev-key",
      JEV_BASE_URL: "http://litellm:4000/typesafe",
      ANTHROPIC_TRIAGE_API_KEY: "sk-ant-test",
      TRIAGE_MIN_CONFIDENCE: "0.8",
    });
    expect(config.triage).toMatchObject({ jevApiKey: "jev-key", jevBaseUrl: "http://litellm:4000/typesafe", minConfidence: 0.8 });
    const triager = createTriager(config);
    expect(names(triager)).toEqual(["rules", "jev", "haiku"]);
    expect((triager as unknown as { minConfidence: number }).minConfidence).toBe(0.8);
  });

  it("rejects an out-of-range threshold", () => {
    expect(() => loadConfig({ ...base, TRIAGE_MIN_CONFIDENCE: "7" })).toThrow(/TRIAGE_MIN_CONFIDENCE/);
  });
});
