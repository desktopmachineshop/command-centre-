import type { Schedule } from "@cc/core";

/**
 * Marketing schedules shared by the businesses: the weekday Reddit scout and the weekly competitor
 * watch. Both run as the assistant, read through the read-only `reddit` and `research` MCP servers,
 * and only ever propose: every reply waits for Dave.
 */

/** Finds fresh Reddit threads where a reply about `subject` is welcome, and drafts replies as one batch. */
export const redditScoutPrompt = (subject: string, factSheet: string) => `Find fresh Reddit threads where a reply about ${subject} is welcome, and draft replies. Follow the reddit-marketing skill end to end (with social-platform-guide's Reddit section).

1. Build the ${subject} fact sheet from ${factSheet}. Read the playbook and log note (marketing/reddit.md in your brain folder).
2. Find threads from the last 48 hours with the reddit tools (search_posts, and subreddit_posts on the subreddits in the playbook): share-your-work and self-promotion threads, people asking for something ${subject} answers, and comparisons. Skip anything already in the log.
3. For each candidate, read it with get_thread and its subreddit's rules with subreddit_info. Note what it asks for and in what format, and score the fit from 1 to 5.
4. Check the account's own recent history with user_history (the account on the log note's Account: line): if more than about 1 in 10 of its recent contributions are self-promotion, propose nothing promotional today and say so.
5. For fit 4 or 5 only, propose the replies together as one propose_batch of social.reply items from that account (or one notify holding the drafts if no account is listed). At most 3, at most 1 per subreddit, each disclosing that Dave runs ${subject}.
6. Update the log with every thread you looked at, proposed or skipped, with the reason.

Finish with the short report the skill describes.`;

/** The weekday Reddit scout. `minute` staggers the businesses so they don't all read Reddit at once. */
export function redditScoutSchedule(subject: string, factSheet: string, minute: number, enabled = true): Schedule {
  return { id: "reddit-scout", cron: `${minute} 11 * * 1-5`, timezone: "Europe/London", prompt: redditScoutPrompt(subject, factSheet), enabled };
}

/** The brain note listing a business's competitors (seeded with a template by the server). */
export const competitorRegistryPath = (brainFolder: string) => `${brainFolder}/competitors.md`;

export const COMPETITOR_WATCH_ID = "competitor-watch";

export const competitorWatchPrompt = (business: string, brainFolder: string) => `Run the weekly competitor watch for ${business}. Follow the competitor-analysis skill ("Weekly watch").

1. Read the competitor registry, ${competitorRegistryPath(brainFolder)}. If it lists no competitors, stop here: say so in one line and propose nothing.
2. For each competitor in it, take this week's snapshot with the research tool competitor_snapshot (its Site, and its Watch pages if listed). Heed the warnings: a failed or blocked read is not a change.
3. Where prices changed or products appeared, compare against our own with the tools the skill names, for the overlapping products only.
4. Write the dated report to the brain (${brainFolder}/competitors/reports/<today>-watch.md) with what changed since last time, each fact with its source URL and the date it was read.
5. If anything changed that Dave should know (a price move on an overlapping product, a new competing product, a change to their shipping or returns), propose one notify with the three or four lines that matter and a link to the report. If nothing changed, just journal that the watch ran. Recommend actions as proposals only where the skill says to.`;

/**
 * The weekly competitor watch, early on a Monday. The server skips the firing while the business's
 * registry lists no competitors (apps/server competitors.ts), so it costs nothing until Dave or the
 * agent has added one.
 */
export function competitorWatchSchedule(business: string, brainFolder: string, minute: number): Schedule {
  return { id: COMPETITOR_WATCH_ID, cron: `${minute} 6 * * 1`, timezone: "Europe/London", prompt: competitorWatchPrompt(business, brainFolder), enabled: true };
}
