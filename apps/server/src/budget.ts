import type { Event, VerticalManifest } from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import type { Store } from "./db/store";
import { dayStart, localDay } from "./days";
import type { Notifier } from "./push";

/**
 * The budget rule: Dave's own chat requests are never held back by a budget,
 * because he asked for them explicitly. Everything else (schedules, webhooks,
 * email, Odoo) is deferred once a cap is reached. An explicit retry also
 * bypasses the budget, once.
 */
export function bypassesBudget(event: Pick<Event, "source"> | null): boolean {
  return event?.source === "chat";
}

export interface BudgetBreach {
  scope: "global" | "vertical";
  limitUsd: number;
  spentUsd: number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Daily spend caps, global (AGENT_DAILY_BUDGET_USD) and per vertical (the
 * manifest's `dailyBudgetUsd`). "Today" is the calendar day in `timezone`.
 * Spend counts finished runs only, so runs in flight when a cap is reached can
 * overshoot it by their own cost.
 */
export class BudgetService {
  constructor(
    private readonly store: Store,
    private readonly verticals: VerticalRegistry,
    private readonly notifier: Notifier,
    readonly options: { dailyBudgetUsd?: number; timezone: string },
  ) {}

  today(now = new Date()): string {
    return localDay(now, this.options.timezone);
  }

  /** Spend per vertical so far today. */
  async spentToday(now = new Date()): Promise<Record<string, number>> {
    return this.store.costByVertical(dayStart(this.today(now), this.options.timezone));
  }

  /** The configured caps, for the dashboard. */
  limits(): { globalUsd: number | null; verticals: Record<string, number> } {
    const verticals: Record<string, number> = {};
    for (const v of this.verticals.all()) if (v.dailyBudgetUsd) verticals[v.id] = v.dailyBudgetUsd;
    return { globalUsd: this.options.dailyBudgetUsd ?? null, verticals };
  }

  /** The first cap a new run in `vertical` would break, or null when it may run. */
  async check(vertical: VerticalManifest, now = new Date()): Promise<BudgetBreach | null> {
    if (!this.options.dailyBudgetUsd && !vertical.dailyBudgetUsd) return null;
    const spent = await this.spentToday(now);
    const total = Object.values(spent).reduce((a, b) => a + b, 0);
    const mine = spent[vertical.id] ?? 0;
    if (this.options.dailyBudgetUsd && total >= this.options.dailyBudgetUsd) {
      return { scope: "global", limitUsd: this.options.dailyBudgetUsd, spentUsd: total };
    }
    if (vertical.dailyBudgetUsd && mine >= vertical.dailyBudgetUsd) {
      return { scope: "vertical", limitUsd: vertical.dailyBudgetUsd, spentUsd: mine };
    }
    return null;
  }

  /** The note a deferred task shows. */
  note(vertical: VerticalManifest, breach: BudgetBreach): string {
    const which = breach.scope === "global" ? "Daily budget" : `${vertical.name} daily budget`;
    return `${which} reached (${usd(breach.spentUsd)} of ${usd(breach.limitUsd)}). Runs automatically after midnight (${this.options.timezone}), or retry to run it now.`;
  }

  /** Pushes one notification per scope per day; later breaches the same day stay quiet. */
  async alert(vertical: VerticalManifest, breach: BudgetBreach, now = new Date()): Promise<void> {
    const scope = breach.scope === "global" ? "global" : `vertical:${vertical.id}`;
    if (!(await this.store.recordBudgetAlert(this.today(now), scope))) return;
    const who = breach.scope === "global" ? "all verticals" : vertical.name;
    await this.notifier.notify({
      title: `Budget reached: ${who}`,
      body: `Spent ${usd(breach.spentUsd)} of ${usd(breach.limitUsd)} today. New tasks wait until tomorrow; retry one from its task page to run it now.`,
      url: "/",
    });
  }
}
