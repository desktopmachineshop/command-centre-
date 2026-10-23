import { describe, expect, it } from "vitest";
import {
  emailPrompt,
  isIgnoredSender,
  MAX_BODY_CHARS,
  parseEmail,
  parseEmailAccounts,
  shouldSaveSent,
  stripQuotedHistory,
} from "../src";
import { account, rawEmail } from "./fixtures";

describe("parseEmail", () => {
  it("parses a multipart message with an attachment into a compact payload", async () => {
    const raw = await rawEmail({
      from: '"Jane Doe" <Jane@Example.com>',
      to: "Support <support@desktopmachineshop.com>",
      cc: "bob@example.com",
      replyTo: "jane.orders@example.com",
      subject: "ER11 collets",
      messageId: "<abc123@example.com>",
      inReplyTo: "<prev@desktopmachineshop.com>",
      references: ["<first@example.com>", "<prev@desktopmachineshop.com>"],
      text: "Do you stock the 7-piece ER11 set?\n\nThanks, Jane",
      html: "<p>Do you stock the <b>7-piece</b> ER11 set?</p><p>Thanks, Jane</p>",
      attachments: [{ filename: "spindle.jpg", content: Buffer.alloc(2048, 1), contentType: "image/jpeg" }],
    });
    const p = await parseEmail(raw);
    expect(p).toMatchObject({
      from: { name: "Jane Doe", address: "jane@example.com" },
      replyTo: [{ address: "jane.orders@example.com" }],
      to: [{ name: "Support", address: "support@desktopmachineshop.com" }],
      cc: [{ name: "", address: "bob@example.com" }],
      subject: "ER11 collets",
      date: "2026-10-20T09:30:00.000Z",
      messageId: "<abc123@example.com>",
      inReplyTo: "<prev@desktopmachineshop.com>",
      references: ["<first@example.com>", "<prev@desktopmachineshop.com>"],
      text: "Do you stock the 7-piece ER11 set?\n\nThanks, Jane",
      quotedHistoryStripped: false,
      truncated: false,
      attachments: [{ filename: "spindle.jpg", contentType: "image/jpeg", size: 2048 }],
    });
    // Attachment content never reaches the payload.
    expect(JSON.stringify(p).length).toBeLessThan(1500);
  });

  it("converts an HTML-only message and drops the Gmail quote", async () => {
    const raw = await rawEmail({
      from: "Jane <jane@example.com>",
      to: "support@desktopmachineshop.com",
      subject: "Re: ER11 collets",
      html:
        '<div dir="ltr">Thanks, that <b>works</b>!<br><br>Jane</div><br>' +
        '<div class="gmail_quote"><div class="gmail_attr">On Mon, 20 Oct 2026 at 10:00, Dave &lt;support@desktopmachineshop.com&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote">Try the 7-piece set.<br></blockquote></div>',
    });
    const p = await parseEmail(raw);
    expect(p.text).toContain("Thanks, that works!");
    expect(p.text).not.toContain("7-piece");
    expect(p.text).not.toContain("<b>");
    expect(p.quotedHistoryStripped).toBe(true);
  });

  it("truncates very long bodies", async () => {
    const p = await parseEmail(await rawEmail({ from: "a@b.com", to: "c@d.com", subject: "log", text: "x".repeat(50_000) }));
    expect(p.truncated).toBe(true);
    expect(p.text.length).toBeLessThan(MAX_BODY_CHARS + 50);
  });
});

describe("stripQuotedHistory", () => {
  it("cuts at a wrapped 'On ... wrote:' line", () => {
    const { text, stripped } = stripQuotedHistory(
      "Yes please, send two.\n\nJane\n\nOn Mon, 20 Oct 2026 at 10:00, Dave <support@\ndesktopmachineshop.com> wrote:\n> Shall I send two?\n> Dave",
    );
    expect(stripped).toBe(true);
    expect(text).toBe("Yes please, send two.\n\nJane");
  });

  it("cuts at an Outlook header block", () => {
    const { text } = stripQuotedHistory(
      "Order 1234 has arrived, thanks.\n\n________________________________\nFrom: Dave <support@desktopmachineshop.com>\nSent: 20 October 2026 10:00\nTo: Jane\nSubject: Your order",
    );
    expect(text).toBe("Order 1234 has arrived, thanks.");
  });

  it("drops a trailing '>' block but keeps inline quotes", () => {
    const { text } = stripQuotedHistory("> Which size?\n6mm.\n\n> old line 1\n> old line 2\n");
    expect(text).toBe("> Which size?\n6mm.");
  });

  it("keeps a message that is all quote", () => {
    expect(stripQuotedHistory("> forwarded text").text).toBe("> forwarded text");
    expect(stripQuotedHistory("Plain message.").stripped).toBe(false);
  });
});

describe("accounts", () => {
  it("validates EMAIL_ACCOUNTS with defaults", () => {
    const [a] = parseEmailAccounts(JSON.stringify([{ ...account(), mailbox: undefined, ignoreFrom: undefined }]));
    expect(a).toMatchObject({ id: "shop", mailbox: "INBOX", ignoreFrom: [] });
    expect(parseEmailAccounts("")).toEqual([]);
    expect(() => parseEmailAccounts("[{")).toThrow(/not valid JSON/);
    expect(() => parseEmailAccounts(JSON.stringify([{ id: "x" }]))).toThrow(/EMAIL_ACCOUNTS is invalid: 0\.vertical/);
    expect(() => parseEmailAccounts(JSON.stringify([account(), account()]))).toThrow(/unique/);
  });

  it("ignores the account's own address and ignoreFrom rules", () => {
    const a = account({ ignoreFrom: ["noreply@odoo.com", "@mailchimp.com"] });
    expect(isIgnoredSender(a, "support@desktopmachineshop.com")).toBe(true);
    expect(isIgnoredSender(a, "noreply@odoo.com")).toBe(true);
    expect(isIgnoredSender(a, "news@mailchimp.com")).toBe(true);
    expect(isIgnoredSender(a, "jane@example.com")).toBe(false);
  });

  it("saves to Sent except where Gmail does it already", () => {
    expect(shouldSaveSent(account())).toBe(true);
    const gmail = account({ smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "u", pass: "p" } });
    expect(shouldSaveSent(gmail)).toBe(false);
    expect(shouldSaveSent({ ...gmail, saveSent: true })).toBe(true);
  });
});

describe("emailPrompt", () => {
  it("shows headers, then body, then how to reply", async () => {
    const p = await parseEmail(
      await rawEmail({
        from: "Jane Doe <jane@example.com>",
        to: "support@desktopmachineshop.com",
        subject: "ER11 collets",
        messageId: "<abc@example.com>",
        text: "Do you stock them?",
      }),
    );
    const prompt = emailPrompt({ accountId: "shop", account: "support@desktopmachineshop.com", accountName: "Dave at DMS", ...p });
    expect(prompt.split("\n")[0]).toBe("Email from Jane Doe: ER11 collets");
    expect(prompt).toContain('Received at support@desktopmachineshop.com (account "shop").');
    expect(prompt).toContain("From: Jane Doe <jane@example.com>\nTo: support@desktopmachineshop.com");
    expect(prompt).toContain("Subject: ER11 collets\n\nDo you stock them?\n----- END EMAIL -----");
    expect(prompt).toContain('"email.reply"');
    expect(prompt).toContain('"accountId":"shop","to":"jane@example.com"');
    expect(prompt).toContain('"inReplyTo":"<abc@example.com>"');
    expect(prompt).toContain('Sign replies as "Dave at DMS".');
  });

  it("titles a nameless sender by address and a blank subject", () => {
    const prompt = emailPrompt({ accountId: "shop", from: { name: "", address: "bob@example.com" }, subject: "" });
    expect(prompt.split("\n")[0]).toBe("Email from bob@example.com: (no subject)");
  });
});
