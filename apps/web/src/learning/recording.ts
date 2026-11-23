
/** The chapter playing at `t` seconds (index into `chapters`). Pure. */
export function chapterAt(chapters: { at: number }[], t: number): number {
  let i = 0;
  for (let j = 0; j < chapters.length; j++) if (chapters[j]!.at <= t + 0.05) i = j;
  return i;
}

/** "4:05", "1:02:09". Pure. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/**
 * Where "previous chapter" goes: the start of this chapter if more than 3 s in, else the one
 * before. Pure.
 */
export function previousChapterStart(chapters: { at: number }[], t: number): number {
  const i = chapterAt(chapters, t);
  if (t - (chapters[i]?.at ?? 0) > 3 || i === 0) return chapters[i]?.at ?? 0;
  return chapters[i - 1]!.at;
}

export const SPEEDS = [0.9, 1, 1.1, 1.25, 1.5] as const;
