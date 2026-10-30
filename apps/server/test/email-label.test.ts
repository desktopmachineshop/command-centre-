import { configureEmailOAuth, MemoryMailbox } from "@cc/email";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Google's token endpoint and the Gmail API, faked: one user label, Inbox and Spam. */
function fakeGmail() {
  const calls: { method: string; path: string; body: any }[] = [];
  const labels = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
    { id: "Label_1", name: "Customers", type: "user" },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "google.test") return Response.json({ access_token: "g-at", expires_in: 3600 });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: `${path}${url.search}`, body });
    if (path === "/messages") return Response.json({ messages: [{ id: "m1", threadId: "t1" }] });
    if (path === "/labels" && init?.method === "POST") {
      const label = { id: `Label_${labels.length}`, name: body.name, type: "user" };
      labels.push(label);
      return Response.json(label);
    }
    if (path === "/labels") return Response.json({ labels });
    if (path.endsWith("/modify")) return Response.json({ id: "t1" });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  configureEmailOAuth({ fetch, googleToken: "https://google.test/token", gmailApi: "https://gmail.test" });
  return calls;
}

describe.skipIf(!DB_URL)("filing email in Gmail (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const mailbox = new MemoryMailbox();
  const label = (messageId: string, labels: string[]) => ({
    server: "actions",
    tool: "propose_action",
    args: { actionType: "email.label", summary: `File ${messageId}`, payload: { accountId: "gshop", messageId, labels, archive: true } },
  });
  const runner = new McpCallingRunner([label("<n1@example.com>", ["Customers", "Shop/Orders"]), label("<someone-else@example.com>", ["Customers"])]);
  let gmail: ReturnType<typeof fakeGmail>;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    const account = {
      id: "gshop",
      vertical: "dms",
      address: "shop@desktopmachineshop.com",
      imap: { host: "imap.gmail.com", port: 993, secure: true, user: "shop@desktopmachineshop.com" },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "shop@desktopmachineshop.com" },
      oauth: { provider: "google", clientId: "cid", clientSecret: "cs", refreshToken: "rt" },
    };
    ctx = await makeServer({
      runner,
      env: { EMAIL_ACCOUNTS: JSON.stringify([account]), EMAIL_POLL_INTERVAL_SECONDS: "60" },
      overrides: { imap: mailbox.connector },
    });
    gmail = fakeGmail();
    runner.app = ctx.server.app;
    await waitFor(() => ctx.server.store.getEmailCheckpoint("gshop"));
  });
  afterAll(async () => {
    await ctx?.server.stop();
    configureEmailOAuth({ fetch: (i, init) => fetch(i, init), googleToken: "https://oauth2.googleapis.com/token", gmailApi: "https://gmail.googleapis.com" });
  });

  it("labels and archives the email that started the task straight away, but holds labelling any other email for approval", async () => {
    const raw = await new MailComposer({ from: "Sam <sam@example.com>", to: "shop@desktopmachineshop.com", subject: "Order 1042", messageId: "<n1@example.com>", text: "Where is my order?" })
      .compile()
      .build();
    mailbox.deliver(raw);
    const task = await waitFor(async () => ((await ctx.api("/api/tasks")).body as any[]).find((t) => t.status === "awaiting_approval"));
    const { proposals } = (await ctx.api(`/api/tasks/${task.id}`)).body as { proposals: any[] };

    const own = proposals.find((p) => p.payload.messageId === "<n1@example.com>");
    expect(own).toMatchObject({ actionType: "email.label", policy: "auto", status: "executed" });
    expect(own.result.result).toMatchObject({ threadId: "t1", archived: true, createdLabels: ["Shop/Orders"] });
    const other = proposals.find((p) => p.payload.messageId === "<someone-else@example.com>");
    expect(other).toMatchObject({ policy: "draft", status: "pending" });
    expect(other.payload.policyDowngrade.reason).toContain("untrusted email input");

    expect(gmail.find((c) => c.path.startsWith("/messages?"))?.path).toContain(encodeURIComponent("rfc822msgid:n1@example.com"));
    expect(gmail.find((c) => c.method === "POST" && c.path === "/labels")?.body).toMatchObject({ name: "Shop/Orders" });
    expect(gmail.filter((c) => c.path === "/threads/t1/modify").map((c) => c.body)).toEqual([{ addLabelIds: ["Label_1", "Label_3"], removeLabelIds: ["INBOX"] }]);
  });
});
