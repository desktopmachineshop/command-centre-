import { type OrgConfig, type OrgTree, ROOT_ROLE_ID, type VerticalOrgEdit } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "@cc/verticals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const wholesale = {
  id: "wholesale",
  title: "Wholesale",
  reportsTo: ROOT_ROLE_ID,
  aliases: ["trade"],
  mission: "Quotes trade customers.",
  intents: [],
  skills: ["brain-notes"],
  mcpServers: ["brain"],
  actions: ["email.reply"],
  tools: [],
  schedules: [],
  kpis: ["Quotes out within a day"],
  autonomyNotes: "Drafts every quote.",
};

describe.skipIf(!DB_URL)("org editing from the app", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
  });
  afterAll(async () => ctx?.server.stop());

  const config = async () => (await ctx.api("/api/org/config")).body as OrgConfig;
  const dmsUnit = async () => (await config()).verticals.find((v) => v.unit === "dms")!;
  /** dms with a new specialist, Wholesale. */
  const withWholesale = (edit: VerticalOrgEdit): VerticalOrgEdit => ({ ...edit, roles: [...edit.roles, wholesale] });

  it("starts from the code manifests", async () => {
    const c = await config();
    expect(c.verticals.map((v) => v.unit)).toEqual(["personal", "dms", "3dpandme", "openv", "opend", "command-centre"]);
    const dms = c.verticals[1]!;
    expect(dms).toMatchObject({ overridden: false, version: 0, problem: null, name: "Desktop Machine Shop", mcpServers: ["brain", "odoo", "pa", "mail", "sendcloud", "video"] });
    expect(dms.current).toEqual(dms.base);
    expect(dms.current.policies).toEqual({ ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" });
    expect(c.root).toMatchObject({ unit: ROOT_ROLE_ID, homeVertical: "personal", version: 0 });
    expect(c.skills.map((s) => s.name)).toEqual(["brain-notes"]);
    expect(c.actionTypes).toContain("notify");
  });

  it("saves a new role and a policy, and runs them at once", async () => {
    const dms = await dmsUnit();
    const data = { ...withWholesale(dms.current), policies: { ...dms.current.policies, notify: "auto" } };
    const { status, body } = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data, expectedVersion: 0 } });
    expect(status).toBe(200);
    expect((body as OrgConfig).verticals[1]).toMatchObject({ overridden: true, version: 1, updatedBy: "admin" });

    const tree = (await ctx.api("/api/org")).body as OrgTree;
    const shop = tree.root.verticals.find((v) => v.id === "dms")!;
    expect(shop.specialists.map((r) => r.id)).toEqual(["wholesale"]);
    const manifest = ((await ctx.api("/api/verticals")).body as { id: string; policies: Record<string, string> }[]).find((v) => v.id === "dms")!;
    expect(manifest.policies).toEqual({ ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto", notify: "auto" });

    // Chat can address the new role by its alias straight away.
    const chat = (await ctx.api("/api/chat", { method: "POST", json: { text: "trade: quote 20 ER11 sets" } })).body;
    expect(chat.task).toMatchObject({ vertical: "dms", role: "wholesale" });
  });

  it("refuses a stale save", async () => {
    const dms = await dmsUnit();
    const { status, body } = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: dms.current, expectedVersion: 0 } });
    expect(status).toBe(409);
    expect(body.version).toBe(1);
  });

  it("refuses an org that fails its checks, listing every problem", async () => {
    const dms = await dmsUnit();
    const badSkill = { ...dms.current, roles: dms.current.roles.map((r) => (r.id === "wholesale" ? { ...r, skills: ["no-such-skill"] } : r)) };
    let res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: badSkill, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(['dms: role "wholesale" lists skill "no-such-skill", which is not in the skills bank']);

    res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: { ...dms.current, roles: [...dms.current.roles, wholesale] }, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(['dms: duplicate role id "wholesale"', 'dms: alias "trade" of wholesale clashes with another role name']);

    const untitled = { ...dms.current, roles: dms.current.roles.map((r) => (r.id === "wholesale" ? { ...r, title: "" } : r)) };
    res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: untitled, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([expect.stringMatching(/^dms: role "wholesale" title: /)]);
    expect((await dmsUnit()).version).toBe(1);
  });

  it("edits the assistant", async () => {
    const { root } = await config();
    const res = await ctx.api(`/api/org/config/${ROOT_ROLE_ID}`, { method: "PUT", json: { data: { ...root.current, mission: "Keeps Dave focused." }, expectedVersion: 0 } });
    expect(res.status).toBe(200);
    expect(((await ctx.api("/api/org")).body as OrgTree).root.mission).toBe("Keeps Dave focused.");
    // Its servers must be the home vertical's.
    const bad = await ctx.api(`/api/org/config/${ROOT_ROLE_ID}`, { method: "PUT", json: { data: { ...root.current, mcpServers: ["odoo"] }, expectedVersion: 1 } });
    expect(bad.status).toBe(400);
  });

  it("resets to the code, keeps history and restores", async () => {
    let res = await ctx.api("/api/org/config/dms?expectedVersion=1", { method: "DELETE" });
    expect(res.status).toBe(200);
    let dms = (res.body as OrgConfig).verticals[1]!;
    expect(dms).toMatchObject({ overridden: false, version: 2 });
    expect(dms.current.roles.map((r) => r.id)).not.toContain("wholesale");
    expect((await ctx.api("/api/chat", { method: "POST", json: { text: "trade: hello", vertical: "dms" } })).body.task.role).not.toBe("wholesale");

    const history = (await ctx.api("/api/org/config/dms/history")).body;
    expect(history.map((h: { version: number; reset: boolean }) => [h.version, h.reset])).toEqual([[2, true], [1, false]]);
    expect((await ctx.api("/api/org/config/dms/versions/1")).body.data.roles.map((r: { id: string }) => r.id)).toContain("wholesale");
    expect((await ctx.api("/api/org/config/dms/versions/2")).body).toEqual({ data: null });

    res = await ctx.api("/api/org/config/dms/restore", { method: "POST", json: { version: 1 } });
    dms = (res.body as OrgConfig).verticals[1]!;
    expect(dms).toMatchObject({ overridden: true, version: 3 });
    expect(dms.current.roles.map((r) => r.id)).toContain("wholesale");
  });

  it("loads saved changes on boot, leaving out one the code no longer accepts", async () => {
    // A change saved against an older code manifest: a specialist on a server dms doesn't have.
    const stale = { ...(await dmsUnit()).base, roles: [...(await dmsUnit()).base.roles, { ...wholesale, mcpServers: ["github"] }] };
    await ctx.server.store.pool.query("update org_overrides set data = $1 where unit = 'dms'", [JSON.stringify(stale)]);
    await ctx.server.org.load();
    const dms = await dmsUnit();
    expect(dms.problem).toMatch(/lists MCP server "github"/);
    expect(dms.current.roles.map((r) => r.id)).toContain("wholesale");
    const tree = (await ctx.api("/api/org")).body as OrgTree;
    expect(tree.root.verticals.find((v) => v.id === "dms")!.specialists.map((r) => r.id)).not.toContain("wholesale");
    // The other saved change still runs.
    expect(tree.root.mission).toBe("Keeps Dave focused.");
  });

  it("brings a save from before a code change up to date, and keeps what Dave removed removed", async () => {
    const ccUnit = async () => (await config()).verticals.find((v) => v.unit === "command-centre")!;
    const base = (await ccUnit()).base;
    const lead = base.roles.find((r) => r.id === "software-lead")!;
    // Saved before the code gave the Software Lead ops, github.issue.comment and the daily assessment (no codeBase).
    const old: VerticalOrgEdit = {
      ...base,
      roles: [{ ...lead, mission: "Dave's words.", mcpServers: ["brain", "github"], actions: lead.actions.filter((a) => a !== "github.issue.comment"), schedules: lead.schedules.filter((x) => x.id === "file-issues"), tools: [] }],
      policies: Object.fromEntries(Object.entries(base.policies).filter(([k]) => k !== "github.issue.comment")),
    };
    await ctx.server.store.pool.query("insert into org_overrides (unit, data, version, updated_by) values ('command-centre', $1, 1, 'dave')", [JSON.stringify(old)]);
    await ctx.server.store.pool.query("insert into org_override_versions (unit, version, data, author) values ('command-centre', 1, $1, 'dave')", [JSON.stringify(old)]);
    await ctx.server.org.load();
    let cc = await ccUnit();
    let role = cc.current.roles[0]!;
    expect(cc.problem).toBeNull();
    expect(role.mission).toBe("Dave's words.");
    expect(role.mcpServers).toEqual(["brain", "github", "ops"]);
    expect(role.actions).toContain("github.issue.comment");
    expect(role.schedules.map((x) => x.id)).toEqual(["file-issues", "assess-performance"]);
    expect(role.tools).toEqual(lead.tools);
    expect(cc.current.policies["github.issue.comment"]).toBe("auto");

    // Dave drops ops on the Org page: that removal sticks, now that the save records the code it was made over.
    const data = { ...cc.current, roles: [{ ...role, mcpServers: ["brain", "github"] }] };
    expect((await ctx.api("/api/org/config/command-centre", { method: "PUT", json: { data, expectedVersion: 1 } })).status).toBe(200);
    await ctx.server.org.load();
    cc = await ccUnit();
    role = cc.current.roles[0]!;
    expect(role.mcpServers).toEqual(["brain", "github"]);
    expect(role.schedules.map((x) => x.id)).toEqual(["file-issues", "assess-performance"]);
    const v2 = (await ctx.api("/api/org/config/command-centre/versions/2")).body.data;
    expect(v2).not.toHaveProperty("codeBase");
  });
});
