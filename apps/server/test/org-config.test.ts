import { type OrgConfig, type OrgTree, ROOT_ROLE_ID, type VerticalOrgEdit } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "@cc/verticals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const wholesale = {
  id: "wholesale",
  title: "Wholesale",
  reportsTo: "shop-lead",
  aliases: ["trade"],
  mission: "Quotes trade customers.",
  intents: ["supplier"],
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
  /** The dms roles with Ops & Admin's "supplier" intent moved to the new Wholesale role. */
  const withWholesale = (edit: VerticalOrgEdit): VerticalOrgEdit => ({
    ...edit,
    roles: [...edit.roles.map((r) => (r.id === "ops-admin" ? { ...r, intents: r.intents.filter((i) => i !== "supplier") } : r)), wholesale],
  });

  it("starts from the code manifests", async () => {
    const c = await config();
    expect(c.verticals.map((v) => v.unit)).toEqual(["personal", "dms", "3dpandme", "openv", "opend", "command-centre"]);
    const dms = c.verticals[1]!;
    expect(dms).toMatchObject({ overridden: false, version: 0, problem: null, name: "Desktop Machine Shop", mcpServers: ["brain", "odoo", "pa", "mail", "sendcloud"] });
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
    expect(shop.lead.children.map((r) => r.id)).toContain("wholesale");
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
    const twoLeads = { ...dms.current, roles: dms.current.roles.map((r) => (r.id === "wholesale" ? { ...r, reportsTo: ROOT_ROLE_ID, skills: ["no-such-skill"] } : r)) };
    let res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: twoLeads, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(['dms: role "wholesale" lists skill "no-such-skill", which is not in the skills bank']);

    res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: { ...twoLeads, roles: twoLeads.roles.map((r) => ({ ...r, skills: [] })) }, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([`dms: needs exactly one lead reporting to ${ROOT_ROLE_ID}, found 2`]);

    const untitled = { ...dms.current, roles: dms.current.roles.map((r) => (r.id === "wholesale" ? { ...r, title: "" } : r)) };
    res = await ctx.api("/api/org/config/dms", { method: "PUT", json: { data: untitled, expectedVersion: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([expect.stringMatching(/^dms: role "wholesale" title: /)]);
    expect((await dmsUnit()).version).toBe(1);
  });

  it("edits the Chief of Staff", async () => {
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
    // A change saved against an older code manifest: a role owning an intent dms no longer declares.
    const stale = { ...(await dmsUnit()).base, roles: [...(await dmsUnit()).base.roles, { ...wholesale, intents: ["retired-intent"] }] };
    await ctx.server.store.pool.query("update org_overrides set data = $1 where unit = 'dms'", [JSON.stringify(stale)]);
    await ctx.server.org.load();
    const dms = await dmsUnit();
    expect(dms.problem).toMatch(/owns intent "retired-intent"/);
    expect(dms.current.roles.map((r) => r.id)).toContain("wholesale");
    const tree = (await ctx.api("/api/org")).body as OrgTree;
    expect(tree.root.verticals.find((v) => v.id === "dms")!.lead.children.map((r) => r.id)).not.toContain("wholesale");
    // The other saved change still runs.
    expect(tree.root.mission).toBe("Keeps Dave focused.");
  });
});
