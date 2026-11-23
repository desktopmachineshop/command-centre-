import { applyLexicon, type Lexicon } from "@cc/voice/lesson";

/**
 * The brain's pronunciation list for the browser's own voice (the server's voices apply it
 * themselves, in POST /api/voice/speak). Said text only: what is shown is never changed.
 */
let lexicon: Lexicon = new Map();
let loadedAt = 0;
let fetcher: (() => Promise<[string, string][]>) | null = null;
const TTL_MS = 60_000;

/** createApi registers where the list comes from. */
export function setPronunciationSource(source: (() => Promise<[string, string][]>) | null): void {
  fetcher = source;
  loadedAt = 0;
}

/** Reloads the list when it is over a minute old (never throws; the last list stays on failure). */
export function refreshPronunciation(now = Date.now()): Promise<void> {
  if (!fetcher || now - loadedAt < TTL_MS) return Promise.resolve();
  loadedAt = now;
  return fetcher().then(
    (entries) => {
      lexicon = new Map(entries);
    },
    () => {},
  );
}

/** `text` as it should be said. Pure apart from the loaded list. */
export const pronounce = (text: string): string => applyLexicon(text, lexicon);

/** For tests. */
export function setPronunciation(entries: [string, string][]): void {
  lexicon = new Map(entries);
}
