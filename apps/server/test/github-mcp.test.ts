import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentRunRequest } from "@cc/agent-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGithubMcpServer, explainGithubError } from "../src/github-mcp";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

/** A fake GitHub API: routes by path, records requests. */
/** A route is a body (200), or `{ status, body }` for an error. */
function fakeGithub(routes: Record<string, unknown>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ url: path, auth: new Headers(init?.headers).get("authorization") });
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const r = hit[1] as { status?: number; body?: unknown };
    const [status, body] = typeof r?.status === "number" && "body" in r ? [r.status, r.body] : [200, hit[1]];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function connect(fetch: typeof globalThis.fetch) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createGithubMcpServer({ token: "ghp_secret", repo: "dms/cc", fetch }).connect(serverT);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientT);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: res.isError === true, text: res.content[0]!.text, json: () => JSON.parse(res.content[0]!.text) };
  };
}

describe("github MCP (read-only, the server's token)", () => {
  it("reports access, scoped to the role's repository, with the token only on the server's request", async () => {
    const gh = fakeGithub({ "/repos/dms/cc": { full_name: "dms/cc", default_branch: "main", private: true, permissions: { pull: true, push: true } } });
    const call = await connect(gh.fetch);
    expect((await call("access")).json()).toEqual({ repo: "dms/cc", defaultBranch: "main", private: true, permissions: { pull: true, push: true } });
    expect(gh.calls[0]).toEqual({ url: "/repos/dms/cc", auth: "Bearer ghp_secret" });
  });

  it("gives a pull request with its CI checks, reviews and comments", async () => {
    const gh = fakeGithub({
      "/repos/dms/cc/pulls/7/reviews": [{ user: { login: "dave" }, state: "CHANGES_REQUESTED", body: "Rename it", submitted_at: "t" }],
      "/repos/dms/cc/pulls/7/comments": [{ user: { login: "dave" }, path: "a.ts", line: 3, body: "here", created_at: "t" }],
      "/repos/dms/cc/pulls/7": { number: 7, title: "Fix", state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { ref: "cc/fix", sha: "abc" }, base: { ref: "main" }, html_url: "u", body: "why" },
      "/repos/dms/cc/commits/abc/check-runs": { check_runs: [{ id: 9, name: "check", status: "completed", conclusion: "failure", html_url: "c" }] },
      "/repos/dms/cc/issues/7/comments": [{ user: { login: "bot" }, body: "CI failed", created_at: "t" }],
    });
    const call = await connect(gh.fetch);
    const pr = (await call("pull_request", { number: 7 })).json();
    expect(pr).toMatchObject({ number: 7, mergeable: true, branch: "cc/fix", headSha: "abc" });
    expect(pr.checks).toEqual([{ id: 9, name: "check", status: "completed", conclusion: "failure", url: "c" }]);
    expect(pr.reviews[0]).toMatchObject({ by: "dave", state: "CHANGES_REQUESTED" });
    expect(pr.reviewComments[0]).toMatchObject({ path: "a.ts", line: 3 });
    expect(pr.comments[0]).toMatchObject({ by: "bot", body: "CI failed" });
  });

  it("lists issues without pull requests", async () => {
    const gh = fakeGithub({ "/repos/dms/cc/issues": [{ number: 1, title: "Bug", state: "open", labels: [{ name: "bug" }], user: { login: "d" } }, { number: 2, title: "PR", pull_request: {} }] });
    const call = await connect(gh.fetch);
    expect((await call("list_issues")).json()).toEqual([{ number: 1, title: "Bug", state: "open", labels: ["bug"], author: "d" }]);
  });

  it("explains a token GitHub refuses, so the agent can tell Dave the fix", async () => {
    const call = await connect(fakeGithub({ "/repos/dms/cc": { status: 401, body: { message: "Bad credentials" } } }).fetch);
    const res = await call("access");
    expect(res.error).toBe(true);
    expect(res.text).toMatch(/GitHub rejected GITHUB_TOKEN \(401\).*Railway/);
    expect(explainGithubError(404, "Not Found", "dms/cc")).toMatch(/Repository access/);
    expect(explainGithubError(403, "Resource not accessible by personal access token", "dms/cc")).toMatch(/read access to Pull requests/);
  });
});


describe.skipIf(!DB_URL)("github MCP for the Software Lead's runs (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const requests: AgentRunRequest[] = [];
  let accessResult = "";
  const gh = fakeGithub({ "/repos/desktopmachineshop/command-centre-": { full_name: "desktopmachineshop/command-centre-", default_branch: "main", private: true, permissions: { pull: true, push: true } } });
  const runner = {
    name: "github-probe",
    async run(request: AgentRunRequest) {
      requests.push(request);
      if (request.mcpServers?.github) {
        const probe = new McpCallingRunner([{ server: "github", tool: "access", args: {} }]);
        probe.app = ctx.server.app;
        accessResult = (await probe.run(request)).result;
      }
      return { status: "succeeded" as const, result: "ok", error: null, costUsd: 0, sessionId: null };
    },
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    // A token is set; the clone itself goes to a path that doesn't exist (no network in tests).
    ctx = await makeServer({ runner, overrides: { code: { token: "ghp_test", gitBase: "/nonexistent-github", apiBase: "https://api.test", fetch: gh.fetch } } });
  });
  afterAll(async () => ctx?.server.stop());

  it("lets the Software Lead read its repository through the server's token, and no other role", async () => {
    await ctx.api("/api/chat", { method: "POST", json: { text: "software: is CI green on the last PR?" } });
    await ctx.queue.drain();
    const lead = requests.at(-1)!;
    expect(Object.keys(lead.mcpServers ?? {})).toContain("github");
    expect(lead.allowedTools).toContain("mcp__github");
    expect(lead.systemPrompt).toContain('use the "github" tools');
    expect(JSON.parse(accessResult)[0].text).toContain('"repo":"desktopmachineshop/command-centre-"');
    expect(gh.calls.at(-1)?.auth).toBe("Bearer ghp_test");
    // The token never reaches the agent.
    expect(JSON.stringify(lead)).not.toContain("ghp_test");

    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } });
    await ctx.queue.drain();
    expect(Object.keys(requests.at(-1)!.mcpServers ?? {})).not.toContain("github");
  });
});
