import { type EmailAccount, MemoryMailbox } from "@cc/email";
import MailComposer from "nodemailer/lib/mail-composer";
import { describe, expect, it } from "vitest";
import { ANSWERED_REASON, AnsweredElsewhere, replyTarget } from "../src/email-replies";

const account = (id: string) => ({ id, vertical: "dms", address: `${id}@example.com` }) as EmailAccount;
const reply = (id: string, accountId: string, inReplyTo: string) =>
  ({ id, actionType: "email.reply", status: "pending", payload: { accountId, inReplyTo, to: "jane@example.com", subject: "Re: x", body: "b" } }) as never;
const sentReply = (inReplyTo: string, references: string[] = []) =>
  new MailComposer({ from: "Dave <dave@example.com>", to: "jane@example.com", subject: "Re: x", inReplyTo, references, text: "Done, thanks." }).compile().build();

describe("suggested replies Dave already answered himself", () => {
  it("knows which email a pending reply answers", () => {
    expect(replyTarget(reply("p1", "shop", "<a@x>"))).toEqual({ accountId: "shop", messageId: "<a@x>" });
    expect(replyTarget({ actionType: "email.send", status: "pending", payload: {} } as never)).toBeNull();
    expect(replyTarget({ actionType: "email.reply", status: "executed", payload: { accountId: "shop", inReplyTo: "<a@x>" } } as never)).toBeNull();
  });

  it("withdraws the replies to emails answered from Sent (by In-Reply-To or References), and only those", async () => {
    const shop = new MemoryMailbox();
    const home = new MemoryMailbox();
    shop.sent.push(await sentReply("<answered@x>"));
    home.sent.push(await sentReply("<later@x>", ["<thread-start@x>", "<later@x>"]));
    home.sent.push(await sentReply("<other@x>", ["<thread-start@x>", "<other@x>"]));
    const withdrawn: [string, string][] = [];
    const watcher = new AnsweredElsewhere({
      listPending: async () => [
        reply("p1", "shop", "<answered@x>"),
        reply("p2", "shop", "<still-waiting@x>"),
        reply("p3", "home", "thread-start@x"), // answered further down its thread
        reply("p4", "gone", "<answered@x>"), // a mailbox that's no longer connected
        { id: "p5", actionType: "notify", status: "pending", payload: {} } as never,
      ],
      withdraw: async (id, reason) => {
        withdrawn.push([id, reason]);
        return { id } as never;
      },
      accounts: () => [account("shop"), account("home")],
      connect: async (a) => (a.id === "shop" ? shop : home).connector(a),
    });
    expect((await watcher.sweep()).map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(withdrawn).toEqual([
      ["p1", ANSWERED_REASON],
      ["p3", ANSWERED_REASON],
    ]);
  });

  it("carries on past a mailbox it can't reach", async () => {
    const ok = new MemoryMailbox();
    ok.sent.push(await sentReply("<b@x>"));
    const down = new MemoryMailbox();
    down.failConnects = 1;
    const lines: string[] = [];
    const watcher = new AnsweredElsewhere({
      listPending: async () => [reply("p1", "down", "<a@x>"), reply("p2", "ok", "<b@x>")],
      withdraw: async (id) => ({ id }) as never,
      accounts: () => [account("down"), account("ok")],
      connect: async (a) => (a.id === "down" ? down : ok).connector(a),
      log: (l) => lines.push(l),
    });
    expect((await watcher.sweep()).map((p) => p.id)).toEqual(["p2"]);
    expect(lines[0]).toMatch(/down: couldn't check Sent/);
  });
});
