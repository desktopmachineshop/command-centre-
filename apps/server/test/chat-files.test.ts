import { readFileSync } from "node:fs";
import { ScriptedRunner } from "@cc/agent-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!DB_URL)("files attached in the chat box (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ScriptedRunner();

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    runner.calls.length = 0;
  });

  const upload = async (name: string, body: Buffer | string, type: string, auth = `Bearer ${ADMIN}`) => {
    const res = await ctx.server.app.request(`/api/chat/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body,
      headers: { authorization: auth, "content-type": type },
    });
    return { status: res.status, body: (await res.json()) as { id: string; name: string; size: number; contentType: string } };
  };

  it("needs auth, and refuses empty files", async () => {
    expect((await upload("a.txt", "hi", "text/plain", "Bearer nope")).status).toBe(401);
    expect((await upload("empty.txt", "", "text/plain")).status).toBe(400);
  });

  it("hands a new chat's files to the agent: a readable copy and the text of text files", async () => {
    const csv = await upload("prices.csv", "part,price\nER11 collet,12.50\n", "text/csv");
    expect(csv.status).toBe(201);
    expect(csv.body).toMatchObject({ name: "prices.csv", contentType: "text/csv", size: 29, id: expect.stringMatching(/^[a-f0-9]{32}\.csv$/) });
    const png = await upload("photo.png", PNG, "image/png");
    expect(png.status).toBe(201);

    const { status, body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: check these prices", files: [csv.body.id, png.body.id] } });
    expect(status).toBe(201);
    expect(body.event.payload.files).toEqual([
      { id: csv.body.id, name: "prices.csv", contentType: "text/csv", size: 29 },
      { id: png.body.id, name: "photo.png", contentType: "image/png", size: PNG.length },
    ]);
    await ctx.queue.drain();

    const request = runner.calls[0]!;
    expect(request.prompt).toMatch(/^dms: check these prices\n\nDave attached 2 files to this message\./);
    expect(request.prompt).toContain("ER11 collet,12.50");
    const path = /On disk at (\S+): it is attached to this message/.exec(request.prompt)?.[1];
    expect(path).toBeTruthy();
    expect(readFileSync(path!)).toEqual(PNG);
    // The image goes with the prompt too, for a runner without a Read tool (Codex); the CSV doesn't.
    expect(request.images).toEqual([path]);
    // Runs of work Dave started may read the copies, and only those.
    expect(request.allowedTools).toContain(`Read(/${path!.slice(0, path!.lastIndexOf("/"))}/**)`);
    // The files are listed on the Storage page under attachments.
    const listed = (await ctx.api("/api/storage?folder=attachments")).body.files.map((f: { id: string }) => f.id);
    expect(listed).toEqual(expect.arrayContaining([csv.body.id, png.body.id]));
  });

  it("hands a reply's files to the agent, and marks them in the conversation", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: draft a quote" } });
    await ctx.queue.drain();
    const notes = await upload("notes.txt", "Customer wants 50 units by Friday.", "text/plain");
    const reply = await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "Use these notes", files: [notes.body.id] } });
    expect(reply.status).toBe(202);
    await ctx.queue.drain();

    expect(runner.calls.at(-1)!.prompt).toContain("Dave replies: Use these notes\n\nDave attached a file to this message.");
    expect(runner.calls.at(-1)!.prompt).toContain("Customer wants 50 units by Friday.");
    const detail = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(detail.runs[1].messages[0]).toEqual({ type: "system", text: "Dave replied: Use these notes [attached: notes.txt]" });
    expect(runner.calls.at(-1)!.images).toBeUndefined();

    const shot = await upload("screenshot.png", PNG, "image/png");
    await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "And this screenshot", files: [shot.body.id] } });
    await ctx.queue.drain();
    expect(runner.calls.at(-1)!.images).toEqual([expect.stringMatching(new RegExp(`/chat-files/${shot.body.id}$`))]);
  });

  it("hands Dave's files on with a handoff", async () => {
    const png = await upload("drawing.png", PNG, "image/png");
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: quote this part", files: [png.body.id] } });
    await ctx.queue.drain();
    const { task } = await ctx.server.pipeline.handoff(body.task.id, "3dpandme/blog-writer", "Write up this part");
    await ctx.queue.drain();
    const request = runner.calls.find((c) => c.prompt.includes(`(task ${body.task.id})`) && c.prompt.startsWith("Handoff"))!;
    expect(request.images).toEqual([expect.stringMatching(new RegExp(`/chat-files/${png.body.id}$`))]);
    expect(request.prompt).toContain("drawing.png");
    expect((await ctx.api(`/api/tasks/${task.id}`)).body.task.status).toBe("done");
  });

  it("refuses ids that aren't chat files", async () => {
    expect((await ctx.api("/api/chat", { method: "POST", json: { text: "hi", files: ["0".repeat(32)] } })).status).toBe(400);
    expect((await ctx.api("/api/chat", { method: "POST", json: { text: "hi", files: ["../etc/passwd"] } })).status).toBe(400);
  });
});
