import type { GymState } from "./model";

/**
 * Exercise names. The state stores exercise ids only: the profile's own exercises are in
 * `customEx` with their names, and library exercises are looked up one file at a time in
 * openGym's public catalogue (catalogue/exercises/<id>.json) and cached for the process. An id
 * that can't be resolved reads as "exercise <id>", so a lookup failure never hides a workout.
 */
export const OPENGYM_CATALOGUE = "https://raw.githubusercontent.com/DuarteSantos8/openGym/main/catalogue/exercises";

export interface ExerciseInfo {
  name: string;
  bodyPart: string | null;
  target: string | null;
}

export class ExerciseNames {
  private readonly cache = new Map<string, ExerciseInfo | null>();
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { catalogueUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.base = (options.catalogueUrl ?? OPENGYM_CATALOGUE).replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  /** Names for `ids`, from the profile's own exercises first, then the catalogue. */
  async resolve(ids: Iterable<string>, state: GymState | null): Promise<Map<string, ExerciseInfo>> {
    const out = new Map<string, ExerciseInfo>();
    const custom = new Map<string, ExerciseInfo>();
    for (const c of Array.isArray(state?.customEx) ? state.customEx : []) {
      if (c && typeof c === "object" && typeof c.id === "string" && typeof c.n === "string") {
        custom.set(c.id, { name: c.n, bodyPart: typeof c.bp === "string" ? c.bp : null, target: typeof c.tg === "string" ? c.tg : null });
      }
    }
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const own = custom.get(id);
      if (own) out.set(id, own);
      else missing.push(id);
    }
    await Promise.all(
      missing.map(async (id) => {
        out.set(id, (await this.lookup(id)) ?? { name: `exercise ${id}`, bodyPart: null, target: null });
      }),
    );
    return out;
  }

  private async lookup(id: string): Promise<ExerciseInfo | null> {
    if (this.cache.has(id)) return this.cache.get(id) ?? null;
    // Catalogue ids are digits; anything else (a custom exercise deleted on another device) has no file.
    if (!/^\d{1,6}$/.test(id)) {
      this.cache.set(id, null);
      return null;
    }
    try {
      const res = await this.fetch(`${this.base}/${id}.json`, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
      if (res.status === 404) {
        this.cache.set(id, null);
        return null;
      }
      if (!res.ok) return null; // not cached: try again next time
      const b = (await res.json()) as { name?: unknown; bodyPart?: unknown; target?: unknown };
      const info = typeof b.name === "string" ? { name: b.name, bodyPart: typeof b.bodyPart === "string" ? b.bodyPart : null, target: typeof b.target === "string" ? b.target : null } : null;
      this.cache.set(id, info);
      return info;
    } catch {
      return null;
    }
  }
}
