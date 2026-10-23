import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OdooAuthError, OdooClient, OdooHttpError, OdooRpcError, OdooTimeoutError } from "../src";
import { demoModels, FakeOdoo } from "../src/testing";

let odoo: FakeOdoo;
beforeAll(async () => {
  odoo = new FakeOdoo({ models: demoModels() });
  await odoo.start();
});
afterAll(() => odoo.stop());
beforeEach(() => {
  odoo.calls.length = 0;
  odoo.delayMs = 0;
});

const client = (over: Partial<ConstructorParameters<typeof OdooClient>[0]> = {}) =>
  new OdooClient({ url: `${odoo.url}/`, db: "testdb", username: "bot@example.com", apiKey: "test-api-key", ...over });

describe.each(["jsonrpc", "json2"] as const)("OdooClient (%s)", (api) => {
  it("authenticates and caches the uid", async () => {
    const c = client({ api });
    const [a, b] = await Promise.all([c.authenticate(), c.authenticate()]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    await c.searchRead("res.partner", [], ["name"]);
    await c.searchRead("res.partner", [], ["name"]);
    // jsonrpc logs in through `common` (not recorded); json2 looks the user up once.
    expect(odoo.calls.filter((x) => x.model === "res.users")).toHaveLength(api === "json2" ? 1 : 0);
  });

  it("search_reads with limit, order and domain", async () => {
    const rows = await client({ api }).searchRead("product.product", [["qty_available", ">", 0]], ["default_code"], { limit: 1, order: "default_code desc" });
    expect(rows).toEqual([{ id: 2, default_code: "SP-300W" }]);
    expect(odoo.calls.at(-1)).toMatchObject({ api, method: "search_read", params: { limit: 1, order: "default_code desc" } });
  });

  it("reads, counts, creates and writes", async () => {
    const c = client({ api });
    expect(await c.read("res.partner", [10], ["email"])).toEqual([{ id: 10, email: "jane@example.com" }]);
    expect(await c.searchCount("sale.order", [["state", "=", "sale"]])).toBe(1);
    const id = await c.create("res.partner", { name: `New ${api}` });
    expect(typeof id).toBe("number");
    expect(await c.write("res.partner", [id], { email: "new@example.com" })).toBe(true);
    expect((await c.read("res.partner", [id], ["name", "email"]))[0]).toMatchObject({ name: `New ${api}`, email: "new@example.com" });
  });

  it("calls arbitrary methods and reports field lists", async () => {
    const c = client({ api });
    expect(await c.call("res.partner", "message_post", [[10]], { body: "hi" })).toBeTypeOf("number");
    expect((await c.fields("res.partner"))?.has("mobile")).toBe(false);
    expect(await c.fields("helpdesk.ticket")).toBeNull();
  });

  it("classifies Odoo errors", async () => {
    const c = client({ api });
    const missingField = await c.searchRead("res.partner", [], ["mobile"]).catch((e) => e);
    expect(missingField).toBeInstanceOf(OdooRpcError);
    expect(missingField.kind).toBe("missing_field");
    const missingModel = await c.searchRead("helpdesk.ticket", [], ["name"]).catch((e) => e);
    expect(missingModel).toMatchObject({ kind: "missing_model" });
  });

  it("rejects a bad API key", async () => {
    await expect(client({ api, apiKey: "wrong" }).searchRead("res.partner", [], ["name"])).rejects.toBeInstanceOf(OdooAuthError);
  });

  it("times out", async () => {
    odoo.delayMs = 300;
    await expect(client({ api, timeoutMs: 50 }).authenticate()).rejects.toBeInstanceOf(OdooTimeoutError);
  });
});

describe("OdooClient transport", () => {
  it("sends JSON-RPC execute_kw with db, uid and key", async () => {
    const bodies: any[] = [];
    const fetchSpy: typeof fetch = async (url, init) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return fetch(url, init);
    };
    await client({ fetch: fetchSpy }).searchRead("res.partner", [["id", "=", 10]], ["name"]);
    expect(bodies[0].body.params).toEqual({ service: "common", method: "authenticate", args: ["testdb", "bot@example.com", "test-api-key", {}] });
    expect(bodies[1].url).toBe(`${odoo.url}/jsonrpc`);
    expect(bodies[1].body.params.args).toEqual(["testdb", 7, "test-api-key", "res.partner", "search_read", [[["id", "=", 10]]], { fields: ["name"] }]);
  });

  it("sends JSON-2 calls with a bearer key and named args", async () => {
    const seen: { url: string; headers: Headers; body: any }[] = [];
    const fetchSpy: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return fetch(url, init);
    };
    await client({ api: "json2", fetch: fetchSpy }).read("res.partner", [10], ["name"]);
    expect(seen[0]!.url).toBe(`${odoo.url}/json/2/res.partner/read`);
    expect(seen[0]!.headers.get("authorization")).toBe("bearer test-api-key");
    expect(seen[0]!.headers.get("x-odoo-database")).toBe("testdb");
    expect(seen[0]!.body).toEqual({ ids: [10], fields: ["name"] });
  });

  it("rejects bad logins, and retries login after a failure", async () => {
    await expect(client({ username: "nobody" }).authenticate()).rejects.toBeInstanceOf(OdooAuthError);
    let fail = true;
    const flaky: typeof fetch = async (url, init) => {
      if (fail) {
        fail = false;
        throw new TypeError("fetch failed");
      }
      return fetch(url, init);
    };
    const c = client({ fetch: flaky });
    await expect(c.authenticate()).rejects.toBeInstanceOf(OdooHttpError);
    expect(await c.authenticate()).toBe(7);
  });

  it("reports non-JSON responses as HTTP errors", async () => {
    const html: typeof fetch = async () => new Response("<html>502</html>", { status: 502 });
    await expect(client({ fetch: html }).authenticate()).rejects.toMatchObject({ name: "OdooHttpError", status: 502 });
  });
});
