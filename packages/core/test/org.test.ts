import { describe, expect, it } from "vitest";
import { defineOrgRoot, defineVertical, findRole, orgIssues, type RoleInput, roleMcpServers, rolesOf, schedulesOf, type VerticalManifestInput } from "../src";

const role = (id: string, extra: Partial<RoleInput> = {}): RoleInput => ({ id, title: id, mission: `${id} mission.`, ...extra });

const base: VerticalManifestInput = {
  id: "shop",
  name: "Shop",
  description: "A shop.",
  brainFolder: "shop",
  intents: ["order-status", "supplier", "spam"],
  mcpServers: ["brain", "odoo"],
};

const issuesFor = (roles: RoleInput[], extra: Partial<VerticalManifestInput> = {}) => {
  try {
    defineVertical({ ...base, ...extra, roles });
    return [];
  } catch (err) {
    return (err as { issues: { message: string }[] }).issues.map((i) => i.message);
  }
};

describe("specialist validation", () => {
  it("accepts several specialists, each reporting to the assistant", () => {
    const v = defineVertical({ ...base, roles: [role("video"), role("blog")] });
    expect(rolesOf(v).map((r) => r.id)).toEqual(["video", "blog"]);
    expect(rolesOf(v).every((r) => r.reportsTo === "chief-of-staff")).toBe(true);
    expect(orgIssues(v)).toEqual([]);
  });

  it("rejects duplicate ids and the reserved root id", () => {
    expect(issuesFor([role("video"), role("video")])).toContain('shop: duplicate role id "video"');
    expect(issuesFor([role("chief-of-staff")]).join()).toMatch(/reserved/);
  });

  it("keeps specialist MCP servers within the business's and schedule ids unique", () => {
    expect(issuesFor([role("video", { mcpServers: ["gmail"] })]).join()).toMatch(/MCP server "gmail"/);
    const s = { id: "daily", cron: "0 7 * * *", prompt: "p" };
    expect(issuesFor([role("video", { schedules: [s] })], { schedules: [s] })).toContain('shop: duplicate schedule id "daily"');
  });

  it("rejects clashing aliases", () => {
    expect(issuesFor([role("video"), role("blog", { aliases: ["video"] })]).join()).toMatch(/alias "video"/);
  });

  it("still parses an older saved role with a reporting line and intents", () => {
    expect(issuesFor([role("video", { reportsTo: "content-lead", intents: ["publishing"] })])).toEqual([]);
  });
});

describe("specialists at runtime", () => {
  const v = defineVertical({
    ...base,
    roles: [
      role("customer-support", { title: "Customer Support", aliases: ["support"], mcpServers: ["odoo"] }),
      role("ops", { schedules: [{ id: "stock", cron: "0 8 * * *", prompt: "check" }] }),
    ],
  });

  it("finds a specialist by id, alias or title", () => {
    expect(findRole(v, "customer-support")?.id).toBe("customer-support");
    expect(findRole(v, "Support")?.id).toBe("customer-support");
    expect(findRole(v, "customer support")?.id).toBe("customer-support");
    expect(findRole(v, "nobody")).toBeUndefined();
  });

  it("narrows MCP servers per specialist", () => {
    expect(roleMcpServers(v, findRole(v, "support"))).toEqual(["odoo"]);
    expect(roleMcpServers(v, findRole(v, "ops"))).toEqual(["brain", "odoo"]);
  });

  it("lists specialist schedules with their role, and business schedules without", () => {
    const withOwn = defineVertical({ ...v, schedules: [{ id: "wrap", cron: "0 21 * * *", prompt: "wrap" }] });
    expect(schedulesOf(withOwn)).toEqual([{ schedule: expect.objectContaining({ id: "wrap" }) }, { schedule: expect.objectContaining({ id: "stock" }), role: "ops" }]);
  });

  it("lets a business have no specialists", () => {
    const plain = defineVertical({ ...base, skills: ["brain-notes"], guidance: "# How we work" });
    expect(rolesOf(plain)).toEqual([]);
    expect(findRole(plain, "lead")).toBeUndefined();
    expect(plain.guidance).toBe("# How we work");
  });

  it("re-parses a parsed manifest unchanged", () => {
    expect(defineVertical(v)).toEqual(v);
  });

  it("defines the org root", () => {
    const root = defineOrgRoot({ id: "chief-of-staff", title: "Assistant", mission: "m", homeVertical: "personal" });
    expect(root).toMatchObject({ skills: [], schedules: [], homeVertical: "personal" });
    expect(() => defineOrgRoot({ id: "boss" as "chief-of-staff", title: "x", mission: "m", homeVertical: "personal" })).toThrow();
  });
});
