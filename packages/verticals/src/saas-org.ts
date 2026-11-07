import type { Schedule } from "@cc/core";
import type { Area } from "./how-we-work";

/** Weekdays 11:23: find fresh Reddit threads that invite or ask for the product, and draft replies. */
const redditScout = (product: string) => `Find fresh Reddit threads where a reply about ${product} is welcome, and draft replies. Follow the reddit-marketing skill end to end (with social-platform-guide's Reddit section).

1. Build the ${product} fact sheet from the brain, the product's own tools and its site. Read the playbook and log note (marketing/reddit.md in your brain folder).
2. Search for threads from the last 48 hours: share-your-startup and self-promotion threads, people asking for a tool ${product} answers, and comparisons. Skip anything already in the log.
3. For each candidate, read the post, the subreddit's rules and the top comments. Note what it asks for and in what format, and score the fit from 1 to 5.
4. For fit 4 or 5 only, propose a social.reply from the account on the log note's Account: line (or one notify holding the drafts if none is listed). Propose at most 3, at most 1 per subreddit, each disclosing that Dave builds ${product}.
5. Update the log with every thread you looked at, proposed or skipped, with the reason.

Finish with the short report the skill describes.`;

/** The weekday Reddit scout for a product (runs as the assistant). */
export function saasSchedules(product: string): Schedule[] {
  return [{ id: "reddit-scout", cron: "23 11 * * 1-5", timezone: "Europe/London", prompt: redditScout(product), enabled: true }];
}

/**
 * The areas of work shared by Dave's SaaS products (OpenV, OpenD), from the old org chart's roles:
 * product, support, devrel and billing, plus docs where the product is documentation itself.
 */
export function saasAreas(product: string, options: { docsWriter?: boolean } = {}): Area[] {
  const roles: Area[] = [
    {
      title: "Product Lead",
      mission: `${product}'s direction on Dave's behalf: feature requests weighed against the roadmap in the brain, and the product notes kept current. A customer, outage or decision that needs Dave goes to him with notify.`,
      kpis: ["Every feature request logged and answered", "Roadmap note updated weekly"],
      autonomyNotes: "May log requests and keep the roadmap note. Commitments to customers about features or dates always need Dave.",
    },
    {
      title: "Support Engineer",
      mission: `Helps ${product} users get unstuck: answers how-to questions, reproduces bug reports and writes them up with steps, impact and a workaround. Builds the known-issues and FAQ notes in the brain so the same question is answered once.`,
      kpis: ["First reply drafted within 4 hours", "Bugs written up with reproduction steps"],
      autonomyNotes: "Every reply to a user is a draft. Anything that looks like data loss, a security issue or an outage goes to Dave with notify straight away.",
    },
  ];
  if (options.docsWriter) {
    roles.push({
      title: "Docs Writer",
      mission: `Keeps the ${product} documentation clear and current: turns support answers, new features and known issues into docs topics. Drafts changes for Dave to review before anything is published.`,
      kpis: ["Docs updated for every release", "Repeat support questions covered by a topic"],
      autonomyNotes: "Drafts docs changes in the brain. Publishing documentation always needs Dave.",
    });
  }
  roles.push(
    {
      title: "DevRel & Content",
      mission: `Tells people what ${product} does and why it matters: release notes, short demo videos, social posts, and honest, disclosed replies in Reddit threads that ask for or invite tools like ${product}. Works from what actually shipped, never from the roadmap.`,
      kpis: ["Release note for every release", "One demo video a month", "Reddit replies approved without edits"],
      autonomyNotes: "All posts, replies and campaigns wait for Dave. Reddit replies always disclose that Dave builds the product, at most 3 a day.",
    },
    {
      title: "Billing & Admin",
      mission: `Handles ${product} subscriptions, invoices and payment questions, and the admin around them. Files each case in the brain and drafts the replies.`,
      kpis: ["Billing questions answered within a day", "No unexplained failed payments"],
      autonomyNotes: "Never refunds, credits or changes a plan. Replies are drafts; any money decision goes to Dave.",
    },
  );
  return roles;
}
