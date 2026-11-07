import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const GYM = "https://gym.test";
const CATALOGUE = "https://catalogue.test/exercises";
const today = new Date().toISOString().slice(0, 10);

const STATE = {
  unit: "kg",
  targetW: 80,
  workouts: [{ id: "w1", d: today, name: "Pull", prs: ["0027"], entries: [{ id: "0027", sets: [{ w: 70, r: 8, done: true }] }] }],
  bodyweight: [{ d: today, w: 83.6 }],
};

const calls: string[] = [];
let token = "";
const gymFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  if (url.startsWith(CATALOGUE)) return Response.json({ id: "0027", name: "barbell bent over row" });
  if (url === `${GYM}/api/pair/redeem`) {
    if (JSON.parse(String(init?.body)).code !== "K7WQ2MZP" || token) return Response.json({ error: "invalid or expired code" }, { status: 400 });
    token = "uid:1:1.paired";
    return Response.json({ token, user: { name: "Dave" } });
  }
  if (!token || new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (url === `${GYM}/api/me`) return Response.json({ user: { name: "Dave" } });
  if (url === `${GYM}/api/data/rev`) return Response.json({ rev: 1 });
  if (url === `${GYM}/api/data`) return Response.json({ state: STATE, rev: 1 });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

describe.skipIf(!DB_URL)("openGym (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { openGymFetch: gymFetch, openGymCatalogueUrl: CATALOGUE, integrationsFetch: gymFetch } });
  });
  afterAll(async () => ctx?.server.stop());

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://cc.test/mcp/opengym"), {
        requestInit: { headers: { authorization: `Bearer ${ADMIN}` } },
        fetch: (url, init) => ctx.server.app.fetch(new Request(url, init)) as Promise<Response>,
      }),
    );
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    await client.close();
    return { ...res, body: res.isError ? res.content[0]!.text : JSON.parse(res.content[0]!.text) };
  };

  it("has no /mcp/opengym until connected", async () => {
    const res = await ctx.server.app.request("/mcp/opengym", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("is connected with a pairing code, which is swapped for a token and saved", async () => {
    const saved = await ctx.api("/api/integrations/opengym/default", { method: "PUT", json: { data: { vertical: "personal", url: GYM }, secrets: { token: "K7WQ-2MZP" } } });
    expect(saved.body).toMatchObject({ ok: true, reloaded: ["gym"] });

    // The code is swapped for a token straight away, not on the first question: it lasts five
    // minutes and only lives in openGym's memory. The token replaces the code in the saved entry,
    // and the card records that pairing worked.
    const deadline = Date.now() + 5000;
    let entry = await ctx.server.integrations.resolved("opengym");
    while (entry?.secrets.token !== "uid:1:1.paired" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      entry = await ctx.server.integrations.resolved("opengym");
    }
    expect(entry?.secrets.token).toBe("uid:1:1.paired");
    expect(calls.filter((c) => c.endsWith("/api/pair/redeem"))).toHaveLength(1);
    let meta = (await ctx.server.integrations.entry("opengym", "default"))?.meta;
    for (let i = 0; !meta?.lastTest && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      meta = (await ctx.server.integrations.entry("opengym", "default"))?.meta;
    }
    expect(meta).toMatchObject({ account: "Dave", lastTest: { ok: true, message: "Paired with openGym as Dave" } });

    const { body } = await tool("training_summary", { days: 7 });
    expect(body).toMatchObject({ sessions: 1, volume: 560, prs: ["barbell bent over row"], weight: { latest: { weight: 83.6 }, goal: 80 } });
    expect(calls.filter((c) => c.endsWith("/api/pair/redeem"))).toHaveLength(1);

    // Saving the token didn't restart the integration.
    expect(ctx.server.integrations.current().gym.accounts[0]?.token).toBe("uid:1:1.paired");
    const list = await ctx.api("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain("uid:1:1.paired");
    const after = await ctx.api("/api/integrations/opengym/default/test", { method: "POST" });
    expect(after.body).toMatchObject({ ok: true, message: "Signed in to openGym as Dave" });
  });

  it("answers workout and weight questions", async () => {
    const w = await tool("get_workout", { date: today });
    expect(w.body.entries).toEqual([{ exercise: "barbell bent over row", body_part: null, best_e1rm: 88.7, sets: ["8 × 70 kg"] }]);
    expect((await tool("get_bodyweight")).body.latest).toMatchObject({ weight: 83.6, vs_goal: 3.6 });
  });

  it("shows a refused or expired pairing code on the card", async () => {
    await ctx.api("/api/integrations/opengym/default", { method: "PUT", json: { data: { vertical: "personal", url: GYM }, secrets: { token: "ZZZZ-ZZZZ" } } });
    let meta = (await ctx.server.integrations.entry("opengym", "default"))?.meta;
    for (let i = 0; !(meta?.lastTest && meta.lastTest.ok === false) && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      meta = (await ctx.server.integrations.entry("opengym", "default"))?.meta;
    }
    expect(meta?.lastTest).toMatchObject({ ok: false });
    expect(meta?.lastTest?.message).toMatch(/refused the pairing code/);
  });
});
