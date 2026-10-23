import { z } from "zod";

const Server = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  /** true for implicit TLS (IMAP 993, SMTP 465); false uses STARTTLS when offered. */
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string().min(1),
});

export const EmailAccount = z.object({
  /** Stable id, used in dedupe keys, checkpoints and action payloads. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "id must be letters, digits, - or _"),
  vertical: z.string().min(1),
  address: z.email(),
  /** Name on outgoing mail and the signature agents use. */
  displayName: z.string().optional(),
  imap: Server,
  smtp: Server,
  mailbox: z.string().default("INBOX"),
  /** Senders to skip: full addresses, or "@domain" for a whole domain. */
  ignoreFrom: z.array(z.string()).default([]),
  /**
   * Append sent mail to the IMAP Sent folder. Defaults to on, except for Gmail,
   * which files SMTP-sent mail itself.
   */
  saveSent: z.boolean().optional(),
});
export type EmailAccount = z.infer<typeof EmailAccount>;
export type EmailAccountInput = z.input<typeof EmailAccount>;

export const EmailAccounts = z
  .array(EmailAccount)
  .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "account ids must be unique");

/** Parses the `EMAIL_ACCOUNTS` JSON. Empty or unset means no accounts. */
export function parseEmailAccounts(json: string | undefined): EmailAccount[] {
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`EMAIL_ACCOUNTS is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = EmailAccounts.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`EMAIL_ACCOUNTS is invalid: ${issues}`);
  }
  return parsed.data;
}

export function shouldSaveSent(account: EmailAccount): boolean {
  if (account.saveSent !== undefined) return account.saveSent;
  return !/(^|\.)(gmail|googlemail)\.com$/i.test(account.smtp.host);
}

/** True when `from` matches the account's own address or one of its ignore rules. */
export function isIgnoredSender(account: EmailAccount, from: string | undefined): boolean {
  if (!from) return false;
  const addr = from.toLowerCase();
  if (addr === account.address.toLowerCase()) return true;
  return account.ignoreFrom.some((rule) => {
    const r = rule.toLowerCase().trim();
    return r.startsWith("@") ? addr.endsWith(r) : addr === r;
  });
}
