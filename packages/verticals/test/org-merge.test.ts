import { Role, type VerticalOrgEdit } from "@cc/core";
import { describe, expect, it } from "vitest";
import { mergeOrgEdit } from "../src";

const role = (over: Partial<Role> & { id: string }): Role =>
  Role.parse({ title: over.id, mission: "Does things.", reportsTo: "chief-of-staff", ...over });
const edit = (roles: Role[], policies: VerticalOrgEdit["policies"] = {}): VerticalOrgEdit => ({ roles, policies, defaultPolicy: "draft" });
const schedule = (id: string) => ({ id, cron: "0 9 * * *", timezone: "Europe/London", prompt: id, enabled: true });

describe("mergeOrgEdit: an Org-page save brought up to date with the code", () => {
  // The code when Dave saved, Dave's save (mission reworded, notify dropped), and the code since.
  const then = edit([role({ id: "lead", actions: ["notify", "github.pr.create"], mcpServers: ["brain"], skills: ["brain-notes"] })], { notify: "auto" });
  const saved = edit([role({ id: "lead", mission: "Dave's words.", actions: ["github.pr.create"], mcpServers: ["brain"], skills: ["brain-notes"] })], {});
  const now = edit(
    [
      role({
        id: "lead",
        actions: ["notify", "github.pr.create", "github.issue.create"],
        mcpServers: ["brain", "github", "ops"],
        skills: ["brain-notes", "software-lead"],
        schedules: [schedule("file-issues")],
        tools: ["Bash", "Read"],
        repo: "o/r",
        maxTurns: 200,
      }),
    ],
    { notify: "auto", "github.issue.create": "auto" },
  );

  it("adds what the code added since the save, and keeps what Dave removed removed", () => {
    const merged = mergeOrgEdit(saved, now, then);
    const lead = merged.roles[0]!;
    expect(lead.mission).toBe("Dave's words.");
    expect(lead.actions).toEqual(["github.pr.create", "github.issue.create"]); // notify stays dropped
    expect(lead.mcpServers).toEqual(["brain", "github", "ops"]);
    expect(lead.skills).toEqual(["brain-notes", "software-lead"]);
    expect(lead.schedules.map((s) => s.id)).toEqual(["file-issues"]);
    expect(lead).toMatchObject({ tools: ["Bash", "Read"], repo: "o/r", maxTurns: 200 });
    expect(merged.policies).toEqual({ "github.issue.create": "auto" }); // notify's policy stays dropped
  });

  it("keeps Dave's edit of a schedule the code also has, and never duplicates a schedule id", () => {
    const mine = { ...schedule("file-issues"), cron: "0 7 * * *", enabled: false };
    const merged = mergeOrgEdit(edit([role({ id: "lead", schedules: [mine] })]), now, then);
    expect(merged.roles[0]!.schedules).toEqual([mine]);
    // A schedule Dave removed after the code had it stays removed.
    const removed = mergeOrgEdit(edit([role({ id: "lead" })]), now, edit([role({ id: "lead", schedules: [schedule("file-issues")] })]));
    expect(removed.roles[0]!.schedules).toEqual([]);
  });

  it("without a record of the code at save time, takes everything the save lacks", () => {
    const merged = mergeOrgEdit(saved, now, null);
    expect(merged.roles[0]!.actions).toEqual(["github.pr.create", "notify", "github.issue.create"]);
    expect(merged.policies).toEqual({ notify: "auto", "github.issue.create": "auto" });
  });

  it("keeps specialists Dave added (reporting to the assistant), and a role on all servers on all of them", () => {
    const merged = mergeOrgEdit(edit([role({ id: "lead" }), role({ id: "helper", reportsTo: "lead", actions: ["notify"] })]), now, then);
    expect(merged.roles[0]!.mcpServers).toBeUndefined();
    expect(merged.roles[1]).toEqual(role({ id: "helper", actions: ["notify"] }));
  });

  it("drops the old org chart's roles from a saved edit", () => {
    const merged = mergeOrgEdit(edit([role({ id: "shop-lead" }), role({ id: "customer-support", reportsTo: "shop-lead" }), role({ id: "lead" })]), now, then);
    expect(merged.roles.map((r) => r.id)).toEqual(["lead"]);
  });
});
