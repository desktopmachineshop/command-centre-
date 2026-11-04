import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

describe.skipIf(!DB_URL)("the brain's central issue log (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new McpCallingRunner([]);

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());

  it("writes the issues README at start-up and moves issue notes from other folders, journalling the move", async () => {
    const brain = ctx.server.brain;
    expect((await brain.read("issues/README.md"))?.body).toContain("# Issues");
    await brain.write("dms/bugs/label-printer.md", { frontmatter: { type: "bug", agent: "dms-ops" }, body: "# Label printer prints blank labels" });
    await brain.write("dms/playbooks/printing.md", { frontmatter: { type: "playbook" }, body: "# Printing\n\nIf there's a bug, reprint." });

    const moved = await ctx.server.issuesAudit();
    expect(moved).toEqual([{ from: "dms/bugs/label-printer.md", to: expect.stringMatching(/^issues\/\d{4}-\d{2}-\d{2}-label-printer\.md$/) }]);
    expect(await brain.read("dms/bugs/label-printer.md")).toBeNull();
    expect((await brain.read(moved[0]!.to))?.frontmatter).toMatchObject({ type: "issue", agent: "dms-ops", vertical: "dms", needs_triage: true, moved_from: "dms/bugs/label-printer.md" });
    expect(await brain.read("dms/playbooks/printing.md")).not.toBeNull();
    const journal = await brain.read(`journal/${new Date().toISOString().slice(0, 10)}.md`);
    expect(journal?.body).toContain("Issues audit moved 1 note(s) into issues/: dms/bugs/label-printer.md");
    expect(await ctx.server.issuesAudit()).toEqual([]);
  });

  it("refuses a brain.write proposal that puts an issue outside the log", async () => {
    await expect(
      ctx.server.actions.propose({ vertical: "dms", actionType: "brain.write", summary: "x", payload: { path: "dms/bugs/x.md", body: "# x" } }),
    ).rejects.toThrow(/central issue log/);
  });
});
