import type { AgentRunRequest } from "@cc/agent-runtime";
import { MemoryMailbox } from "@cc/email";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

type Call = { server: string; tool: string; args: Record<string, unknown> };

const mailbox = (address: string) => ({
  address,
  imap: { host: "imap.test", port: 993, secure: true, user: "u", pass: "p" },
  smtp: { host: "127.0.0.1", port: 2525, secure: false, user: "u", pass: "p" },
});

/**
 * Regression: asked in chat to file the supplier price lists, the Chief of Staff handed off down
 * the chain and the last role could not read the mail (no role had a mail tool, and attachments
 * never reached any prompt). The read-only /mcp/mail server fixes that, scoped to the run's
 * business, and reading mail makes the rest of the run untrusted.
 */
describe.skipIf(!DB_URL)("mail MCP server", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const box = new MemoryMailbox();
  let calls: Call[] = [];
  const seen: { role: string | undefined; servers: string[]; result: string }[] = [];

  const runner = {
    name: "mail-test",
    async run(request: AgentRunRequest) {
      const agent = new McpCallingRunner(calls.filter((c) => request.mcpServers?.[c.server]));
      agent.app = ctx.server.app;
      const out = await agent.run(request);
      seen.push({ role: request.cwd?.split("/").at(-1), servers: Object.keys(request.mcpServers ?? {}), result: out.result });
      return out;
    },
  };

  const chat = async (text: string, script: Call[]) => {
    calls = script;
    const res = await ctx.api("/api/chat", { method: "POST", json: { text } });
    await ctx.queue.drain();
    const taskId = (res.body as { task?: { id: string } }).task?.id;
    return { last: seen.at(-1)!, detail: taskId ? (await ctx.api(`/api/tasks/${taskId}`)).body : null };
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    box.deliver(
      await new MailComposer({
        from: "Arc Euro Trade <sales@arceurotrade.co.uk>",
        to: "support@desktopmachineshop.com",
        subject: "Price list November 2026",
        messageId: "<pricelist@arceurotrade.co.uk>",
        text: "New prices attached.",
        attachments: [{ filename: "prices.csv", content: "Code,Price\nAET-ER11-7,18.40\n", contentType: "text/csv" }],
      })
        .compile()
        .build(),
    );
    const accounts = [
      { id: "shop", vertical: "dms", ...mailbox("support@desktopmachineshop.com") },
      { id: "home", vertical: "personal", ...mailbox("dave@example.com") },
    ];
    ctx = await makeServer({
      runner,
      env: { EMAIL_ACCOUNTS: JSON.stringify(accounts), EMAIL_POLL_INTERVAL_SECONDS: "60" },
      overrides: { imap: box.connector },
    });
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });

  it("lets Ops & Admin find a price list and read its attachment from a chat", async () => {
    const { last } = await chat("pricelists: file the Arc Euro price list", [
      { server: "mail", tool: "list_mail_accounts", args: {} },
      { server: "mail", tool: "search_mail", args: { subject: "price list", withAttachments: true } },
      { server: "mail", tool: "read_attachment", args: { accountId: "shop", messageId: "<pricelist@arceurotrade.co.uk>" } },
    ]);
    expect(last.role).toBe("ops-admin");
    expect(last.servers).toContain("mail");
    // Only the DMS mailbox: a DMS role can't read the personal one.
    expect(last.result).toContain("support@desktopmachineshop.com");
    expect(last.result).not.toContain("dave@example.com");
    expect(last.result).toContain("AET-ER11-7,18.40");
  });

  it("gives the Chief of Staff every mailbox, and drafts its proposals once it has read mail", async () => {
    const notify = { server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Price list", payload: { title: "Price list", body: "Filed" } } };
    const before = await chat("cos: tell me something", [notify]);
    expect(before.detail.proposals[0]).toMatchObject({ actionType: "notify", policy: "auto-with-digest" });

    const after = await chat("cos: any price lists in?", [{ server: "mail", tool: "list_mail_accounts", args: {} }, { server: "mail", tool: "search_mail", args: { subject: "price" } }, notify]);
    expect(after.last.role).toBe("chief-of-staff");
    expect(after.last.result).toContain("dave@example.com");
    expect(after.last.result).toContain("support@desktopmachineshop.com");
    const [proposal] = after.detail.proposals;
    expect(proposal).toMatchObject({ actionType: "notify", policy: "draft", status: "pending" });
    expect(proposal.payload.policyDowngrade.reason).toMatch(/untrusted email/);
  });

  it("refuses /mcp/mail to roles without it", async () => {
    const { last } = await chat("calendar: remind me to call the bank", [{ server: "mail", tool: "list_mail_accounts", args: {} }]);
    expect(last.role).toBe("calendar-reminders");
    expect(last.servers).not.toContain("mail");
  });
});
