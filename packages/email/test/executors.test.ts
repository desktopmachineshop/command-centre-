import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailExecutors, MemoryMailbox, parseEmail, replyReferences, replySubject } from "../src";
import { account } from "./fixtures";
import { startSmtp } from "./smtp";

describe("reply helpers", () => {
  it("adds a single Re:", () => {
    expect(replySubject("ER11 collets")).toBe("Re: ER11 collets");
    expect(replySubject("RE: Re: ER11 collets")).toBe("Re: ER11 collets");
    expect(replySubject("Re[2]: ER11")).toBe("Re: ER11");
  });

  it("builds the References chain", () => {
    expect(replyReferences("b@x", "<a@x> <b@x>")).toEqual(["<a@x>", "<b@x>"]);
    expect(replyReferences("<c@x>", ["<a@x>", "b@x"])).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
    expect(replyReferences("<a@x>")).toEqual(["<a@x>"]);
  });
});

describe("email executors (in-process SMTP)", () => {
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  const mailbox = new MemoryMailbox();
  let executors: ReturnType<typeof createEmailExecutors>;

  beforeAll(async () => {
    smtp = await startSmtp();
    executors = createEmailExecutors(
      [
        account({ smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "u", pass: "p" } }),
        account({ id: "gmail", address: "dave@gmail.com", smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "u", pass: "p" } }),
      ],
      { connect: mailbox.connector, logger: { error: () => {} } },
    );
  });
  afterAll(async () => smtp?.close());

  it("sends a threaded reply and files it in Sent", async () => {
    const result = (await executors["email.reply"].execute({
      accountId: "shop",
      to: "jane@example.com",
      cc: ["bob@example.com"],
      subject: "ER11 collets",
      body: "Hi Jane,\n\nYes, the 7-piece set is in stock.\n\nDave at Desktop Machine Shop",
      inReplyTo: "<abc@example.com>",
      references: ["<first@example.com>"],
    })) as { messageId: string; accepted: string[]; savedTo: string };

    const msg = smtp.received.at(-1)!;
    expect(msg.from).toBe("support@desktopmachineshop.com");
    expect(msg.to.sort()).toEqual(["bob@example.com", "jane@example.com"]);
    expect(msg.user).toBe("u");
    expect(msg.raw).toMatch(/^In-Reply-To: <abc@example\.com>\r$/m);
    expect(msg.raw).toMatch(/^References: <first@example\.com> <abc@example\.com>\r$/m);
    expect(msg.raw).toMatch(/^Subject: Re: ER11 collets\r$/m);
    expect(msg.raw).toMatch(/^From: Dave at Desktop Machine Shop <support@desktopmachineshop\.com>\r$/m);

    const parsed = await parseEmail(msg.raw);
    expect(parsed.text).toContain("the 7-piece set is in stock");
    expect(parsed.messageId).toBe(result.messageId);
    expect(result).toMatchObject({ accepted: ["jane@example.com", "bob@example.com"], savedTo: "Sent" });
    expect(mailbox.sent.at(-1)!.toString()).toContain("In-Reply-To: <abc@example.com>");
  });

  it("sends a new message without threading headers", async () => {
    await executors["email.send"].execute({ accountId: "shop", to: "supplier@example.com", subject: "Restock", body: "Ten more please." });
    const msg = smtp.received.at(-1)!;
    expect(msg.to).toEqual(["supplier@example.com"]);
    expect(msg.raw).toMatch(/^Subject: Restock\r$/m);
    expect(msg.raw).not.toMatch(/^In-Reply-To:/m);
  });

  it("rejects bad payloads with clear errors", async () => {
    await expect(executors["email.reply"].execute({ accountId: "shop", to: "jane@example.com", subject: "x", body: "y" })).rejects.toThrow(
      /Invalid email\.reply payload: inReplyTo/,
    );
    await expect(executors["email.send"].execute({ accountId: "shop", to: "not-an-address", subject: "x", body: "y" })).rejects.toThrow(
      /Invalid email\.send payload: to/,
    );
    await expect(executors["email.send"].execute({ accountId: "nope", to: "a@b.com", subject: "x", body: "y" })).rejects.toThrow(
      /Unknown email accountId "nope". Configured: shop, gmail/,
    );
  });
});
