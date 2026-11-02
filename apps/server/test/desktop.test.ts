import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGithubOidcVerifier, DESKTOP_UPLOAD_AUDIENCE, GITHUB_OIDC_ISSUER, OidcError } from "../src/github-oidc";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "./helpers";

const FAST = { ln: 10, r: 8, p: 1 };
const REPO = "desktopmachineshop/command-centre-";

/** A fake GitHub OIDC issuer: its JWKS and tokens signed with its key. */
function fakeGithub() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const fetch = (async (url: string | URL | Request) => {
    expect(String(url)).toBe(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const token = (claims: Record<string, unknown> = {}, kid = "k1") => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = {
      iss: GITHUB_OIDC_ISSUER,
      aud: DESKTOP_UPLOAD_AUDIENCE,
      exp: now + 300,
      nbf: now - 5,
      iat: now,
      repository: REPO,
      workflow_ref: `${REPO}/.github/workflows/desktop.yml@refs/heads/main`,
      ref: "refs/heads/main",
      sha: "abc1234",
      event_name: "push",
      ...claims,
    };
    const unsigned = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(body)}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  };
  return { fetch, token };
}

describe("GitHub OIDC verification", () => {
  const gh = fakeGithub();
  const verify = createGithubOidcVerifier({ fetch: gh.fetch });
  const expected = { audience: DESKTOP_UPLOAD_AUDIENCE, repository: REPO, workflowPath: ".github/workflows/desktop.yml" };

  it("accepts the Desktop workflow of this repository", async () => {
    await expect(verify(gh.token(), expected)).resolves.toMatchObject({ repository: REPO });
  });

  it.each([
    ["another repository", { repository: "someone/else" }],
    ["another workflow", { workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main` }],
    ["another audience", { aud: "sts.amazonaws.com" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["a pull request build", { event_name: "pull_request" }],
  ])("refuses %s", async (_name, claims) => {
    await expect(verify(gh.token(claims), expected)).rejects.toBeInstanceOf(OidcError);
  });

  it("refuses a token signed by someone else or with an unknown key", async () => {
    const other = fakeGithub();
    await expect(verify(other.token(), expected)).rejects.toThrow(/signature/);
    await expect(verify(gh.token({}, "k2"), expected)).rejects.toThrow(/Unknown signing key/);
    await expect(verify("not.a.jwt.at-all", expected)).rejects.toBeInstanceOf(OidcError);
  });
});

describe.skipIf(!DB_URL)("desktop app linking and installer", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let cookie: string;
  const gh = fakeGithub();

  const req = async (path: string, init: { method?: string; json?: unknown; cookie?: string; headers?: Record<string, string>; body?: RequestInit["body"] } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    headers.set("x-cc-request", "1");
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await ctx.server.app.request(path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const text = Buffer.from(await res.arrayBuffer());
    let body: any = null;
    try {
      body = JSON.parse(text.toString("utf8"));
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { scrypt: FAST, githubOidc: createGithubOidcVerifier({ fetch: gh.fetch }) } });
    const setup = await ctx.server.app.request("/api/auth/setup", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "dave@example.com", name: "Dave", password: "correct horse battery" }),
    });
    expect(setup.status).toBe(201);
    cookie = setup.headers.getSetCookie().find((c) => /cc_session=/.test(c))!.split(";")[0]!;
  });
  afterAll(async () => ctx?.server.stop());

  /** Starts a link and approves it as Dave; returns the device token. */
  async function link(name: string) {
    const start = await req("/api/desktop/link", { json: { name } });
    expect(start.status).toBe(201);
    expect(start.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await req("/api/desktop/link/poll", { json: { pollToken: start.body.pollToken } })).body).toEqual({ status: "pending" });
    const approve = await req(`/api/desktop/link/${start.body.code.toLowerCase()}/approve`, { method: "POST", cookie });
    expect(approve.status).toBe(201);
    const poll = await req("/api/desktop/link/poll", { json: { pollToken: start.body.pollToken } });
    expect(poll.body).toMatchObject({ status: "approved", deviceId: approve.body.id });
    return { token: poll.body.token as string, deviceId: approve.body.id as string };
  }

  it("links a computer when Dave approves it while signed in, and hands the token over once", async () => {
    const start = await req("/api/desktop/link", { json: { name: "DAVE-PC" } });
    // Approving needs a signed-in session.
    expect((await req(`/api/desktop/link/${start.body.code}`)).status).toBe(401);
    expect((await req(`/api/desktop/link/${start.body.code}/approve`, { method: "POST" })).status).toBe(401);
    expect((await req(`/api/desktop/link/${start.body.code}`, { cookie })).body).toMatchObject({ name: "DAVE-PC", approved: false });

    const approve = await req(`/api/desktop/link/${start.body.code}/approve`, { method: "POST", cookie });
    expect(approve.body).toMatchObject({ name: "DAVE-PC" });
    expect((await req(`/api/desktop/link/${start.body.code}/approve`, { method: "POST", cookie })).status).toBe(409);

    const poll = await req("/api/desktop/link/poll", { json: { pollToken: start.body.pollToken } });
    expect(poll.body.token).toMatch(/^ccd_/);
    expect((await req("/api/desktop/link/poll", { json: { pollToken: start.body.pollToken } })).body).toEqual({ status: "expired" });
    expect((await req("/api/desktop/link/poll", { json: { pollToken: "made-up" } })).body).toEqual({ status: "expired" });
    expect((await req("/api/desktop/link/NOPE-NOPE/approve", { method: "POST", cookie })).status).toBe(404);

    const devices = (await req("/api/desktop/devices", { cookie })).body;
    expect(devices.map((d: any) => d.name)).toContain("DAVE-PC");
  });

  it("lets a linked computer's worker connect and upload, until it is unlinked", async () => {
    const { token, deviceId } = await link("Studio PC");
    // The device token is only a worker credential, never an API sign-in.
    expect((await req("/api/nodes", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const upload = { name: "out.mp4", contentType: "video/mp4", size: 10, folder: "renders" };
    expect((await req("/api/worker/storage/upload-session", { json: upload, headers: { authorization: `Bearer ${token}` } })).status).not.toBe(401);
    expect((await req("/api/worker/storage/upload-session", { json: upload, headers: { authorization: "Bearer ccd_made-up" } })).status).toBe(401);

    const net = await serveServer(ctx.server);
    try {
      const wsUrl = `${net.url.replace(/^http/, "ws")}/ws`;
      const ws = new WebSocket(wsUrl);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })));
      const welcomed = new Promise<void>((resolve) => {
        ws.onmessage = (e) => JSON.parse(String(e.data)).type === "welcome" && resolve();
      });
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "worker", token, node: { id: "studio-node", name: "Studio PC", capabilities: ["ffmpeg"] } }));
      await welcomed;
      const device = (await req("/api/desktop/devices", { cookie })).body.find((d: any) => d.id === deviceId);
      expect(device.nodeId).toBe("studio-node");

      expect((await req(`/api/desktop/devices/${deviceId}`, { method: "DELETE", cookie })).body).toEqual({ revoked: true });
      expect(await closed).toMatchObject({ code: 4003 });
      expect((await req(`/api/desktop/devices/${deviceId}`, { method: "DELETE", cookie })).status).toBe(404);

      // An unlinked token no longer works anywhere.
      const again = new WebSocket(wsUrl);
      const refused = new Promise<number>((resolve) => (again.onclose = (e) => resolve(e.code)));
      again.onopen = () => again.send(JSON.stringify({ type: "hello", role: "worker", token, node: { id: "studio-node", name: "Studio PC", capabilities: [] } }));
      expect(await refused).toBe(4003);
      expect((await req("/api/worker/storage/upload-session", { json: upload, headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      await net.close();
    }
  });

  it("serves the installer the Desktop workflow uploaded (GitHub OIDC), only to signed-in users", async () => {
    expect((await req("/api/desktop/installer", { cookie })).body).toEqual({ installer: null });
    expect((await req("/api/desktop/download", { cookie })).status).toBe(404);

    const file = Buffer.from("MZ fake installer bytes");
    const put = (token: string, query = "version=0.1.0&filename=Command%20Centre_0.1.0_x64-setup.exe&commit=abc1234") =>
      req(`/api/desktop/installer?${query}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: file });

    expect((await put(gh.token({ repository: "someone/else" }))).status).toBe(401);
    expect((await put(fakeGithub().token())).status).toBe(401);
    expect((await put(gh.token(), "version=0.1.0&filename=evil.sh")).status).toBe(400);
    const ok = await put(gh.token());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ version: "0.1.0", size: file.length, commit: "abc1234" });

    expect((await req("/api/desktop/installer", { cookie })).body.installer).toMatchObject({ filename: "Command Centre_0.1.0_x64-setup.exe" });
    expect((await req("/api/desktop/download")).status).toBe(401);
    const got = await req("/api/desktop/download", { cookie });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toBe('attachment; filename="Command Centre_0.1.0_x64-setup.exe"');
    expect(Buffer.from(got.body)).toEqual(file);

    // The admin token can upload too (e.g. a build made by hand).
    expect((await put(ADMIN, "version=0.1.1&filename=setup.exe")).status).toBe(201);
    expect((await req("/api/desktop/installer", { cookie })).body.installer.version).toBe("0.1.1");
  });
});
