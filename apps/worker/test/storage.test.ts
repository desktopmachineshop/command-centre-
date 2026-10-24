import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageUploader, toHttpUrl } from "../src";

const CHUNK = 256 * 1024;
const TOKEN = "worker-token-0123456789abcdef";

/** A fake Command Centre speaking the worker storage API and the resumable chunk protocol. */
function fakeServer() {
  const state = { data: Buffer.alloc(0), size: 0, failNext: [] as ("reset" | 503)[], authOnUpload: [] as (string | undefined)[], requests: [] as string[] };
  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url!, "http://x");
    state.requests.push(`${req.method} ${url.pathname} ${req.headers["content-range"] ?? ""}`);
    const body = await buffer(req);
    const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname.startsWith("/api/worker/")) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
      if (url.pathname.endsWith("/upload-session")) {
        state.size = JSON.parse(body.toString()).size;
        const { port } = server.address() as AddressInfo;
        return json(201, { id: "a".repeat(32) + ".mp4", uploadUrl: `http://127.0.0.1:${port}/upload/s1?key=k`, chunkSize: CHUNK });
      }
      if (state.data.length !== state.size) return json(409, { error: "incomplete" });
      return json(200, { id: "a".repeat(32) + ".mp4", url: `https://cc.example/media/${"a".repeat(32)}.mp4`, size: state.size, contentType: "video/mp4", folder: "renders" });
    }
    if (url.pathname === "/upload/s1") {
      state.authOnUpload.push(req.headers.authorization);
      const fail = /^bytes \d/.test(req.headers["content-range"] ?? "") ? state.failNext.shift() : undefined;
      if (fail === "reset") {
        // Keep part of the chunk, then drop the connection before replying.
        state.data = Buffer.concat([state.data, body.subarray(0, 1000)]);
        return req.socket.destroy();
      }
      if (fail === 503) return json(503, { error: "busy" });
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers["content-range"] ?? "");
      if (m && Number(m[1]) === state.data.length) state.data = Buffer.concat([state.data, body]);
      if (state.data.length === state.size) return json(201, { ok: true });
      return res.writeHead(308, state.data.length ? { range: `bytes=0-${state.data.length - 1}` } : {}).end();
    }
    json(404, {});
  });
  return { server, state };
}

describe("worker storage uploader", () => {
  const { server, state } = fakeServer();
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("maps the worker's ws URL to the server's https origin", () => {
    expect(toHttpUrl("wss://cc.example.com/ws")).toBe("https://cc.example.com");
    expect(toHttpUrl("ws://localhost:8080/ws")).toBe("http://localhost:8080");
    expect(toHttpUrl("https://cc.example.com/")).toBe("https://cc.example.com");
  });

  it("uploads in chunks, resumes after a dropped connection and a 503, and returns the public URL", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cc-up-")), "render.mp4");
    const data = Buffer.from(Array.from({ length: CHUNK * 2 + 500 }, (_, i) => i % 253));
    writeFileSync(path, data);
    state.failNext = ["reset", 503];
    const progress: number[] = [];
    const uploader = createStorageUploader({ serverUrl: url, token: TOKEN, backoff: () => 0 });
    const result = await uploader.uploadFile(path, { onProgress: (f) => progress.push(f) });
    expect(result).toMatchObject({ url: `https://cc.example/media/${"a".repeat(32)}.mp4`, size: data.length, folder: "renders" });
    expect(state.data.equals(data)).toBe(true);
    expect(state.requests.some((r) => r.includes(`bytes */${data.length}`))).toBe(true); // asked where to resume
    expect(state.authOnUpload.every((a) => a === undefined)).toBe(true); // the token never goes to the upload URL
    expect(progress.at(-1)).toBe(1);
  });

  it("fails clearly with a bad token", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cc-up-")), "x.mp4");
    writeFileSync(path, "x");
    await expect(createStorageUploader({ serverUrl: url, token: "nope" }).uploadFile(path)).rejects.toThrow(/upload-session failed \(401\)/);
  });
});
