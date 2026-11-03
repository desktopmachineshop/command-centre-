import type { Brain } from "@cc/brain";
import type { Job, Proposal, Task, VerticalManifest } from "@cc/core";
import { DEFAULT_VERTICAL, type VerticalRegistry } from "@cc/verticals";
import type { BudgetService } from "./budget";
import type { Store } from "./db/store";
import { dayRange, localDay } from "./days";
import { type OdooDigest, type OdooSnapshot, odooHeadline, renderLowStockSummary, renderOdooDigest, summariseOdooEvents } from "./odoo-digest";
import type { Notifier } from "./push";
import { renderShippingDigest, type ShippingDigest, shippingHeadline } from "@cc/sendcloud";

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
  /** The day's orders, RFQs and supplier replies, plus what is low and late now; null if Odoo had nothing. */
  odoo: OdooDigest | null;
  /** Sendcloud parcels: delivered today, in transit, problems; null without Sendcloud or news. */
  shipping: ShippingDigest | null;
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
 * note at `<brainFolder>/digests/YYYY-MM-DD.md` plus one push per vertical that opens it.
 */
export class DigestService {
  constructor(
    private readonly store: Store,
    private readonly brain: Brain,
    private readonly verticals: VerticalRegistry,
    private readonly notifier: Notifier,
    private readonly budget: BudgetService,
    private readonly timezone: string,
    /** What the Odoo pollers last saw as low and late (null without Odoo): the buying and late lists. */
    private readonly odooSnapshot: () => Promise<OdooSnapshot | null> = async () => null,
    /** The Shipping section for a business and day, read live from Sendcloud (null without it). */
    private readonly shipping: (vertical: string, start: Date, end: Date, now: Date) => Promise<ShippingDigest | null> = async () => null,
  ) {}

  today(now = new Date()): string {
    return localDay(now, this.timezone);
  }

  static notePath(vertical: VerticalManifest, day: string): string {
    return `${vertical.brainFolder}/digests/${day}.md`;
  }

  static lowStockPath(vertical: VerticalManifest, day: string): string {
    return `${vertical.brainFolder}/stock/low-stock-${day}.md`;
  }

  /**
   * The weekly low-stock summary: for each business with anything below its
   * reorder level (what the Odoo stock poller last saw), one brain note and
   * one push that opens it. Returns what each business got.
   */
  async deliverLowStock(day = this.today(), options: { push?: boolean } = {}): Promise<{ vertical: string; path: string; count: number }[]> {
    const snapshot = await this.odooSnapshot();
    const out: { vertical: string; path: string; count: number }[] = [];
    for (const vertical of this.verticals.all()) {
      const items = (snapshot?.lowStock ?? []).filter((p) => p.vertical === vertical.id);
      if (!items.length) continue;
      const path = DigestService.lowStockPath(vertical, day);
      await this.brain.write(
        path,
        { frontmatter: { type: "low-stock", vertical: vertical.id, date: day }, body: renderLowStockSummary(vertical.name, day, items) },
        `low stock: ${vertical.id} ${day}`,
      );
      const toOrder = items.filter((p) => !p.incomingQty).length;
      if (options.push !== false) {
        await this.notifier.notify({
          title: `${vertical.name} low stock, week of ${day}`,
          body: `${items.length} below reorder level, ${toOrder} with nothing on order`,
          url: `/brain/${encodeURIComponent(path)}`,
          category: "digest",
          priority: "normal",
          vertical: vertical.id,
          tag: `low-stock:${vertical.id}`,
        });
      }
      out.push({ vertical: vertical.id, path, count: items.length });
    }
    return out;
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
    const odoo = summariseOdooEvents(await store.listOdooEventsBetween(vertical.id, start, end), await this.odooSnapshot(), vertical.id);
    // --- end odoo events ---
    // Sendcloud is read live; if it fails the digest still goes out, with the error in its section.
    const shipping = await this.shipping(vertical.id, start, end, now).catch((err: Error) => ({
      deliveredToday: [], problems: [], atPickupPoint: [], inTransit: [], notCollected: [], labelsToday: 0, errors: [`Sendcloud: ${err.message}`],
    }));
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
      shipping,
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
   * sends each one's headline as its own push (`push: false` for a quiet rewrite).
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
    if (options.push !== false) {
      // One push per business, each opening that business's digest note.
      for (const d of active) {
        const path = DigestService.notePath(this.verticals.require(d.vertical), day);
        await this.notifier.notify({
          title: `${d.name} daily digest, ${day}`,
          body: d.headline,
          url: `/brain/${encodeURIComponent(path)}`,
          category: "digest",
          priority: "normal",
          vertical: d.vertical,
          tag: `digest:${d.vertical}`,
        });
      }
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
  return c.done + c.failed + c.deferred + c.autoActions + c.pendingApprovals + c.jobs > 0 || d.costUsd > 0 || d.odoo !== null || d.shipping !== null;
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
  parts.push(...shippingHeadline(d.shipping)); // Sendcloud
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
  lines.push(...renderShippingDigest(d.shipping)); // Sendcloud
  return `${lines.join("\n")}\n`;
}
