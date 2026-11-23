import type { LearningView, Lesson } from "../api";

/**
 * Lessons in Converse (pages/Drive.tsx): which lessons to offer, how to say them, and which one a
 * spoken request means. Pure.
 */

/** What Dave asked for: today's lesson, the one he was listening to, a number from the list just read, or a topic. */
export type LessonPick = { kind: "today" } | { kind: "continue" } | { kind: "number"; n: number } | { kind: "topic"; text: string };

/** The lessons worth offering, in order: today's, then the ones started, then the rest not done, newest first. */
export function lessonsToOffer(view: Pick<LearningView, "lessons" | "todays">, max = 5): Lesson[] {
  const open = view.lessons.filter((l) => l.status !== "done");
  const started = open.filter((l) => (l.percent ?? 0) > 0).sort((a, b) => lastTouched(b) - lastTouched(a));
  const rest = open.filter((l) => (l.percent ?? 0) <= 0);
  const ordered = [...(view.todays ? [view.todays] : []), ...started, ...rest];
  const seen = new Set<string>();
  return ordered.filter((l) => !seen.has(l.path) && seen.add(l.path)).slice(0, max);
}

const lastTouched = (l: Lesson) => Math.max(Date.parse(l.progress?.audioAt ?? "") || 0, Date.parse(l.progress?.readAt ?? "") || 0);

const ORDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** What Converse says for the list: each lesson with how far through it is. */
export function lessonsLine(offered: Lesson[], total: number): string {
  if (!offered.length) return "There are no lessons waiting. Today's arrives in the morning, or ask for a topic in Learning.";
  const items = offered.map((l, i) => {
    const pct = l.percent ?? 0;
    const where = !l.audio ? "not recorded yet" : pct > 0 ? `${pct} percent through` : "not started";
    return `${cap(ORDINALS[i] ?? String(i + 1))}: ${l.title}, ${where}.`;
  });
  const more = total > offered.length ? ` There are ${total - offered.length} more on the Learning page.` : "";
  return `You've got ${offered.length === 1 ? "one lesson" : `${offered.length} lessons`}. ${items.join(" ")}${more} Say "play lesson one", or the topic.`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The lesson a request means, or null. `offered` is the list last read out (for "lesson two"). */
export function pickLesson(view: Pick<LearningView, "lessons" | "todays">, pick: LessonPick, offered: Lesson[]): Lesson | null {
  const open = view.lessons.filter((l) => l.status !== "done");
  switch (pick.kind) {
    case "today":
      return view.todays ?? open[0] ?? null;
    case "continue": {
      const started = open.filter((l) => (l.percent ?? 0) > 0).sort((a, b) => lastTouched(b) - lastTouched(a));
      return started[0] ?? view.todays ?? open[0] ?? null;
    }
    case "number": {
      const list = offered.length ? offered : lessonsToOffer(view);
      return list[pick.n - 1] ?? null;
    }
    case "topic": {
      const words = significant(pick.text);
      if (!words.length) return null;
      let best: { l: Lesson; score: number } | null = null;
      for (const l of view.lessons) {
        const hay = significant(`${l.title} ${l.topic} ${l.summary}`);
        const score = words.filter((w) => hay.some((h) => h === w || (w.length > 4 && (h.startsWith(w) || w.startsWith(h))))).length / words.length;
        // Unfinished lessons win a tie.
        const s = score + (l.status !== "done" ? 0.01 : 0);
        if (score >= 0.5 && (!best || s > best.score)) best = { l, score: s };
      }
      return best?.l ?? null;
    }
  }
}

const STOP = new Set(["the", "a", "an", "on", "about", "of", "and", "for", "to", "in", "how", "why", "what", "lesson", "one", "my", "it", "is"]);
function significant(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** "one" / "2" / "second" as a number. */
export function spokenNumber(word: string): number | null {
  const w = word.toLowerCase();
  const ord = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"].indexOf(w);
  if (ord >= 0) return ord + 1;
  const n = ORDINALS.indexOf(w);
  if (n >= 0) return n + 1;
  return /^\d{1,2}$/.test(w) ? Number(w) : null;
}
