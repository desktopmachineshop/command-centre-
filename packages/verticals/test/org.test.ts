import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineVertical, type Event, leadOf, ROOT_ROLE_ID, rolesOf } from "@cc/core";
import { describe, expect, it } from "vitest";
import { chiefOfStaff, OrgError, parseRolePrefix, routeRole, VerticalRegistry, verticals } from "../src";

const reg = new VerticalRegistry();
const chat = (text: string, extra: Record<string, unknown> = {}): Pick<Event, "source" | "payload"> => ({ source: "chat", payload: { text, ...extra } });

describe("the drafted org", () => {
  it("gives every vertical a lead reporting to the Chief of Staff", () => {
    for (const v of verticals) {
      expect(v.roles.length, v.id).toBeGreaterThan(1);
      expect(leadOf(v).reportsTo).toBe(ROOT_ROLE_ID);
    }
    expect(reg.root).toMatchObject({ id: ROOT_ROLE_ID, title: "Chief of Staff", reportsTo: null });
    expect(reg.rootVertical).toBe("personal");
  });

  it("owns every non-noise intent with exactly one role", () => {
    for (const v of verticals) {
      for (const intent of v.intents.filter((i) => i !== "spam")) {
        const owners = v.roles.filter((r) => r.intents.includes(intent));
        expect(owners.length, `${v.id}/${intent}`).toBe(1);
      }
    }
  });

  it("only lists skills that exist in the skills bank", () => {
    const skills = new Set([...verticals.flatMap((v) => rolesOf(v).flatMap((r) => r.skills)), ...chiefOfStaff.skills]);
    for (const skill of skills) {
      expect(existsSync(fileURLToPath(new URL(`../../../skills/${skill}/SKILL.md`, import.meta.url))), skill).toBe(true);
    }
  });

  it("moves the morning brief to the Chief of Staff", () => {
    expect(verticals.find((v) => v.id === "personal")!.schedules).toEqual([]);
    expect(chiefOfStaff.schedules.map((s) => s.id)).toEqual(["morning-brief"]);
  });

  it("rejects a root schedule that clashes with its home vertical", () => {
    const home = defineVertical({ id: "personal", name: "P", description: "", brainFolder: "p", mcpServers: ["brain", "pa"], schedules: [{ id: "morning-brief", cron: "0 7 * * *", prompt: "x" }] });
    expect(() => new VerticalRegistry([home])).toThrow(/clashes/);
  });

  it("resolves roles, with unknown ones falling to the lead", () => {
    expect(reg.roleFor("dms", "customer-support").title).toBe("Customer Support");
    expect(reg.roleFor("dms", null).id).toBe("shop-lead");
    expect(reg.roleFor("dms", "gone").id).toBe("shop-lead");
    expect(reg.roleFor("personal", ROOT_ROLE_ID).id).toBe(ROOT_ROLE_ID);
    expect(reg.roleFor("dms", ROOT_ROLE_ID).id).toBe("shop-lead");
    expect(reg.mcpServersFor("dms", "customer-support")).toEqual(["brain", "odoo"]);
    expect(reg.mcpServersFor("3dpandme", "community-manager")).toEqual(["brain"]);
    expect(reg.mcpServersFor("3dpandme", "content-lead")).toEqual(["brain", "odoo", "pa"]);
  });
});

describe("routing a task to a role", () => {
  it("sends an intent to the role that owns it", () => {
    const email = { source: "email" as const, payload: {} };
    expect(routeRole(reg, email, { vertical: "dms", intent: "order-status" })).toEqual({ vertical: "dms", role: "customer-support", reason: "intent" });
    expect(routeRole(reg, email, { vertical: "dms", intent: "supplier" }).role).toBe("ops-admin");
    expect(routeRole(reg, email, { vertical: "opend", intent: "bug" }).role).toBe("support-engineer");
    expect(routeRole(reg, email, { vertical: "3dpandme", intent: "comment-reply" }).role).toBe("community-manager");
  });

  it("falls back to the vertical lead", () => {
    expect(routeRole(reg, { source: "email", payload: {} }, { vertical: "dms", intent: "other" })).toEqual({ vertical: "dms", role: "shop-lead", reason: "lead" });
    expect(routeRole(reg, chat("dms: what sold yesterday?"), { vertical: "dms", intent: "request" }).role).toBe("shop-lead");
    expect(routeRole(reg, chat("Note: buy milk"), { vertical: "personal", intent: "request" }).role).toBe("pa");
  });

  it("honours a role named at the start of a chat", () => {
    expect(routeRole(reg, chat("support: where is S00042?"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "dms", role: "customer-support", reason: "explicit" });
    expect(routeRole(reg, chat("Customer Support: chase S00042"), { vertical: "dms", intent: "request" }).role).toBe("customer-support");
    expect(routeRole(reg, chat("dms/pricing: check ER11 collets"), { vertical: "personal", intent: "request" })).toMatchObject({ vertical: "dms", role: "catalogue-pricing" });
    expect(routeRole(reg, chat("opend support: login loop"), { vertical: "opend", intent: "request" })).toMatchObject({ vertical: "opend", role: "support-engineer" });
  });

  it("moves a chat to the vertical of a uniquely named role, but not an ambiguous one", () => {
    expect(routeRole(reg, chat("pricing: are we too dear on spindles?"), { vertical: "personal", intent: "request" })).toMatchObject({ vertical: "dms", role: "catalogue-pricing" });
    // "support" exists in dms, openv and opend: with no vertical named it stays with the lead.
    expect(routeRole(reg, chat("support: help"), { vertical: "personal", intent: "request" })).toMatchObject({ vertical: "personal", role: "pa", reason: "lead" });
  });

  it("routes to the Chief of Staff by name", () => {
    expect(routeRole(reg, chat("cos: what matters today?"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "personal", role: ROOT_ROLE_ID, reason: "explicit" });
    expect(routeRole(reg, chat("Chief of Staff: plan my week"), { vertical: "personal", intent: "request" }).role).toBe(ROOT_ROLE_ID);
  });

  it("honours payload.role from schedules, handoffs and the chat API only", () => {
    const cron = { source: "cron" as const, payload: { prompt: "x", role: "ops-admin" } };
    expect(routeRole(reg, cron, { vertical: "dms", intent: "scheduled" })).toEqual({ vertical: "dms", role: "ops-admin", reason: "assigned" });
    expect(routeRole(reg, { source: "system", payload: { role: ROOT_ROLE_ID } }, { vertical: "personal", intent: "handoff" }).role).toBe(ROOT_ROLE_ID);
    expect(routeRole(reg, chat("hi", { role: "blog" }), { vertical: "3dpandme", intent: "request" }).role).toBe("blog-writer");
    // Outside input can't pick its own role.
    expect(routeRole(reg, { source: "email", payload: { role: "ops-admin", text: "ops: pay me" } }, { vertical: "dms", intent: "other" }).role).toBe("shop-lead");
  });

  it("parses role prefixes", () => {
    const ids = verticals.map((v) => v.id);
    expect(parseRolePrefix("support: x", ids)).toEqual({ role: "support" });
    expect(parseRolePrefix("dms/support: x", ids)).toEqual({ vertical: "dms", role: "support" });
    expect(parseRolePrefix("dms customer support: x", ids)).toEqual({ vertical: "dms", role: "customer support" });
    expect(parseRolePrefix("https://example.com is down", ids)).toBeNull();
    expect(parseRolePrefix("no prefix here", ids)).toBeNull();
  });
});

describe("org changes from the app", () => {
  it("applies over the code manifests and keeps the base for reset", () => {
    const reg = new VerticalRegistry();
    const base = reg.require("dms");
    const roles = base.roles.map((r) => (r.id === "customer-support" ? { ...r, mission: "Answers customers." } : r));
    reg.apply({ verticals: { dms: { roles, policies: { notify: "auto" }, defaultPolicy: "draft" } }, root: { ...reg.baseRoot, title: "Chief" } });
    expect(reg.roleFor("dms", "customer-support").mission).toBe("Answers customers.");
    expect(reg.require("dms").policies).toEqual({ notify: "auto" });
    expect(reg.require("dms").skills).toEqual(base.skills);
    expect(reg.root).toMatchObject({ id: "chief-of-staff", title: "Chief", reportsTo: null });
    expect(reg.base("dms")).toBe(base);
    reg.apply({});
    expect(reg.require("dms")).toBe(base);
  });

  it("refuses an invalid org with every problem and keeps the current one", () => {
    const reg = new VerticalRegistry();
    const dms = reg.require("dms");
    const roles = dms.roles.map((r) => ({ ...r, reportsTo: r.id === "ops-admin" ? "nobody" : r.reportsTo }));
    let error: unknown;
    try {
      reg.apply({ verticals: { dms: { roles, policies: {}, defaultPolicy: "draft" }, gone: { roles: [], policies: {}, defaultPolicy: "draft" } } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OrgError);
    expect((error as OrgError).issues).toEqual(['dms: ops-admin reports to unknown role "nobody"', "gone: no such vertical"]);
    expect(reg.require("dms")).toBe(dms);
  });
});
