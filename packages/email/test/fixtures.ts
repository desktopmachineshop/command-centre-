import MailComposer from "nodemailer/lib/mail-composer";
import type { EmailAccount } from "../src";

type Mail = ConstructorParameters<typeof MailComposer>[0];

/** Builds a raw RFC 822 message. */
export const rawEmail = (mail: Mail): Promise<Buffer> =>
  new MailComposer({ date: new Date("2026-10-20T09:30:00Z"), ...mail }).compile().build();

export function account(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: "shop",
    vertical: "dms",
    address: "support@desktopmachineshop.com",
    displayName: "Dave at Desktop Machine Shop",
    imap: { host: "imap.test", port: 993, secure: true, user: "u", pass: "p" },
    smtp: { host: "127.0.0.1", port: 2525, secure: false, user: "u", pass: "p" },
    mailbox: "INBOX",
    ignoreFrom: [],
    ...overrides,
  };
}
