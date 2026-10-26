import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

// An installed app must always fetch a fresh entry point, or it keeps running an old build.
describe.skipIf(!DB_URL)("web app caching", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "cc-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>cc</title>");
    writeFileSync(join(dist, "sw.js"), "// sw");
    writeFileSync(join(dist, "version.json"), '{"id":"abc123"}');
    writeFileSync(join(dist, "assets", "app-1234.js"), "console.log(1)");
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { WEB_DIST_DIR: dist } });
  });
  afterAll(() => ctx.server.stop());

  const get = (path: string) => ctx.server.app.request(path);

  it("never caches the page, the service worker or the version", async () => {
    for (const path of ["/", "/index.html", "/sw.js", "/version.json", "/accounts"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    expect(await (await get("/version.json")).json()).toEqual({ id: "abc123" });
  });

  it("leaves hashed assets cacheable", async () => {
    const res = await get("/assets/app-1234.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
  });
});
