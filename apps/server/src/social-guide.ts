import { accountSpeaksFor, accountVerticals, isRedditBrowserAccount, isRedditSessionAccount, type SocialAccount } from "@cc/social";

/**
 * The system-prompt section naming the social accounts a run can post from, so an agent never
 * has to be told (or guess) an `accountId`: the business's own accounts, and for the assistant on
 * Dave's work every business's. "" when there are none. Ids and handles only, never credentials.
 */
export function socialAccountsGuide(accounts: readonly SocialAccount[], vertical: string, any: boolean): string {
  const mine = accounts.filter((a) => any || accountSpeaksFor(a, vertical)).sort((a, b) => Number(accountSpeaksFor(b, vertical)) - Number(accountSpeaksFor(a, vertical)));
  if (!mine.length) return "";
  return [
    "## Social accounts",
    "The accounts connected on the Accounts page. Use the id as `accountId` in social.* actions (social.reply, social.post, social.dm, social.campaign); never guess one, and use an account of the business the work is for.",
    ...mine.map((a) => {
      const handle = a.handle ? ` ${a.handle}` : "";
      const notes = [any ? `business ${accountVerticals(a).join(", ")}` : a.vertical !== vertical ? `shared from ${a.vertical}` : "", isRedditSessionAccount(a) ? "Dave's own login: paced, a few posts a day" : isRedditBrowserAccount(a) ? "Dave's own login, posted from his PC: paced, a few posts a day; results may say it waits for the PC" : ""].filter(Boolean).join("; ");
      return `- \`${a.id}\`: ${a.platform}${handle}${notes ? ` (${notes})` : ""}`;
    }),
  ].join("\n");
}
