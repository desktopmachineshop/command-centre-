import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoHandover, cleanHandover, HANDOVER_MAX, handoverSection } from "../src/handover";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

describe("handover notes (unit)", () => {
  it("records a run's outcome under Last run, replacing the previous one", () => {
    const first = autoHandover(null, { prompt: "Quote 50 ER11 collets for Acme" }, { status: "succeeded", result: "Drafted the quote.", error: null }, new Date("2026-11-07T09:00:00Z"));
    expect(first).toMatch(/^## Goal\nQuote 50 ER11 collets for Acme\n\n## Last run \(2026-11-07 09:00 UTC/);
    expect(first).toContain("Drafted the quote.");
    const second = autoHandover(first, { prompt: "ignored" }, { status: "failed", result: null, error: "Timed out" });
    expect(second.match(/## Last run/g)).toHaveLength(1);
    expect(second).toContain("Error: Timed out");
    expect(second).not.toContain("Drafted the quote.");
  });

  it("keeps a note within its limit, and says when there is none yet", () => {
    expect(cleanHandover("x".repeat(HANDOVER_MAX + 500)).length).toBeLessThanOrEqual(HANDOVER_MAX);
    expect(handoverSection(null)).toContain("no note yet");
    expect(handoverSection("## Goal\nfoo")).toContain("<<<\n## Goal\nfoo\n>>>");
  });
});

describe.skipIf(!DB_URL)("handover notes (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new McpCallingRunner([]);
  const calls = (runner as unknown as { calls: { server: string; tool: string; args: Record<string, unknown> }[] }).calls;
  const detail = async (id: string) => (await ctx.api(`/api/tasks/${id}`)).body;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    calls.length = 0;
    runner.requests.length = 0;
  });

  it("starts empty, and the server records a run that didn't write one", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } });
    await ctx.queue.drain();
    expect(runner.requests[0]!.systemPrompt).toContain("This task has no note yet");
    const { handover } = await detail(body.task.id);
    expect(handover.text).toMatch(/^## Goal\ndms: what sold yesterday\?\n\n## Last run .*\nOutcome: succeeded\./);
  });

  it("keeps the note the agent writes, and gives it to the next run and to a handoff", async () => {
    const note = "## Goal\nQuote Acme 50 collets\n\n## Open\nWaiting on Dave's price\n\n## References\nS00042";
    calls.push({ server: "actions", tool: "update_handover", args: { note } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: quote Acme 50 collets" } });
    await ctx.queue.drain();
    expect((await detail(body.task.id)).handover.text).toBe(note); // no "Last run" added: the agent wrote it

    // A follow-up's run (any runner) starts from it.
    calls.length = 0;
    await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "£4.20 each" } });
    await ctx.queue.drain();
    expect(runner.requests.at(-1)!.systemPrompt).toContain(`The current note:\n<<<\n${note}\n>>>`);

    // Work handed on carries it too.
    const { task } = await ctx.server.pipeline.handoff(body.task.id, "3dpandme/blog-writer", "Write up the quote");
    expect(task.prompt).toContain("Where their task had got to (its handover note):");
    expect(task.prompt).toContain("Waiting on Dave's price");
    await ctx.queue.drain();
  });
});
