import type { Proposal } from "@cc/core";
import type { EmailAccount, ImapConnector } from "@cc/email";

/**
 * Suggested email replies Dave no longer needs: when he has answered an email himself (from his
 * phone, Gmail or Outlook), the reply an agent drafted for it is withdrawn, so Approvals only
 * holds replies still worth sending.
 *
 * Every few minutes it looks at each mailbox's Sent folder for a message replying to an email that
 * has a pending "email.reply" (by the email's Message-ID, in In-Reply-To or References), and
 * withdraws those proposals with the reason shown in Approvals.
 */

export const ANSWERED_REASON = "You've already replied to this email yourself, so this suggested reply was cancelled.";

export interface AnsweredElsewhereDeps {
  listPending: () => Promise<Proposal[]>;
  withdraw: (id: string, reason: string) => Promise<Proposal | null>;
  /** The mailboxes now configured (read per sweep: the Accounts page can change them live). */
  accounts: () => EmailAccount[];
  connect: ImapConnector;
  log?: (line: string) => void;
}

/** The email a pending reply answers: its account and Message-ID, or null for anything else. Pure. */
export function replyTarget(p: Pick<Proposal, "actionType" | "status" | "payload">): { accountId: string; messageId: string } | null {
  if (p.actionType !== "email.reply" || p.status !== "pending") return null;
  const { accountId, inReplyTo } = (p.payload ?? {}) as { accountId?: unknown; inReplyTo?: unknown };
  return typeof accountId === "string" && typeof inReplyTo === "string" && inReplyTo.trim() ? { accountId, messageId: inReplyTo.trim() } : null;
}

export class AnsweredElsewhere {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: AnsweredElsewhereDeps) {}

  /** One pass over every mailbox with a pending reply. Returns the proposals it withdrew. */
  async sweep(): Promise<Proposal[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const byAccount = new Map<string, Map<string, string[]>>();
      for (const p of await this.deps.listPending()) {
        const t = replyTarget(p);
        if (!t) continue;
        const ids = byAccount.get(t.accountId) ?? new Map<string, string[]>();
        ids.set(t.messageId, [...(ids.get(t.messageId) ?? []), p.id]);
        byAccount.set(t.accountId, ids);
      }
      const withdrawn: Proposal[] = [];
      for (const [accountId, ids] of byAccount) {
        const account = this.deps.accounts().find((a) => a.id === accountId);
        if (!account) continue;
        let answered: string[];
        const session = await this.deps.connect(account).catch((err: Error) => {
          this.deps.log?.(`[email] ${accountId}: couldn't check Sent for replies: ${err.message}`);
          return null;
        });
        if (!session) continue;
        try {
          answered = await session.sentRepliesTo([...ids.keys()]);
        } catch (err) {
          this.deps.log?.(`[email] ${accountId}: couldn't check Sent for replies: ${(err as Error).message}`);
          continue;
        } finally {
          await session.close().catch(() => {});
        }
        for (const messageId of answered) {
          for (const id of ids.get(messageId) ?? []) {
            const p = await this.deps.withdraw(id, ANSWERED_REASON).catch(() => null);
            if (p) withdrawn.push(p);
          }
        }
      }
      if (withdrawn.length) this.deps.log?.(`[email] cancelled ${withdrawn.length} suggested repl${withdrawn.length === 1 ? "y" : "ies"} already answered by Dave`);
      return withdrawn;
    } finally {
      this.running = false;
    }
  }

  start(everyMs = 5 * 60_000): void {
    this.timer = setInterval(() => void this.sweep().catch((err) => this.deps.log?.(`[email] reply check: ${(err as Error).message}`)), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
