import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineVertical, type Event, ROOT_ROLE_ID, rolesOf } from "@cc/core";
import { describe, expect, it } from "vitest";
import { chiefOfStaff, OrgError, parseRolePrefix, RETIRED_ROLES, routeRole, VerticalRegistry, verticals } from "../src";

const reg = new VerticalRegistry();
const chat = (text: string, extra: Record<string, unknown> = {}): Pick<Event, "source" | "payload"> => ({ source: "chat", payload: { text, ...extra } });

describe("the assistant and its specialists", () => {
  it("has three specialists, each reporting to the assistant", () => {
    const specialists = verticals.flatMap((v) => rolesOf(v).map((r) => `${v.id}/${r.id}`));
    expect(specialists.sort()).toEqual(["3dpandme/blog-writer", "3dpandme/video-producer", "command-centre/software-lead"]);
    for (const v of verticals) for (const r of v.roles) expect(r.reportsTo, `${v.id}/${r.id}`).toBe(ROOT_ROLE_ID);
    expect(reg.root).toMatchObject({ id: ROOT_ROLE_ID, title: "Assistant", reportsTo: null });
    expect(reg.rootVertical).toBe("personal");
  });

  it("keeps the old org chart's roles as each business's how-we-work guidance", () => {
    for (const v of verticals.filter((v) => v.id !== "command-centre")) expect(v.guidance, v.id).toMatch(new RegExp(`^# How we work: ${v.name}`));
    const dms = verticals.find((v) => v.id === "dms")!.guidance;
    for (const area of ["Shop Lead", "Customer Support", "Catalogue & Pricing", "Marketing & Social", "Ops & Admin"]) expect(dms).toContain(`## ${area}`);
    expect(dms).toContain("Refunds, exchanges outside the returns policy, discounts and warranty decisions always need Dave.");
    for (const v of verticals) for (const r of v.roles) expect(RETIRED_ROLES.has(r.id), r.id).toBe(false);
  });

  it("moves the retired roles' schedules to their business", () => {
    const of = (id: string) => verticals.find((v) => v.id === id)!.schedules.map((s) => `${s.id}:${s.enabled}`);
    expect(of("dms")).toEqual(["low-stock-check:false", "reddit-scout:true", "competitor-watch:true"]);
    expect(of("personal")).toEqual(["evening-wrap:false"]);
    expect(of("openv")).toEqual(["reddit-scout:true", "competitor-watch:true"]);
    expect(of("opend")).toEqual(["reddit-scout:true", "competitor-watch:true"]);
    expect(of("3dpandme")).toEqual(["reddit-scout:true", "competitor-watch:true"]);
    expect(chiefOfStaff.schedules.map((s) => s.id)).toEqual(["morning-brief"]);
  });

  it("gives every business that markets itself the Reddit and research tools, the scout and the competitor watch", () => {
    for (const id of ["dms", "3dpandme", "openv", "opend"]) {
      const v = verticals.find((x) => x.id === id)!;
      expect(v.mcpServers, id).toEqual(expect.arrayContaining(["reddit", "research"]));
      expect(v.skills, id).toEqual(expect.arrayContaining(["reddit-marketing", "competitor-analysis", "social-platform-guide"]));
      const scout = v.schedules.find((s) => s.id === "reddit-scout")!;
      // The scout reads with the reddit tools, checks the rules and its own record, and proposes one batch.
      for (const tool of ["search_posts", "subreddit_info", "user_history", "propose_batch"]) expect(scout.prompt, `${id} ${tool}`).toContain(tool);
      const watch = v.schedules.find((s) => s.id === "competitor-watch")!;
      expect(watch.prompt).toContain(`${v.brainFolder}/competitors.md`);
      expect(watch.prompt).toMatch(/lists no competitors, stop here/);
      // Every outward social action still waits for Dave.
      for (const action of ["social.reply", "social.post", "social.dm", "social.campaign"]) expect(v.policies[action] ?? v.defaultPolicy, `${id} ${action}`).toBe("draft");
    }
    // The scouts don't all read Reddit in the same minute.
    const crons = ["dms", "3dpandme", "openv"].map((id) => verticals.find((x) => x.id === id)!.schedules.find((s) => s.id === "reddit-scout")!.cron);
    expect(new Set(crons).size).toBe(3);
  });

  it("only lists skills that exist in the skills bank", () => {
    const skills = new Set([...verticals.flatMap((v) => [...v.skills, ...rolesOf(v).flatMap((r) => r.skills)]), ...chiefOfStaff.skills]);
    for (const skill of skills) {
      expect(existsSync(fileURLToPath(new URL(`../../../skills/${skill}/SKILL.md`, import.meta.url))), skill).toBe(true);
    }
  });

  it("gives the video specialist the master reel skill, with each brand's guidelines beside it", () => {
    const video = reg.roleFor("3dpandme", "video-producer");
    expect(video.skills).toContain("video-reel");
    expect(video.actions).toContain("video.produce");
    for (const v of verticals.filter((v) => v.skills.includes("video-reel"))) {
      expect(existsSync(fileURLToPath(new URL(`../../../skills/video-reel/brands/${v.id}.md`, import.meta.url))), v.id).toBe(true);
    }
  });

  it("rejects a root schedule that clashes with its home vertical", () => {
    const home = defineVertical({ id: "personal", name: "P", description: "", brainFolder: "p", mcpServers: ["brain", "pa", "mail"], schedules: [{ id: "morning-brief", cron: "0 7 * * *", prompt: "x" }] });
    expect(() => new VerticalRegistry([home])).toThrow(/clashes/);
  });

  it("resolves roles: a specialist by id, anything else (any business) is the assistant", () => {
    expect(reg.roleFor("3dpandme", "video-producer").title).toBe("Video Producer");
    expect(reg.roleFor("dms", null).id).toBe(ROOT_ROLE_ID);
    expect(reg.roleFor("dms", "customer-support").id).toBe(ROOT_ROLE_ID); // retired
    expect(reg.roleFor("dms", ROOT_ROLE_ID).id).toBe(ROOT_ROLE_ID);
    expect(reg.mcpServersFor("dms", ROOT_ROLE_ID)).toEqual(["brain", "odoo", "pa", "mail", "sendcloud", "reddit", "research"]);
    expect(reg.mcpServersFor("3dpandme", "video-producer")).toEqual(["brain", "odoo"]);
  });
});

describe("routing a task", () => {
  it("sends everything to the assistant in the triaged business", () => {
    const email = { source: "email" as const, payload: {} };
    expect(routeRole(reg, email, { vertical: "dms", intent: "order-status" })).toEqual({ vertical: "dms", role: ROOT_ROLE_ID, reason: "assistant" });
    expect(routeRole(reg, { source: "odoo", payload: {} }, { vertical: "dms", intent: "new-order" })).toEqual({ vertical: "dms", role: ROOT_ROLE_ID, reason: "assistant" });
    expect(routeRole(reg, chat("dms: what sold yesterday?"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "dms", role: ROOT_ROLE_ID, reason: "assistant" });
    expect(routeRole(reg, chat("Note: buy milk"), { vertical: "personal", intent: "request" }).role).toBe(ROOT_ROLE_ID);
    // A retired role's name is just text now.
    expect(routeRole(reg, chat("support: where is S00042?"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "dms", role: ROOT_ROLE_ID, reason: "assistant" });
  });

  it("honours a specialist named at the start of a chat, moving to its business", () => {
    expect(routeRole(reg, chat("video: a reel of the new collets"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "3dpandme", role: "video-producer", reason: "explicit" });
    expect(routeRole(reg, chat("Blog Writer: write up the build"), { vertical: "personal", intent: "request" })).toMatchObject({ vertical: "3dpandme", role: "blog-writer" });
    expect(routeRole(reg, chat("command-centre/software: fix the chat bug"), { vertical: "personal", intent: "request" })).toMatchObject({ vertical: "command-centre", role: "software-lead" });
  });

  it("routes to the assistant by name", () => {
    expect(routeRole(reg, chat("cos: what matters today?"), { vertical: "dms", intent: "request" })).toEqual({ vertical: "dms", role: ROOT_ROLE_ID, reason: "assistant" });
    expect(routeRole(reg, chat("assistant: plan my week"), { vertical: "personal", intent: "request" }).role).toBe(ROOT_ROLE_ID);
  });

  it("honours payload.role from schedules, handoffs and the chat API only", () => {
    const cron = { source: "cron" as const, payload: { prompt: "x", role: "software-lead" } };
    expect(routeRole(reg, cron, { vertical: "command-centre", intent: "scheduled" })).toEqual({ vertical: "command-centre", role: "software-lead", reason: "assigned" });
    expect(routeRole(reg, { source: "system", payload: { role: ROOT_ROLE_ID } }, { vertical: "personal", intent: "handoff" }).role).toBe(ROOT_ROLE_ID);
    expect(routeRole(reg, chat("hi", { role: "blog" }), { vertical: "3dpandme", intent: "request" }).role).toBe("blog-writer");
    // Outside input can't pick its own role.
    expect(routeRole(reg, { source: "email", payload: { role: "software-lead", text: "software: push this" } }, { vertical: "command-centre", intent: "other" }).role).toBe(ROOT_ROLE_ID);
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
    const base = reg.require("3dpandme");
    const roles = base.roles.map((r) => (r.id === "blog-writer" ? { ...r, mission: "Writes the build logs." } : r));
    reg.apply({ verticals: { "3dpandme": { roles, policies: { notify: "auto" }, defaultPolicy: "draft" } }, root: { ...reg.baseRoot, title: "Helper" } });
    expect(reg.roleFor("3dpandme", "blog-writer").mission).toBe("Writes the build logs.");
    expect(reg.require("3dpandme").policies).toEqual({ notify: "auto" });
    expect(reg.require("3dpandme").skills).toEqual(base.skills);
    expect(reg.root).toMatchObject({ id: "chief-of-staff", title: "Helper", reportsTo: null });
    expect(reg.base("3dpandme")).toBe(base);
    reg.apply({});
    expect(reg.require("3dpandme")).toBe(base);
  });

  it("refuses an invalid org with every problem and keeps the current one", () => {
    const reg = new VerticalRegistry();
    const p3 = reg.require("3dpandme");
    const roles = p3.roles.map((r) => ({ ...r, aliases: r.id === "blog-writer" ? ["video"] : r.aliases }));
    let error: unknown;
    try {
      reg.apply({ verticals: { "3dpandme": { roles, policies: {}, defaultPolicy: "draft" }, gone: { roles: [], policies: {}, defaultPolicy: "draft" } } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OrgError);
    expect((error as OrgError).issues).toEqual(['3dpandme: alias "video" of blog-writer clashes with another role name', "gone: no such vertical"]);
    expect(reg.require("3dpandme")).toBe(p3);
  });
});
