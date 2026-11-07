/**
 * Reading openGym's state document. Only the fields Command Centre uses are typed, and every
 * read is defensive: the document is written by the app on several devices across versions.
 *
 * - `workouts[]`: `{ id, d: "YYYY-MM-DD", name, routineId, start, end, entries[], prs[], vol, bw, gym }`;
 *   an entry is `{ id: exerciseId, sets[] }`, a set `{ w, r, done, phase|warmup, sides? }`.
 * - `bodyweight[]`: `{ d, w }`, `w` being the day's value (the profile's "daily weigh-in value").
 * - `targetW`: the goal weight; `unit`: "kg" or "lb"; `customEx[]`: the profile's own exercises.
 */

export type GymState = Record<string, unknown>;

export interface GymSet {
  w?: number;
  r?: number;
  done?: boolean;
  phase?: string;
  warmup?: boolean;
  sides?: { L?: GymSet; R?: GymSet };
  [key: string]: unknown;
}

export interface GymEntry {
  id: string;
  sets: GymSet[];
}

export interface GymWorkout {
  id: string | null;
  date: string;
  name: string | null;
  start: number | null;
  end: number | null;
  entries: GymEntry[];
  prs: string[];
  vol: number | null;
  bw: number | null;
  gym: string | null;
}

export interface WeighIn {
  date: string;
  weight: number;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function unitOf(state: GymState | null): "kg" | "lb" {
  return state?.unit === "lb" ? "lb" : "kg";
}

export function goalWeight(state: GymState | null): number | null {
  return num(state?.targetW);
}

function toSet(v: unknown): GymSet | null {
  return v && typeof v === "object" ? (v as GymSet) : null;
}

/** Every finished workout, oldest first; rows without a valid day are skipped. */
export function workoutsOf(state: GymState | null): GymWorkout[] {
  const out: GymWorkout[] = [];
  for (const raw of arr(state?.workouts)) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    if (!isDay(w.d)) continue;
    const gym = w.gym && typeof w.gym === "object" ? str((w.gym as { name?: unknown }).name) : null;
    out.push({
      id: str(w.id),
      date: w.d,
      name: str(w.name),
      start: num(w.start),
      end: num(w.end),
      entries: arr(w.entries)
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")
        .map((e) => ({ id: e.id as string, sets: arr(e.sets).map(toSet).filter((s): s is GymSet => !!s) })),
      prs: arr(w.prs).filter((p): p is string => typeof p === "string"),
      vol: num(w.vol),
      bw: num(w.bw),
      gym,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
}

/** One value per day, oldest first. */
export function weighInsOf(state: GymState | null): WeighIn[] {
  const out: WeighIn[] = [];
  for (const raw of arr(state?.bodyweight)) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const weight = num(b.w);
    if (!isDay(b.d) || weight === null || weight <= 0) continue;
    out.push({ date: b.d, weight });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const isWarmup = (s: GymSet): boolean => (s.phase != null && s.phase !== "" ? s.phase === "warmup" : s.warmup === true);

/** Completed units: each side of a per-side set counts as one, as in the app. */
export function doneUnits(s: GymSet): number {
  if (s.sides && typeof s.sides === "object") return (s.sides.L?.done ? 1 : 0) + (s.sides.R?.done ? 1 : 0);
  return s.done ? 1 : 0;
}

export function plannedUnits(s: GymSet): number {
  return s.sides && typeof s.sides === "object" ? 2 : 1;
}

/** Weight × reps of the completed work sets (per side where logged per side). */
export function setVolume(s: GymSet): number {
  if (isWarmup(s)) return 0;
  if (s.sides && typeof s.sides === "object") return [s.sides.L, s.sides.R].reduce((n, side) => n + (side?.done ? (num(side.w) ?? 0) * (num(side.r) ?? 0) : 0), 0);
  return s.done ? (num(s.w) ?? 0) * (num(s.r) ?? 0) : 0;
}

/** The volume the app saved with the session (work sets only), else counted from its sets. */
export function workoutVolume(w: GymWorkout): number {
  if (w.vol !== null) return Math.round(w.vol);
  return Math.round(w.entries.reduce((n, e) => n + e.sets.reduce((m, s) => m + setVolume(s), 0), 0));
}

export function setsDone(w: GymWorkout): number {
  return w.entries.reduce((n, e) => n + e.sets.reduce((m, s) => m + doneUnits(s), 0), 0);
}

export function setsPlanned(w: GymWorkout): number {
  return w.entries.reduce((n, e) => n + e.sets.reduce((m, s) => m + plannedUnits(s), 0), 0);
}

export function durationMinutes(w: GymWorkout): number | null {
  return w.start !== null && w.end !== null && w.end > w.start ? Math.round((w.end - w.start) / 60_000) : null;
}

/** A set as a short label, e.g. "8 × 60 kg", "L 10 × 14 / R 9 × 14 kg", "warm-up 10 × 20 kg". */
export function setLabel(s: GymSet, unit: string): string {
  const one = (x: GymSet | undefined) => {
    const r = num(x?.r) ?? 0;
    const w = num(x?.w) ?? 0;
    return w > 0 ? `${r} × ${w}` : `${r}`;
  };
  const body = s.sides && typeof s.sides === "object" ? `L ${one(s.sides.L)} / R ${one(s.sides.R)}` : one(s);
  const loaded = s.sides ? (num(s.sides.L?.w) ?? 0) + (num(s.sides.R?.w) ?? 0) > 0 : (num(s.w) ?? 0) > 0;
  return `${isWarmup(s) ? "warm-up " : ""}${body}${loaded ? ` ${unit}` : " reps"}${doneUnits(s) ? "" : " (not done)"}`;
}

/** Best estimated 1RM (Epley) among the completed work sets of one exercise, up to 12 reps. */
export function bestE1rm(sets: GymSet[]): number | null {
  let best: number | null = null;
  const consider = (x: GymSet | undefined) => {
    const w = num(x?.w) ?? 0;
    const r = num(x?.r) ?? 0;
    if (!x?.done || w <= 0 || r < 1 || r > 12) return;
    const e = r === 1 ? w : w * (1 + r / 30);
    if (best === null || e > best) best = e;
  };
  for (const s of sets) {
    if (isWarmup(s)) continue;
    if (s.sides) {
      consider(s.sides.L);
      consider(s.sides.R);
    } else consider(s);
  }
  return best === null ? null : Math.round((best as number) * 10) / 10;
}

/** Days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** Adds `days` to an ISO date. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The weigh-in on or before `day`, else null. */
export function weightOn(weighIns: WeighIn[], day: string): WeighIn | null {
  let found: WeighIn | null = null;
  for (const w of weighIns) {
    if (w.date > day) break;
    found = w;
  }
  return found;
}
