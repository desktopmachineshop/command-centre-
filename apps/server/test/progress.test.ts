import { afterEach, describe, expect, it, vi } from "vitest";
import { startProgressUpdates } from "../src/progress";

afterEach(() => vi.useRealTimers());

const setup = (intervalMs = 1000) => {
  const notify = vi.fn().mockResolvedValue(undefined);
  const p = startProgressUpdates({ notifier: { publicKey: null, notify }, intervalMs, title: "Fix it", url: "/task/t1", vertical: "cc", tag: "progress-t1" });
  return { notify, p };
};

describe("progress updates", () => {
  it("stays silent for short runs", () => {
    vi.useFakeTimers();
    const { notify, p } = setup();
    p.note({ type: "text", text: "hi" });
    vi.advanceTimersByTime(900);
    p.stop();
    vi.advanceTimersByTime(5000);
    expect(notify).not.toHaveBeenCalled();
  });

  it("pushes the latest activity once per interval and skips repeats", () => {
    vi.useFakeTimers();
    const { notify, p } = setup();
    p.note({ type: "tool_use", name: "mcp__brain__search", input: {} });
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ category: "agent", priority: "low", tag: "progress-t1", body: "Working: brain search" });
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    p.note({ type: "text", text: "Running the tests\nmore" });
    vi.advanceTimersByTime(1000);
    expect(notify.mock.calls[1]![0].body).toBe("Running the tests");
    p.stop();
  });

  it("does nothing when disabled", () => {
    const { notify, p } = setup(0);
    p.stop();
    expect(notify).not.toHaveBeenCalled();
  });
});
