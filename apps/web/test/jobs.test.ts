import { describe, expect, it } from "vitest";
import { waitingReason } from "../src/jobs";

const pc = (name: string, capabilities: string[], online = true) => ({ name, online, capabilities: capabilities as never });

describe("why a queued job is waiting", () => {
  const capture = { status: "queued" as const, requires: ["ffmpeg", "browser"] as never };

  it("names the missing capability on the closest online computer, and how to get it", () => {
    const reason = waitingReason(capture, [pc("Laptop", []), pc("Workshop PC", ["ffmpeg", "gpu"]), pc("Old PC", ["ffmpeg", "browser"], false)]);
    expect(reason).toContain("no online computer has browser (Workshop PC is missing it)");
    expect(reason).toContain("press Install under Media production");
    expect(reason).toContain("Or cancel it.");
  });

  it("lists every missing capability", () => {
    expect(waitingReason(capture, [pc("Laptop", ["gpu"])])).toContain("no online computer has ffmpeg and browser (Laptop is missing them)");
  });

  it("says when nothing is online, or a capable computer is busy", () => {
    expect(waitingReason(capture, [pc("PC", ["ffmpeg", "browser"], false)])).toMatch(/no computer is online/);
    expect(waitingReason(capture, [pc("PC", ["ffmpeg", "browser", "gpu"])])).toMatch(/finish its current job/);
  });

  it("has nothing to say about jobs that aren't queued", () => {
    expect(waitingReason({ ...capture, status: "running" as never }, [])).toBeNull();
  });
});

describe("a job for one computer", () => {
  const install = { status: "queued" as const, requires: [] as never, targetNodeId: "studio" };
  it("waits for that computer, not any other", () => {
    expect(waitingReason(install, [{ ...pc("Laptop", []), id: "laptop" }, { ...pc("Studio PC", [], false), id: "studio" }])).toBe(
      "Waiting for Studio PC to come online. Open the desktop app on it.",
    );
    expect(waitingReason(install, [{ ...pc("Studio PC", []), id: "studio" }])).toBe("Waiting for Studio PC to finish its current job.");
  });
});

describe("desktop app versions", async () => {
  const { newer } = await import("../src/pages/Devices");
  it("compares x.y.z numerically", () => {
    expect(newer("0.1.13", "0.1.12")).toBe(true);
    expect(newer("0.1.9", "0.1.10")).toBe(false);
    expect(newer("0.1.12", "0.1.12")).toBe(false);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
  });
});
