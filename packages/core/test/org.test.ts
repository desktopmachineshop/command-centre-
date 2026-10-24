import { describe, expect, it } from "vitest";
import { defineOrgRoot, defineVertical, findRole, leadOf, orgIssues, type RoleInput, roleForIntent, roleMcpServers, rolesOf, schedulesOf, type VerticalManifestInput } from "../src";

const role = (id: string, reportsTo: string, extra: Partial<RoleInput> = {}): RoleInput => ({ id, title: id, mission: `${id} mission.`, reportsTo, ...extra });

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

describe("org chart validation", () => {
  it("accepts a lead with roles under it", () => {
    const v = defineVertical({
      ...base,
      roles: [role("lead", "chief-of-staff"), role("support", "lead", { intents: ["order-status"] }), role("ops", "lead", { intents: ["supplier"] })],
    });
    expect(rolesOf(v).map((r) => r.id)).toEqual(["lead", "support", "ops"]);
    expect(orgIssues(v)).toEqual([]);
  });

  it("puts the lead first whatever the order", () => {
    const v = defineVertical({ ...base, roles: [role("support", "lead"), role("lead", "chief-of-staff")] });
    expect(leadOf(v).id).toBe("lead");
  });

  it("rejects duplicate ids and the reserved root id", () => {
    expect(issuesFor([role("lead", "chief-of-staff"), role("lead", "chief-of-staff")])).toContain('shop: duplicate role id "lead"');
    expect(issuesFor([role("chief-of-staff", "chief-of-staff")]).join()).toMatch(/reserved/);
  });

  it("rejects a dangling reportsTo", () => {
    expect(issuesFor([role("lead", "chief-of-staff"), role("support", "boss")])).toContain('shop: support reports to unknown role "boss"');
  });

  it("rejects cycles and self-reporting", () => {
    const issues = issuesFor([role("lead", "chief-of-staff"), role("a", "b"), role("b", "c"), role("c", "a")]);
    expect(issues.filter((m) => m.includes("cycle"))).toHaveLength(1);
    expect(issues.join()).toMatch(/reporting cycle a -> b -> c -> a/);
    expect(issuesFor([role("lead", "chief-of-staff"), role("x", "x")])).toContain("shop: x reports to itself");
  });

  it("needs exactly one lead", () => {
    expect(issuesFor([role("a", "chief-of-staff"), role("b", "chief-of-staff")]).join()).toMatch(/exactly one lead.*found 2/);
    expect(issuesFor([role("a", "b"), role("b", "a")]).join()).toMatch(/found 0/);
  });

  it("gives each intent at most one owner, from the vertical's intents", () => {
    const twice = issuesFor([role("lead", "chief-of-staff"), role("a", "lead", { intents: ["order-status"] }), role("b", "lead", { intents: ["order-status"] })]);
    expect(twice).toContain('shop: intent "order-status" is owned by both a and b');
    const unknown = issuesFor([role("lead", "chief-of-staff", { intents: ["billing"] })]);
    expect(unknown.join()).toMatch(/owns intent "billing", which the vertical does not declare/);
  });

  it("keeps role MCP servers within the vertical's and schedule ids unique", () => {
    expect(issuesFor([role("lead", "chief-of-staff", { mcpServers: ["gmail"] })]).join()).toMatch(/MCP server "gmail"/);
    const s = { id: "daily", cron: "0 7 * * *", prompt: "p" };
    expect(issuesFor([role("lead", "chief-of-staff", { schedules: [s] })], { schedules: [s] })).toContain('shop: duplicate schedule id "daily"');
  });

  it("rejects clashing aliases", () => {
    expect(issuesFor([role("lead", "chief-of-staff"), role("support", "lead"), role("ops", "lead", { aliases: ["support"] })]).join()).toMatch(/alias "support"/);
  });
});

describe("roles at runtime", () => {
  const v = defineVertical({
    ...base,
    roles: [
      role("shop-lead", "chief-of-staff", { title: "Shop Lead" }),
      role("customer-support", "shop-lead", { title: "Customer Support", aliases: ["support"], intents: ["order-status"], mcpServers: ["odoo"] }),
      role("ops", "shop-lead", { schedules: [{ id: "stock", cron: "0 8 * * *", prompt: "check" }] }),
    ],
  });

  it("routes an intent to its owner, else the lead", () => {
    expect(roleForIntent(v, "order-status").id).toBe("customer-support");
    expect(roleForIntent(v, "spam").id).toBe("shop-lead");
    expect(roleForIntent(v, "request").id).toBe("shop-lead");
  });

  it("finds a role by id, alias or title", () => {
    expect(findRole(v, "customer-support")?.id).toBe("customer-support");
    expect(findRole(v, "Support")?.id).toBe("customer-support");
    expect(findRole(v, "customer support")?.id).toBe("customer-support");
    expect(findRole(v, "nobody")).toBeUndefined();
  });

  it("narrows MCP servers per role", () => {
    expect(roleMcpServers(v, findRole(v, "support"))).toEqual(["odoo"]);
    expect(roleMcpServers(v, findRole(v, "ops"))).toEqual(["brain", "odoo"]);
  });

  it("lists role schedules with their role", () => {
    expect(schedulesOf(v)).toEqual([{ schedule: expect.objectContaining({ id: "stock" }), role: "ops" }]);
  });

  it("gives a vertical without roles an implicit lead (backward compatible)", () => {
    const plain = defineVertical({ ...base, skills: ["brain-notes"] });
    expect(plain.roles).toEqual([]);
    expect(rolesOf(plain)).toHaveLength(1);
    expect(leadOf(plain)).toMatchObject({ id: "lead", title: "Shop Lead", reportsTo: "chief-of-staff", skills: ["brain-notes"] });
    expect(roleForIntent(plain, "order-status").id).toBe("lead");
    expect(roleMcpServers(plain, leadOf(plain))).toEqual(["brain", "odoo"]);
  });

  it("re-parses a parsed manifest unchanged", () => {
    expect(defineVertical(v)).toEqual(v);
  });

  it("defines the org root", () => {
    const root = defineOrgRoot({ id: "chief-of-staff", title: "Chief of Staff", mission: "m", homeVertical: "personal" });
    expect(root).toMatchObject({ skills: [], schedules: [], homeVertical: "personal" });
    expect(() => defineOrgRoot({ id: "boss" as "chief-of-staff", title: "x", mission: "m", homeVertical: "personal" })).toThrow();
  });
});
