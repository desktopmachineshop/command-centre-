import type { OpenGymAccount } from "./accounts";
import { isPairingCode, OpenGymClient, redeemPairingCode } from "./client";
import { ExerciseNames } from "./exercises";
import {
  addDays,
  bestE1rm,
  daysBetween,
  durationMinutes,
  type GymState,
  type GymWorkout,
  goalWeight,
  setLabel,
  setsDone,
  setsPlanned,
  unitOf,
  type WeighIn,
  weighInsOf,
  weightOn,
  workoutsOf,
  workoutVolume,
} from "./model";

export interface GymServiceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  catalogueUrl?: string;
  /** A pairing code was redeemed or openGym renewed the token: save it (Accounts page secret). */
  onToken?: (accountId: string, token: string) => Promise<void> | void;
  /** How often to ask openGym whether the token is due for renewal. Default daily. */
  renewEveryMs?: number;
  now?: () => Date;
}

export interface WorkoutRow {
  id: string | null;
  date: string;
  routine: string | null;
  exercises: number;
  sets_done: number;
  sets_planned: number;
  volume: number;
  duration_min: number | null;
  prs: number;
  gym: string | null;
}

function row(w: GymWorkout): WorkoutRow {
  return {
    id: w.id,
    date: w.date,
    routine: w.name,
    exercises: w.entries.length,
    sets_done: setsDone(w),
    sets_planned: setsPlanned(w),
    volume: workoutVolume(w),
    duration_min: durationMinutes(w),
    prs: w.prs.length,
    gym: w.gym,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Dave's openGym profile: one account, its state cached until openGym's revision moves. */
export class GymService {
  readonly account: OpenGymAccount;
  private client: OpenGymClient | null = null;
  private pairing: Promise<OpenGymClient> | null = null;
  private cached: { rev: number; state: GymState | null } | null = null;
  private lastRenewCheck = 0;
  readonly names: ExerciseNames;

  constructor(
    account: OpenGymAccount,
    private readonly options: GymServiceOptions = {},
  ) {
    this.account = account;
    this.names = new ExerciseNames({ catalogueUrl: options.catalogueUrl, fetch: options.fetch });
  }

  get vertical(): string {
    return this.account.vertical;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async clientFor(): Promise<OpenGymClient> {
    if (this.client) return this.client;
    if (!isPairingCode(this.account.token)) {
      this.client = new OpenGymClient({ url: this.account.url, token: this.account.token, fetch: this.options.fetch, timeoutMs: this.options.timeoutMs });
      return this.client;
    }
    // A pairing code works once: concurrent first calls share one redemption.
    this.pairing ??= (async () => {
      try {
        const { token } = await redeemPairingCode(this.account.url, this.account.token, { fetch: this.options.fetch, timeoutMs: this.options.timeoutMs });
        await this.options.onToken?.(this.account.id, token);
        this.client = new OpenGymClient({ url: this.account.url, token, fetch: this.options.fetch, timeoutMs: this.options.timeoutMs });
        return this.client;
      } finally {
        this.pairing = null;
      }
    })();
    return this.pairing;
  }

  /** Who the token signs in as (Test connection); saves a renewed token. */
  async whoami(): Promise<string | null> {
    const client = await this.clientFor();
    const { user, renewed } = await client.me();
    this.lastRenewCheck = this.now().getTime();
    if (renewed) await this.options.onToken?.(this.account.id, renewed);
    return (typeof user?.name === "string" && user.name) || (typeof user?.id === "string" ? user.id : null);
  }

  /** The state document, fetched again only when openGym's revision has moved. */
  async state(): Promise<GymState | null> {
    const client = await this.clientFor();
    if (this.now().getTime() - this.lastRenewCheck > (this.options.renewEveryMs ?? 86_400_000)) {
      await this.whoami();
    }
    if (this.cached && (await client.rev()) === this.cached.rev) return this.cached.state;
    const { state, rev } = await client.data();
    this.cached = { rev, state };
    return state;
  }

  today(timeZone?: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now());
  }

  /** Finished sessions in [from, to], newest first. */
  async workouts(opts: { from?: string; to?: string; limit?: number; timeZone?: string } = {}): Promise<{ unit: string; total: number; matching: number; workouts: WorkoutRow[] }> {
    const state = await this.state();
    const all = workoutsOf(state);
    const to = opts.to ?? this.today(opts.timeZone);
    const matching = all.filter((w) => (!opts.from || w.date >= opts.from) && w.date <= to).reverse();
    return { unit: unitOf(state), total: all.length, matching: matching.length, workouts: matching.slice(0, opts.limit ?? 25).map(row) };
  }

  /** One session set by set, by id or by date (a date with two sessions lists both). */
  async workout(opts: { id?: string; date?: string }) {
    const state = await this.state();
    const all = workoutsOf(state);
    const unit = unitOf(state);
    const found = opts.id ? all.filter((w) => w.id === opts.id) : all.filter((w) => w.date === opts.date);
    if (!found.length) return { found: false as const, message: opts.id ? `No workout with id ${opts.id}` : `No workout on ${opts.date}` };
    if (found.length > 1) return { found: false as const, message: `${found.length} workouts on ${opts.date}: ask again with one id`, workouts: found.map(row) };
    const w = found[0]!;
    const names = await this.names.resolve([...w.entries.map((e) => e.id), ...w.prs], state);
    return {
      found: true as const,
      unit,
      ...row(w),
      bodyweight: w.bw,
      prs: w.prs.map((id) => names.get(id)?.name ?? id),
      entries: w.entries.map((e) => ({
        exercise: names.get(e.id)?.name ?? e.id,
        body_part: names.get(e.id)?.bodyPart ?? null,
        best_e1rm: bestE1rm(e.sets),
        sets: e.sets.map((s) => setLabel(s, unit)),
      })),
    };
  }

  /** Weigh-ins in [from, to] with the goal and the trend. */
  async bodyweight(opts: { from?: string; to?: string; timeZone?: string } = {}) {
    const state = await this.state();
    const all = weighInsOf(state);
    const to = opts.to ?? this.today(opts.timeZone);
    const entries = all.filter((b) => (!opts.from || b.date >= opts.from) && b.date <= to);
    const goal = goalWeight(state);
    const latest = entries.at(-1) ?? null;
    return {
      unit: unitOf(state),
      goal,
      latest: latest ? { ...latest, vs_goal: goal !== null ? round1(latest.weight - goal) : null } : null,
      change_7d: latest ? change(all, latest, 7) : null,
      change_30d: latest ? change(all, latest, 30) : null,
      entries,
    };
  }

  /** Training and weight over the `days` up to `to`: sessions, volume, PRs, weight change. */
  async summary(opts: { days?: number; to?: string; timeZone?: string } = {}) {
    const state = await this.state();
    const days = opts.days ?? 7;
    const to = opts.to ?? this.today(opts.timeZone);
    const from = addDays(to, -(days - 1));
    const prevFrom = addDays(from, -days);
    const all = workoutsOf(state);
    const inRange = (w: GymWorkout, a: string, b: string) => w.date >= a && w.date <= b;
    const now = all.filter((w) => inRange(w, from, to));
    const before = all.filter((w) => inRange(w, prevFrom, addDays(from, -1)));
    const names = await this.names.resolve(
      now.flatMap((w) => w.prs),
      state,
    );
    const weighIns = weighInsOf(state);
    const end = weightOn(weighIns, to);
    const start = weightOn(weighIns, addDays(from, -1)) ?? weighIns.find((w) => w.date >= from && w.date <= to) ?? null;
    const last = all.at(-1) ?? null;
    return {
      unit: unitOf(state),
      from,
      to,
      sessions: now.length,
      sessions_previous_period: before.length,
      volume: now.reduce((n, w) => n + workoutVolume(w), 0),
      volume_previous_period: before.reduce((n, w) => n + workoutVolume(w), 0),
      sets_done: now.reduce((n, w) => n + setsDone(w), 0),
      prs: [...new Set(now.flatMap((w) => w.prs).map((id) => names.get(id)?.name ?? id))],
      days_since_last_workout: last ? daysBetween(last.date, to) : null,
      last_workout: last ? row(last) : null,
      weight: end
        ? { latest: end, goal: goalWeight(state), change: start && start.date !== end.date ? round1(end.weight - start.weight) : null, since: start && start.date !== end.date ? start.date : null }
        : null,
    };
  }
}

/** Change from the weigh-in about `days` before `latest` (the nearest on or before that day). */
function change(all: WeighIn[], latest: WeighIn, days: number): number | null {
  const then = weightOn(all, addDays(latest.date, -days));
  return then ? round1(latest.weight - then.weight) : null;
}
