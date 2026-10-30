import type { EmailAccount } from "./accounts";
import { gmailRequest } from "./oauth";

/**
 * Filing mail in Gmail through the Gmail API: label a conversation and/or take
 * it out of the inbox (archive). Needs the mailbox's Google sign-in (the
 * full-mail scope the Accounts page asks for).
 */

interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

/** True when the account can be filed through the Gmail API. */
export function canFileInGmail(account: EmailAccount): boolean {
  return account.oauth?.provider === "google";
}

/** The Gmail conversation holding the message with this Message-ID header. */
async function findThread(account: EmailAccount, messageId: string): Promise<string> {
  const bare = messageId.trim().replace(/^<|>$/g, "");
  const q = encodeURIComponent(`rfc822msgid:${bare}`);
  const found = await gmailRequest<{ messages?: { id: string; threadId: string }[] }>(account, `/messages?q=${q}&maxResults=1`);
  const hit = found.messages?.[0];
  if (!hit) throw new Error(`No message with Message-ID <${bare}> in ${account.address}`);
  return hit.threadId;
}

/**
 * Label ids for these names, creating user labels that don't exist yet
 * (case-insensitive match, nested names like "Shop/Orders" allowed). Gmail's own
 * labels (Inbox, Spam, Trash, ...) can't be applied this way.
 */
async function labelIds(account: EmailAccount, names: string[]): Promise<{ ids: string[]; created: string[] }> {
  if (!names.length) return { ids: [], created: [] };
  const { labels = [] } = await gmailRequest<{ labels?: GmailLabel[] }>(account, "/labels");
  const ids: string[] = [];
  const created: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s*\/\s*/g, "/");
    if (!name) continue;
    const lower = name.toLowerCase();
    if (labels.some((l) => l.type === "system" && (l.name.toLowerCase() === lower || l.id.toLowerCase() === lower))) {
      throw new Error(`"${name}" is a Gmail system label; use a label of your own (to leave the inbox, set archive)`);
    }
    let label = labels.find((l) => l.type === "user" && l.name.toLowerCase() === lower);
    if (!label) {
      label = await gmailRequest<GmailLabel>(account, "/labels", {
        method: "POST",
        body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      });
      labels.push(label);
      created.push(name);
    }
    if (!ids.includes(label.id)) ids.push(label.id);
  }
  return { ids, created };
}

export interface FileResult {
  threadId: string;
  labels: string[];
  createdLabels: string[];
  archived: boolean;
}

/** Labels the conversation of `messageId` and, with `archive`, moves it out of the inbox. */
export async function fileInGmail(account: EmailAccount, change: { messageId: string; labels?: string[]; archive?: boolean }): Promise<FileResult> {
  if (!canFileInGmail(account)) {
    throw new Error(`${account.id} isn't connected with a Google sign-in, so its mail can't be labelled; connect it on the Accounts page`);
  }
  const threadId = await findThread(account, change.messageId);
  const { ids, created } = await labelIds(account, change.labels ?? []);
  const archive = change.archive === true;
  if (ids.length || archive) {
    await gmailRequest(account, `/threads/${encodeURIComponent(threadId)}/modify`, {
      method: "POST",
      body: { addLabelIds: ids, removeLabelIds: archive ? ["INBOX"] : [] },
    });
  }
  return { threadId, labels: (change.labels ?? []).map((l) => l.trim()).filter(Boolean), createdLabels: created, archived: archive };
}
