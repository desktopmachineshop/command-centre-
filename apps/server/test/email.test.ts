import type { AddressInfo } from "node:net";
import { MemoryMailbox } from "@cc/email";
import MailComposer from "nodemailer/lib/mail-composer";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

/** In-process SMTP server that records raw messages. */
async function startSmtp() {
  const received: { to: string[]; raw: string }[] = [];
  const server = new SMTPServer({
    hideSTARTTLS: true,
    allowInsecureAuth: true,
    logger: false,
    onAuth: (auth, _session, cb) => cb(null, { user: auth.username }),
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString() });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { port, received, close: () => new Promise<void>((resolve) => server.close(resolve)) };
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const customerEmail = (messageId: string) =>
  new MailComposer({
    from: "Jane Doe <jane@example.com>",
    to: "support@desktopmachineshop.com",
    subject: "ER11 collets for a 300W spindle",
    messageId,
    references: ["<earlier@example.com>"],
    text: "Hi, do you stock the 7-piece ER11 set?\n\nThanks, Jane\n\nOn Mon, 20 Oct 2026, Dave wrote:\n> Anything else?",
  })
    .compile()
    .build();

describe.skipIf(!DB_URL)("email ingress and reply (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  const mailbox = new MemoryMailbox();
  const runner = new McpCallingRunner([
    {
      server: "actions",
      tool: "propose_action",
      args: {
        actionType: "email.reply",
        summary: "Reply to Jane about ER11 collets",
        payload: {
          accountId: "shop",
          to: "jane@example.com",
          subject: "ER11 collets for a 300W spindle",
          body: "Hi Jane,\n\nYes, the 7-piece set is in stock.\n\nDave",
          inReplyTo: "<q1@example.com>",
          references: ["<earlier@example.com>", "<q1@example.com>"],
        },
      },
    },
  ]);

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    smtp = await startSmtp();
    const account = {
      id: "shop",
      vertical: "dms",
      address: "support@desktopmachineshop.com",
      displayName: "Desktop Machine Shop",
      imap: { host: "imap.test", port: 993, secure: true, user: "u", pass: "p" },
      smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "u", pass: "p" },
    };
    ctx = await makeServer({
      runner,
      env: { EMAIL_ACCOUNTS: JSON.stringify([account]), EMAIL_POLL_INTERVAL_SECONDS: "60" },
      overrides: { imap: mailbox.connector },
    });
    runner.app = ctx.server.app;
    // The poller has connected once it has stored its starting checkpoint.
    await waitFor(() => ctx.server.store.getEmailCheckpoint("shop"));
  });
  afterAll(async () => {
    await ctx?.server.stop();
    await smtp?.close();
  });

  it("turns new mail into a task, and sends the approved reply", async () => {
    mailbox.deliver(await customerEmail("<q1@example.com>"));

    const task = await waitFor(async () => {
      const tasks = (await ctx.api("/api/tasks")).body as { id: string; status: string }[];
      return tasks.find((t) => t.status === "awaiting_approval");
    });
    const detail = (await ctx.api(`/api/tasks/${task.id}`)).body;
    expect(detail.task.vertical).toBe("dms");
    expect(detail.event).toMatchObject({
      source: "email",
      kind: "message",
      title: "Jane Doe: ER11 collets for a 300W spindle",
      dedupeKey: "email:shop:<q1@example.com>",
    });

    const request = runner.requests[0]!;
    expect(request.prompt).toContain("From: Jane Doe <jane@example.com>");
    expect(request.prompt).toContain("Hi, do you stock the 7-piece ER11 set?\n\nThanks, Jane\n----- END EMAIL -----");
    expect(request.prompt).not.toContain("Anything else?");
    expect(request.prompt).toContain('"inReplyTo":"<q1@example.com>"');
    expect(request.systemPrompt).toContain("- email.reply:");

    const [proposal] = detail.proposals;
    expect(proposal).toMatchObject({ actionType: "email.reply", policy: "draft", status: "pending" });
    expect(smtp.received).toHaveLength(0);

    const approved = await ctx.api(`/api/proposals/${proposal.id}/approve`, { method: "POST" });
    expect(approved.body).toMatchObject({ status: "executed", result: { ok: true, result: { savedTo: "Sent" } } });

    const sent = smtp.received[0]!;
    expect(sent.to).toEqual(["jane@example.com"]);
    expect(sent.raw).toMatch(/^Subject: Re: ER11 collets for a 300W spindle\r$/m);
    expect(sent.raw).toMatch(/^In-Reply-To: <q1@example\.com>\r$/m);
    expect(sent.raw).toMatch(/^References: <earlier@example\.com> <q1@example\.com>\r$/m);
    expect(sent.raw).toMatch(/^From: Desktop Machine Shop <support@desktopmachineshop\.com>\r$/m);
    expect(mailbox.sent).toHaveLength(1);
    expect((await ctx.api(`/api/tasks/${task.id}`)).body.task.status).toBe("done");
  });

  it("ingests a message only once, even if the mailbox shows it again", async () => {
    const before = ((await ctx.api("/api/events")).body as unknown[]).length;
    mailbox.deliver(await customerEmail("<q1@example.com>"));
    await waitFor(async () => (await ctx.server.store.getEmailCheckpoint("shop"))?.lastUid === 2);
    expect(((await ctx.api("/api/events")).body as unknown[]).length).toBe(before);
  });
});
