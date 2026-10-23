import { timingSafeEqual } from "node:crypto";

export function tokenMatches(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | undefined {
  return header?.match(/^Bearer (.+)$/)?.[1];
}
