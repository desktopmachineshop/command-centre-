import type { RoleInput } from "@cc/core";

/** Weekdays 11:23: find fresh Reddit threads that invite or ask for the product, and draft replies. */
const redditScout = (product: string) => `Find fresh Reddit threads where a reply about ${product} is welcome, and draft replies. Follow the reddit-marketing skill end to end (with social-platform-guide's Reddit section).

1. Build the ${product} fact sheet from the brain, the product's own tools and its site. Read the playbook and log note (marketing/reddit.md in your brain folder).
2. Search for threads from the last 48 hours: share-your-startup and self-promotion threads, people asking for a tool ${product} answers, and comparisons. Skip anything already in the log.
3. For each candidate, read the post, the subreddit's rules and the top comments. Note what it asks for and in what format, and score the fit from 1 to 5.
4. For fit 4 or 5 only, propose a social.reply from the account on the log note's Account: line (or one notify holding the drafts if none is listed). Propose at most 3, at most 1 per subreddit, each disclosing that Dave builds ${product}.
5. Update the log with every thread you looked at, proposed or skipped, with the reason.

Finish with the short report the skill describes.`;

/**
 * The org shared by Dave's SaaS products (OpenV, OpenD): a Product Lead with
 * support, devrel and billing under it, plus a Docs Writer where the product
 * is documentation itself.
 */
export function saasRoles(product: string, options: { docsWriter?: boolean } = {}): RoleInput[] {
  const roles: RoleInput[] = [
    {
      id: "product-lead",
      title: "Product Lead",
      reportsTo: "chief-of-staff",
      aliases: ["product"],
      mission: `Owns ${product}'s direction on Dave's behalf: weighs feature requests against the roadmap in the brain, keeps the product notes current and decides which role handles anything new. Escalates to the Chief of Staff when a customer, outage or decision needs Dave.`,
      intents: ["feature-request"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["brain.write", "notify", "email.reply", "email.label"],
      kpis: ["Every feature request logged and answered", "Roadmap note updated weekly"],
      autonomyNotes: "May log requests and keep the roadmap note. Commitments to customers about features or dates always need Dave.",
    },
    {
      id: "support-engineer",
      title: "Support Engineer",
      reportsTo: "product-lead",
      aliases: ["support"],
      mission: `Helps ${product} users get unstuck: answers how-to questions, reproduces bug reports and writes them up with steps, impact and a workaround. Builds the known-issues and FAQ notes in the brain so the same question is answered once.`,
      intents: ["support", "bug"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["email.reply", "email.label", "brain.write", "notify"],
      kpis: ["First reply drafted within 4 hours", "Bugs written up with reproduction steps"],
      autonomyNotes: "Every reply to a user is a draft. Anything that looks like data loss, a security issue or an outage goes to Dave with notify straight away.",
    },
  ];
  if (options.docsWriter) {
    roles.push({
      id: "docs-writer",
      title: "Docs Writer",
      reportsTo: "product-lead",
      aliases: ["docs"],
      mission: `Keeps the ${product} documentation clear and current: turns support answers, new features and known issues into docs topics. Drafts changes for Dave to review before anything is published.`,
      skills: ["brain-notes"],
      actions: ["brain.write"],
      kpis: ["Docs updated for every release", "Repeat support questions covered by a topic"],
      autonomyNotes: "Drafts docs changes in the brain. Publishing documentation always needs Dave.",
    });
  }
  roles.push(
    {
      id: "devrel-content",
      title: "DevRel & Content",
      reportsTo: "product-lead",
      aliases: ["devrel"],
      mission: `Tells people what ${product} does and why it matters: release notes, short demo videos, social posts, and honest, disclosed replies in Reddit threads that ask for or invite tools like ${product}. Works from what actually shipped, never from the roadmap.`,
      skills: ["brain-notes", "social-platform-guide", "video-reel", "reddit-marketing"],
      actions: ["social.post", "social.reply", "social.campaign", "video.produce", "brain.write", "notify"],
      schedules: [{ id: "reddit-scout", cron: "23 11 * * 1-5", timezone: "Europe/London", prompt: redditScout(product), enabled: true }],
      kpis: ["Release note for every release", "One demo video a month", "Reddit replies approved without edits"],
      autonomyNotes: "All posts, replies and campaigns wait for Dave. Reddit replies always disclose that Dave builds the product, at most 3 a day.",
    },
    {
      id: "billing-admin",
      title: "Billing & Admin",
      reportsTo: "product-lead",
      aliases: ["billing"],
      mission: `Handles ${product} subscriptions, invoices and payment questions, and the admin around them. Files each case in the brain and drafts the replies.`,
      intents: ["billing"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["email.reply", "email.label", "brain.write", "notify"],
      kpis: ["Billing questions answered within a day", "No unexplained failed payments"],
      autonomyNotes: "Never refunds, credits or changes a plan. Replies are drafts; any money decision goes to Dave.",
    },
  );
  return roles;
}
