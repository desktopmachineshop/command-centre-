import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import { type EmailAccount, shouldSaveSent } from "./accounts";
import { canFileInGmail, fileInGmail } from "./gmail";
import { type ImapConnector, imapflowConnector } from "./imap";
import { sendOverHttps, smtpAuth } from "./oauth";

/** Same shape as the server's `ActionExecutor`; the context is not needed here. */
export interface EmailActionExecutor {
  description: string;
  execute(payload: Record<string, unknown>, ctx?: unknown): Promise<unknown>;
  /** Checked when the action is proposed, so a bad payload fails then rather than on approval. */
  validate?(payload: Record<string, unknown>): void;
}

export interface EmailExecutorOptions {
  connect?: ImapConnector;
  logger?: { error(message: string, err?: unknown): void };
}

const Recipients = z.union([z.email(), z.array(z.email()).min(1)]);
const MessageIds = z.union([z.string().min(1), z.array(z.string().min(1))]);

const Send = z.object({
  accountId: z.string().min(1),
  to: Recipients,
  cc: Recipients.optional(),
  subject: z.string().min(1),
  /** Plain text. */
  body: z.string().min(1),
});

const LabelNames = z.array(z.string().trim().min(1).max(100)).max(5);

const Reply = Send.extend({
  /** Message-ID of the email being answered. */
  inReplyTo: z.string().min(1),
  references: MessageIds.optional(),
  /** Gmail only: once sent, label the conversation and/or take it out of the inbox. */
  labels: LabelNames.optional(),
  archive: z.boolean().optional(),
});

const Label = z
  .object({
    accountId: z.string().min(1),
    /** Message-ID header of the email whose conversation to file. */
    messageId: z.string().min(1),
    labels: LabelNames.default([]),
    /** Take the conversation out of the inbox (Gmail "archive"); it stays under All Mail and its labels. */
    archive: z.boolean().default(false),
  })
  .refine((p) => p.labels.length > 0 || p.archive, { message: "give labels and/or archive: true", path: ["labels"] });

export type SendPayload = z.infer<typeof Send>;
export type ReplyPayload = z.infer<typeof Reply>;

const bracket = (id: string) => (id.startsWith("<") ? id : `<${id}>`);

/** "Re:" once, however many the original had (also "RE:", "Re[2]:"). */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^(\s*re(\[\d+\])?\s*:\s*)+/i, "").trim();
  return `Re: ${bare}`;
}

/** The References chain: the original's references, then the message being replied to. */
export function replyReferences(inReplyTo: string, references?: string | string[]): string[] {
  const list = (Array.isArray(references) ? references : (references ?? "").split(/\s+/)).filter(Boolean).map(bracket);
  const parent = bracket(inReplyTo);
  return [...list.filter((r) => r !== parent), parent];
}

function parse<T>(schema: z.ZodType<T>, type: string, payload: Record<string, unknown>): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ");
    throw new Error(`Invalid ${type} payload: ${issues}`);
  }
  return result.data;
}

/** `email.reply` and `email.send` for the configured accounts. Both are meant to stay on `draft` policy. */
export function createEmailExecutors(
  accounts: EmailAccount[],
  options: EmailExecutorOptions = {},
): Record<"email.reply" | "email.send" | "email.label", EmailActionExecutor> {
  const connect = options.connect ?? imapflowConnector;
  const log = options.logger ?? { error: (m: string, err?: unknown) => console.error(`[email] ${m}`, err ?? "") };
  const ids = accounts.map((a) => a.id).join(", ");

  const account = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown email accountId "${id}". Configured: ${ids || "none"}`);
    return a;
  };

  async function deliver(a: EmailAccount, mail: ConstructorParameters<typeof MailComposer>[0]) {
    const node = new MailComposer({
      from: a.displayName ? { name: a.displayName, address: a.address } : a.address,
      ...mail,
    }).compile();
    const raw = await node.build();
    // Gmail API / Microsoft Graph over HTTPS when the account has one: no SMTP port needed.
    const viaHttps = await sendOverHttps(a, raw);
    if (viaHttps) return { messageId: node.messageId(), accepted: node.getEnvelope().to, rejected: [], savedTo: null };
    const transport = nodemailer.createTransport({
      host: a.smtp.host,
      port: a.smtp.port,
      secure: a.smtp.secure,
      auth: await smtpAuth(a),
    });
    try {
      const info = await transport.sendMail({ envelope: node.getEnvelope(), raw });
      let savedTo: string | null = null;
      if (shouldSaveSent(a)) {
        // The mail has gone; failing to file a copy must not fail the action.
        try {
          const session = await connect(a);
          try {
            savedTo = await session.appendToSent(raw);
          } finally {
            await session.close().catch(() => {});
          }
        } catch (err) {
          log.error(`${a.id}: sent, but could not save a copy to Sent`, err);
        }
      }
      return { messageId: node.messageId(), accepted: info.accepted, rejected: info.rejected, savedTo };
    } finally {
      transport.close();
    }
  }

  return {
    "email.reply": {
      description:
        "Reply to an email. payload: { accountId, to, subject, body, inReplyTo (the original Message-ID), references?, cc?, labels?, archive? }. Body is plain text; sign it yourself. Gmail inboxes: labels and archive file the conversation once the reply has gone.",
      execute: async (payload) => {
        const p = parse(Reply, "email.reply", payload);
        const a = account(p.accountId);
        const sent = await deliver(a, {
          to: p.to,
          cc: p.cc,
          subject: replySubject(p.subject),
          text: p.body,
          inReplyTo: bracket(p.inReplyTo),
          references: replyReferences(p.inReplyTo, p.references),
        });
        if (!p.labels?.length && !p.archive) return sent;
        // The reply has gone; failing to file the conversation must not fail the action.
        try {
          return { ...sent, filed: await fileInGmail(a, { messageId: p.inReplyTo, labels: p.labels, archive: p.archive }) };
        } catch (err) {
          log.error(`${a.id}: replied, but could not label/archive the conversation`, err);
          return { ...sent, fileError: (err as Error).message };
        }
      },
    },
    "email.label": {
      description:
        "Gmail inboxes: label an email's conversation and/or move it out of the inbox. payload: { accountId, messageId (the email's Message-ID), labels? (up to 5 names; missing ones are created, nested like \"Shop/Orders\"), archive? (true takes it out of the inbox) }.",
      validate: (payload) => {
        const p = parse(Label, "email.label", payload);
        const a = account(p.accountId);
        if (!canFileInGmail(a)) throw new Error(`${a.id} isn't a Gmail inbox connected with Google, so it can't be labelled`);
      },
      execute: async (payload) => {
        const p = parse(Label, "email.label", payload);
        return fileInGmail(account(p.accountId), { messageId: p.messageId, labels: p.labels, archive: p.archive });
      },
    },
    "email.send": {
      description: "Send a new email. payload: { accountId, to, subject, body, cc? }. Body is plain text; sign it yourself.",
      execute: async (payload) => {
        const p = parse(Send, "email.send", payload);
        return deliver(account(p.accountId), { to: p.to, cc: p.cc, subject: p.subject, text: p.body });
      },
    },
  };
}
