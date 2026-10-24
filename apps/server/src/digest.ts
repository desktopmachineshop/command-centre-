import type { Brain } from "@cc/brain";
import type { Job, Proposal, Task, VerticalManifest } from "@cc/core";
import { DEFAULT_VERTICAL, type VerticalRegistry } from "@cc/verticals";
import type { BudgetService } from "./budget";
import type { Store } from "./db/store";
import { dayRange, localDay } from "./days";
import { type OdooDigest, odooHeadline, renderOdooDigest, summariseOdooEvents } from "./odoo-digest";
import type { Notifier } from "./push";

export interface Digest {
  vertical: string;
  name: string;
  date: string;
  timezone: string;
  generatedAt: string;
  costUsd: number;
  budgetUsd: number | null;
  counts: { done: number; failed: number; deferred: number; autoActions: number; pendingApprovals: number; jobs: number };
  done: { id: string; title: string }[];
  failed: { id: string; title: string }[];
  /** Proposals executed (or failed) under `auto-with-digest`: the report that policy promises. */
  autoActions: { id: string; actionType: string; summary: string; status: string }[];
  /** Pending approvals as of now, whatever the date. */
  pendingApprovals: { id: string; actionType: string; summary: string }[];
  jobs: { id: string; kind: string; status: string }[];
  /** Orders, revenue, low stock and late deliveries from the day's Odoo events; null if there were none. */
  odoo: OdooDigest | null;
  /** One line with the headline numbers, used for the push notification. */
  headline: string;
  markdown: string;
}

const titleOf = (t: Task) => ({ id: t.id, title: t.prompt.split("\n")[0]!.slice(0, 120) });
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The daily digest per vertical: a deterministic summary of the day's tasks,
 * auto-with-digest actions, pending approvals, cost and jobs. It is built from
 * the database, not by an agent, so it costs no tokens. Delivered as a brain
 * note at `<brainFolder>/digests/YYYY-MM-DD.md` plus one push for all verticals.
 */
export class DigestService {
  constructor(
    private readonly store: Store,
    private readonly brain: Brain,
    private readonly verticals: VerticalRegistry,
    private readonly notifier: Notifier,
    private readonly budget: BudgetService,
    private readonly timezone: string,
  ) {}

  today(now = new Date()): string {
    return localDay(now, this.timezone);
  }

  static notePath(vertical: VerticalManifest, day: string): string {
    return `${vertical.brainFolder}/digests/${day}.md`;
  }

  async build(verticalId: string, day: string, now = new Date()): Promise<Digest> {
    const vertical = this.verticals.require(verticalId);
    const { start, end } = dayRange(day, this.timezone);
    const { store } = this;
    const [done, failed, deferred, auto, pending, jobs, cost] = await Promise.all([
      store.listTasksUpdatedBetween(vertical.id, ["done"], start, end),
      store.listTasksUpdatedBetween(vertical.id, ["failed"], start, end),
      store.countTasks(vertical.id, "deferred"),
      store.listProposalsDecidedBetween(vertical.id, "auto-with-digest", start, end),
      store.listProposals({ vertical: vertical.id, status: "pending", limit: 200 }),
      store.listJobsUpdatedBetween(start, end),
      store.costByVertical(start, end),
    ]);
    // --- Odoo events ---
    const odoo = summariseOdooEvents(await store.listOdooEventsBetween(vertical.id, start, end));
    // --- end odoo events ---
    const myJobs = jobs.filter((j) => jobVertical(j) === vertical.id && (j.status === "succeeded" || j.status === "failed"));
    const digest: Omit<Digest, "headline" | "markdown"> = {
      vertical: vertical.id,
      name: vertical.name,
      date: day,
      timezone: this.timezone,
      generatedAt: now.toISOString(),
      costUsd: cost[vertical.id] ?? 0,
      budgetUsd: vertical.dailyBudgetUsd ?? null,
      counts: {
        done: done.length,
        failed: failed.length,
        deferred,
        autoActions: auto.length,
        pendingApprovals: pending.length,
        jobs: myJobs.length,
      },
      done: done.map(titleOf),
      failed: failed.map(titleOf),
      autoActions: auto.map((p: Proposal) => ({ id: p.id, actionType: p.actionType, summary: p.summary, status: p.status })),
      pendingApprovals: pending.map((p) => ({ id: p.id, actionType: p.actionType, summary: p.summary })),
      jobs: myJobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status })),
      odoo,
    };
    return { ...digest, headline: headline(digest), markdown: render(digest) };
  }

  /** Every vertical's digest for a day (or just `only`'s), with totals across them. */
  async buildAll(day: string, options: { only?: string; now?: Date } = {}) {
    const ids = options.only ? [options.only] : this.verticals.all().map((v) => v.id);
    const digests = await Promise.all(ids.map((id) => this.build(id, day, options.now)));
    const sum = (f: (d: Digest) => number) => digests.reduce((a, d) => a + f(d), 0);
    return {
      date: day,
      timezone: this.timezone,
      totals: {
        done: sum((d) => d.counts.done),
        failed: sum((d) => d.counts.failed),
        deferred: sum((d) => d.counts.deferred),
        autoActions: sum((d) => d.counts.autoActions),
        pendingApprovals: sum((d) => d.counts.pendingApprovals),
        jobs: sum((d) => d.counts.jobs),
        costUsd: sum((d) => d.costUsd),
        budgetUsd: this.budget.limits().globalUsd,
      },
      digests,
    };
  }

  /**
   * Writes the digest note for each vertical that had anything to report, and
   * sends one push with the headline numbers (`push: false` for a quiet rewrite).
   */
  async deliver(day = this.today(), options: { push?: boolean; now?: Date } = {}): Promise<Digest[]> {
    const { digests } = await this.buildAll(day, { now: options.now });
    const active = digests.filter(isActive);
    for (const d of active) {
      await this.brain.write(
        DigestService.notePath(this.verticals.require(d.vertical), day),
        { frontmatter: { type: "digest", vertical: d.vertical, date: day }, body: d.markdown },
        `digest: ${d.vertical} ${day}`,
      );
    }
    if (options.push !== false && active.length > 0) {
      await this.notifier.notify({
        title: `Daily digest, ${day}`,
        body: active.map((d) => d.headline).join("\n"),
        url: "/",
        category: "digest",
        priority: "normal",
        tag: "digest",
      });
    }
    return active;
  }
}

/** Jobs say which vertical they belong to in `payload.vertical`; the rest count under the default vertical. */
function jobVertical(job: Job): string {
  return typeof job.payload.vertical === "string" ? job.payload.vertical : DEFAULT_VERTICAL;
}

function isActive(d: Digest): boolean {
  const c = d.counts;
  return c.done + c.failed + c.deferred + c.autoActions + c.pendingApprovals + c.jobs > 0 || d.costUsd > 0 || d.odoo !== null;
}

function headline(d: Omit<Digest, "headline" | "markdown">): string {
  const c = d.counts;
  const parts = [`${c.done} done`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.deferred) parts.push(`${c.deferred} deferred`);
  if (c.autoActions) parts.push(`${c.autoActions} auto`);
  if (c.pendingApprovals) parts.push(`${c.pendingApprovals} to approve`);
  if (c.jobs) parts.push(`${c.jobs} jobs`);
  parts.push(...odooHeadline(d.odoo)); // Odoo events
  parts.push(usd(d.costUsd));
  return `${d.name}: ${parts.join(", ")}`;
}

function render(d: Omit<Digest, "headline" | "markdown">): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: d.timezone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(d.generatedAt),
  );
  const c = d.counts;
  const budget = d.budgetUsd ? ` of ${usd(d.budgetUsd)} budget` : "";
  const lines = [
    `# ${d.name} digest, ${d.date}`,
    "",
    `As of ${time} (${d.timezone}). Built from the task log; no agent run.`,
    "",
    `**${c.done} done · ${c.failed} failed · ${c.autoActions} auto actions · ${c.pendingApprovals} awaiting approval · ${usd(d.costUsd)} spent${budget}**`,
  ];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push("", `## ${title}`, "", ...items.map((i) => `- ${i}`));
  };
  section("Done", d.done.map((t) => t.title));
  section("Failed", d.failed.map((t) => `${t.title} (task ${t.id})`));
  if (c.deferred) section("Deferred", [`${c.deferred} task(s) waiting for budget`]);
  section("Auto actions (auto-with-digest)", d.autoActions.map((a) => `${a.status}: ${a.actionType}: ${a.summary}`));
  section("Awaiting approval", d.pendingApprovals.map((p) => `${p.actionType}: ${p.summary}`));
  section("Jobs", d.jobs.map((j) => `${j.kind}: ${j.status}`));
  lines.push(...renderOdooDigest(d.odoo)); // Odoo events
  return `${lines.join("\n")}\n`;
}
