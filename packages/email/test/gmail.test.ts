import { beforeEach, describe, expect, it } from "vitest";
import { configureEmailOAuth, createEmailExecutors, EmailAccount } from "../src";

const gmail = EmailAccount.parse({
  id: "gshop",
  vertical: "dms",
  address: "shop@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, secure: true, user: "shop@gmail.com" },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "shop@gmail.com" },
  oauth: { provider: "google", clientId: "cid", clientSecret: "cs", refreshToken: "rt-label" },
});
const passwordInbox = EmailAccount.parse({
  id: "plain",
  vertical: "dms",
  address: "info@example.com",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "u", pass: "p" },
  smtp: { host: "smtp.example.com", port: 465, secure: true, user: "u", pass: "p" },
});

let calls: { method: string; path: string; body: any }[];
let modifyFails = false;
beforeEach(() => {
  calls = [];
  modifyFails = false;
  const labels = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "Label_9", name: "Suppliers", type: "user" },
  ];
  configureEmailOAuth({
    googleToken: "https://google.test/token",
    gmailApi: "https://gmail.test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === "google.test") return Response.json({ access_token: "at", expires_in: 3600 });
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? "GET", path: `${path}${url.search}`, body });
      if (path === "/messages/send") return Response.json({ id: "sent-1" });
      if (path === "/messages") return Response.json(url.searchParams.get("q")?.includes("missing") ? {} : { messages: [{ id: "m1", threadId: "t9" }] });
      if (path === "/labels" && init?.method === "POST") return Response.json({ id: "Label_new", name: body.name, type: "user" });
      if (path === "/labels") return Response.json({ labels });
      if (path.endsWith("/modify")) return modifyFails ? Response.json({ error: { message: "Insufficient Permission" } }, { status: 403 }) : Response.json({});
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch,
  });
});

const ex = () => createEmailExecutors([gmail, passwordInbox], { connect: async () => { throw new Error("no IMAP"); } });
const modifies = () => calls.filter((c) => c.path.endsWith("/modify"));

describe("email.label (Gmail)", () => {
  it("matches labels case-insensitively, creates missing ones, and archives the conversation", async () => {
    const result = await ex()["email.label"].execute({ accountId: "gshop", messageId: "<a1@x.com>", labels: ["suppliers", " Shop / Invoices "], archive: true });
    expect(result).toEqual({ threadId: "t9", labels: ["suppliers", "Shop / Invoices"], createdLabels: ["Shop/Invoices"], archived: true });
    expect(calls[0]!.path).toBe(`/messages?q=${encodeURIComponent("rfc822msgid:a1@x.com")}&maxResults=1`);
    expect(modifies()).toEqual([{ method: "POST", path: "/threads/t9/modify", body: { addLabelIds: ["Label_9", "Label_new"], removeLabelIds: ["INBOX"] } }]);
  });

  it("can just archive, or just label", async () => {
    await ex()["email.label"].execute({ accountId: "gshop", messageId: "a2@x.com", archive: true });
    await ex()["email.label"].execute({ accountId: "gshop", messageId: "a3@x.com", labels: ["Suppliers"] });
    expect(modifies().map((c) => c.body)).toEqual([
      { addLabelIds: [], removeLabelIds: ["INBOX"] },
      { addLabelIds: ["Label_9"], removeLabelIds: [] },
    ]);
  });

  it("refuses Gmail's own labels, unknown messages and non-Gmail inboxes, and checks payloads when proposed", async () => {
    await expect(ex()["email.label"].execute({ accountId: "gshop", messageId: "a4@x.com", labels: ["Trash"] })).rejects.toThrow(/system label/);
    await expect(ex()["email.label"].execute({ accountId: "gshop", messageId: "missing@x.com", archive: true })).rejects.toThrow(/No message with Message-ID <missing@x.com>/);
    expect(modifies()).toHaveLength(0);
    const { validate } = ex()["email.label"];
    expect(() => validate!({ accountId: "gshop", messageId: "a5@x.com" })).toThrow(/labels and\/or archive/);
    expect(() => validate!({ accountId: "plain", messageId: "a5@x.com", archive: true })).toThrow(/isn't a Gmail inbox/);
    expect(() => validate!({ accountId: "gshop", messageId: "a5@x.com", labels: ["a", "b", "c", "d", "e", "f"] })).toThrow(/labels/);
    expect(() => validate!({ accountId: "gshop", messageId: "a5@x.com", labels: ["Orders"] })).not.toThrow();
  });
});

describe("email.reply with labels/archive", () => {
  const reply = { accountId: "gshop", to: "jane@example.com", subject: "Order", body: "Shipped.", inReplyTo: "<q1@x.com>", labels: ["Customers"], archive: true };

  it("files the conversation once the reply has gone", async () => {
    const result = (await ex()["email.reply"].execute(reply)) as any;
    expect(calls[0]!.path).toBe("/messages/send");
    expect(result.filed).toMatchObject({ threadId: "t9", archived: true, createdLabels: ["Customers"] });
    expect(modifies()[0]!.body).toEqual({ addLabelIds: ["Label_new"], removeLabelIds: ["INBOX"] });
  });

  it("still succeeds (the reply has gone) when filing fails, and says why", async () => {
    modifyFails = true;
    const result = (await ex()["email.reply"].execute(reply)) as any;
    expect(result.messageId).toBeTruthy();
    expect(result.fileError).toMatch(/Insufficient Permission/);
  });
});
