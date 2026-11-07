import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createOpenGymMcpServer,
  GymService,
  isPairingCode,
  OpenGymAuthError,
  OpenGymClient,
  openGymAccountFromEnv,
  openGymBase,
  setLabel,
  workoutsOf,
  workoutVolume,
} from "../src";

const URL_ = "https://gym.test";
const CAT = "https://cat.test/exercises";

const STATE = {
  unit: "kg",
  targetW: 80,
  customEx: [{ id: "c_1", n: "Garage sled push" }],
  workouts: [
    {
      id: "w1",
      d: "2026-10-30",
      name: "Push",
      start: Date.parse("2026-10-30T07:00:00Z"),
      end: Date.parse("2026-10-30T08:05:00Z"),
      prs: [],
      entries: [{ id: "0025", sets: [{ w: 20, r: 10, done: true, phase: "warmup" }, { w: 60, r: 8, done: true }, { w: 60, r: 7, done: true }] }],
    },
    {
      id: "w2",
      d: "2026-11-05",
      name: "Pull",
      start: Date.parse("2026-11-05T07:00:00Z"),
      end: Date.parse("2026-11-05T07:50:00Z"),
      prs: ["0027"],
      vol: 2000,
      entries: [
        { id: "0027", sets: [{ w: 70, r: 8, done: true }, { w: 70, r: 8, done: false }] },
        { id: "c_1", sets: [{ w: 0, r: 20, done: true }] },
        { id: "0294", sets: [{ sides: { L: { w: 14, r: 10, done: true }, R: { w: 14, r: 9, done: true } }, w: 14, r: 19, done: true }] },
      ],
    },
    { d: "not a date", entries: [] },
  ],
  bodyweight: [
    { d: "2026-10-01", w: 86 },
    { d: "2026-10-29", w: 84.4 },
    { d: "2026-11-06", w: 83.6 },
  ],
};

interface Call {
  url: string;
  auth: string | null;
  body?: string;
}

function fakeServer(opts: { token?: string; renew?: string; rev?: () => number } = {}) {
  const calls: Call[] = [];
  let token = opts.token ?? "uid:9999:1.mac";
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    calls.push({ url, auth, body: init?.body as string | undefined });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(CAT)) {
      const id = url.split("/").pop()!.replace(".json", "");
      const names: Record<string, string> = { "0025": "barbell bench press", "0027": "barbell bent over row", "0294": "dumbbell row" };
      return names[id] ? json({ id, name: names[id], bodyPart: "back", target: "lats" }) : json({}, 404);
    }
    if (url === `${URL_}/api/pair/redeem`) {
      const code = JSON.parse(String(init?.body)).code;
      return code === "K7WQ2MZP" ? json({ token: "uid:1:1.paired", user: { name: "Dave" } }) : json({ error: "invalid or expired code" }, 400);
    }
    if (auth !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
    if (url === `${URL_}/api/me`) {
      if (opts.renew) {
        token = opts.renew;
        return json({ user: { name: "Dave" }, token: opts.renew });
      }
      return json({ user: { name: "Dave" } });
    }
    if (url === `${URL_}/api/data/rev`) return json({ rev: opts.rev?.() ?? 3 });
    if (url === `${URL_}/api/data`) return json({ state: STATE, rev: opts.rev?.() ?? 3 });
    return json({ error: "not found" }, 404);
  };
  return { f, calls, setToken: (t: string) => (token = t) };
}

const NOW = () => new Date("2026-11-07T10:00:00Z");

describe("openGym client", () => {
  it("refuses plain http except to localhost", () => {
    expect(() => openGymBase("http://gym.example.com")).toThrow(/https/);
    expect(openGymBase("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(openGymBase("https://example.com/gym/")).toBe("https://example.com/gym");
  });

  it("tells pairing codes from tokens", () => {
    expect(isPairingCode("K7WQ2MZP")).toBe(true);
    expect(isPairingCode("k7wq-2mzp")).toBe(true);
    expect(isPairingCode("uid:9999:1.mac")).toBe(false);
  });

  it("reports a rejected token without quoting it", async () => {
    const { f } = fakeServer();
    const client = new OpenGymClient({ url: URL_, token: "wrong.token", fetch: f });
    const err = await client.data().catch((e) => e);
    expect(err).toBeInstanceOf(OpenGymAuthError);
    expect(String(err.message)).not.toContain("wrong.token");
  });

  it("reads env config", () => {
    expect(openGymAccountFromEnv({})).toEqual([]);
    expect(() => openGymAccountFromEnv({ OPENGYM_URL: URL_ })).toThrow(/both/);
    expect(openGymAccountFromEnv({ OPENGYM_URL: URL_, OPENGYM_TOKEN: "t" })[0]).toMatchObject({ id: "default", vertical: "personal" });
  });
});

describe("state model", () => {
  it("skips bad rows and counts work sets only", () => {
    const ws = workoutsOf(STATE);
    expect(ws.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(workoutVolume(ws[0]!)).toBe(60 * 8 + 60 * 7); // warm-up left out
    expect(workoutVolume(ws[1]!)).toBe(2000); // the saved number wins
  });

  it("labels sets", () => {
    expect(setLabel({ w: 60, r: 8, done: true }, "kg")).toBe("8 × 60 kg");
    expect(setLabel({ w: 0, r: 20, done: true }, "kg")).toBe("20 reps");
    expect(setLabel({ w: 20, r: 10, done: false, warmup: true }, "kg")).toBe("warm-up 10 × 20 kg (not done)");
  });
});

describe("GymService", () => {
  it("redeems a pairing code once and saves the token", async () => {
    const server = fakeServer({ token: "uid:1:1.paired" });
    const saved: string[] = [];
    const gym = new GymService({ id: "default", vertical: "personal", url: URL_, token: "K7WQ-2MZP" }, { fetch: server.f, catalogueUrl: CAT, now: NOW, onToken: (_id, t) => void saved.push(t) });
    await Promise.all([gym.state(), gym.state()]);
    expect(saved).toEqual(["uid:1:1.paired"]);
    expect(server.calls.filter((c) => c.url.endsWith("/api/pair/redeem"))).toHaveLength(1);
  });

  it("saves a renewed token", async () => {
    const server = fakeServer({ renew: "uid:2:1.renewed" });
    const saved: string[] = [];
    const gym = new GymService({ id: "default", vertical: "personal", url: URL_, token: "uid:9999:1.mac" }, { fetch: server.f, catalogueUrl: CAT, now: NOW, onToken: (_id, t) => void saved.push(t) });
    expect(await gym.whoami()).toBe("Dave");
    expect(saved).toEqual(["uid:2:1.renewed"]);
    await gym.state(); // the client now sends the renewed token
    expect(server.calls.at(-1)?.auth).toBe("Bearer uid:2:1.renewed");
  });

  it("fetches the document again only when the revision moves", async () => {
    let rev = 3;
    const server = fakeServer({ rev: () => rev });
    const gym = new GymService({ id: "default", vertical: "personal", url: URL_, token: "uid:9999:1.mac" }, { fetch: server.f, catalogueUrl: CAT, now: NOW });
    await gym.state();
    await gym.state();
    expect(server.calls.filter((c) => c.url.endsWith("/api/data"))).toHaveLength(1);
    rev = 4;
    await gym.state();
    expect(server.calls.filter((c) => c.url.endsWith("/api/data"))).toHaveLength(2);
  });

  it("summarises a week and resolves exercise names", async () => {
    const server = fakeServer();
    const gym = new GymService({ id: "default", vertical: "personal", url: URL_, token: "uid:9999:1.mac" }, { fetch: server.f, catalogueUrl: CAT, now: NOW });
    const s = await gym.summary({ days: 7, timeZone: "Europe/London" });
    expect(s).toMatchObject({ from: "2026-11-01", to: "2026-11-07", sessions: 1, sessions_previous_period: 1, volume: 2000, prs: ["barbell bent over row"], days_since_last_workout: 2 });
    expect(s.weight).toMatchObject({ latest: { date: "2026-11-06", weight: 83.6 }, goal: 80, change: -0.8, since: "2026-10-29" });

    const w = await gym.workout({ date: "2026-11-05" });
    expect(w.found).toBe(true);
    if (!w.found) return;
    expect(w.entries.map((e) => e.exercise)).toEqual(["barbell bent over row", "Garage sled push", "dumbbell row"]);
    expect(w.entries[0]!.sets).toEqual(["8 × 70 kg", "8 × 70 kg (not done)"]);
    expect(w.entries[2]!.sets).toEqual(["L 10 × 14 / R 9 × 14 kg"]);
    expect(w.sets_done).toBe(4);
  });

  it("serves the tools over MCP", async () => {
    const server = fakeServer();
    const gym = new GymService({ id: "default", vertical: "personal", url: URL_, token: "uid:9999:1.mac" }, { fetch: server.f, catalogueUrl: CAT, now: NOW });
    const mcp = createOpenGymMcpServer(gym, "Europe/London");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_bodyweight", "get_workout", "list_workouts", "training_summary"]);
    const res = (await client.callTool({ name: "get_bodyweight", arguments: { from: "2026-10-15" } })) as { content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);
    expect(body.entries).toHaveLength(2);
    expect(body.latest).toMatchObject({ weight: 83.6, vs_goal: 3.6 });
    expect(body.change_30d).toBe(-2.4);
    const list = (await client.callTool({ name: "list_workouts", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(list.content[0]!.text).workouts.map((w: { id: string }) => w.id)).toEqual(["w2", "w1"]);
  });
});
