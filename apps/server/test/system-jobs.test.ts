import { afterEach, describe, expect, it, vi } from "vitest";
import * as scheduler from "../src/scheduler";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

vi.mock("../src/scheduler", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/scheduler")>();
  return { ...m, startSchedules: vi.fn(m.startSchedules), startSystemJobs: vi.fn(m.startSystemJobs) };
});

/** Regression: SCHEDULES_ENABLED=false used to switch off the midnight rollover and the digest too. */
describe.skipIf(!DB_URL)("system jobs", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>> | undefined;
  afterEach(async () => {
    await ctx?.server.stop();
    vi.mocked(scheduler.startSchedules).mockClear();
    vi.mocked(scheduler.startSystemJobs).mockClear();
  });

  it("starts rollover and digest with vertical schedules off", async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { SCHEDULES_ENABLED: "false" } });
    expect(scheduler.startSchedules).not.toHaveBeenCalled();
    expect(scheduler.startSystemJobs).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/London", digestCron: "30 18 * * *" }));
    expect(vi.mocked(scheduler.startSystemJobs).mock.results[0]!.value).toHaveLength(5); // rollover, digest, social-scheduled (a no-op without accounts), pa-reminders, integrations-refresh
  });

  it("keeps the rollover but drops the digest with DIGEST_CRON=off", async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { SCHEDULES_ENABLED: "false", DIGEST_CRON: "off" } });
    expect(vi.mocked(scheduler.startSystemJobs).mock.results[0]!.value).toHaveLength(4); // rollover, social-scheduled, pa-reminders, integrations-refresh
  });
});
