import type { RoleInput } from "@cc/core";

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
      mission: `Tells people what ${product} does and why it matters: release notes, short demo videos and social posts. Works from what actually shipped, never from the roadmap.`,
      skills: ["brain-notes", "social-platform-guide", "video-reel"],
      actions: ["social.post", "social.campaign", "video.produce", "brain.write"],
      kpis: ["Release note for every release", "One demo video a month"],
      autonomyNotes: "All posts and campaigns wait for Dave.",
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
