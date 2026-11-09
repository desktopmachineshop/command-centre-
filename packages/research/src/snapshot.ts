import { createHash, randomUUID } from "node:crypto";
import type { Catalogue, CatalogueProduct } from "./products";

/**
 * A compact, dated record of what a competitor's shop showed (products with price and stock, and
 * a few watched pages such as shipping and returns), and the difference between two of them.
 * Snapshots are facts read on a date: the diff only ever compares what two snapshots contain.
 */

export interface SnapshotProduct {
  key: string;
  name: string;
  url: string;
  sku?: string;
  price?: number;
  currency?: string;
  available: boolean | null;
}

export interface SnapshotPage {
  url: string;
  title: string | null;
  /** sha256 of the page's readable text. */
  hash: string;
  /** The start of the readable text, to show what a changed page says now. */
  excerpt: string;
}

export interface Snapshot {
  id: string;
  /** The business that watches this competitor. */
  vertical: string;
  /** The competitor's slug in that business's registry. */
  competitor: string;
  site: string;
  takenAt: string;
  source: Catalogue["source"];
  currency: string | null;
  /** The catalogue was cut at the limit, so "removed" can't be told from "not read". */
  truncated: boolean;
  products: SnapshotProduct[];
  pages: SnapshotPage[];
}

export type SnapshotMeta = Pick<Snapshot, "id" | "vertical" | "competitor" | "site" | "takenAt" | "source"> & { products: number; pages: number };

/** Where snapshots are kept. The server's is Postgres (`competitor_snapshots`); tests use MemorySnapshotStore. */
export interface SnapshotStore {
  save(snapshot: Snapshot): Promise<void>;
  /** The newest snapshot of a competitor, or the newest taken at or before `before`. */
  latest(vertical: string, competitor: string, before?: Date): Promise<Snapshot | null>;
  /** The newest two, newest first. */
  lastTwo(vertical: string, competitor: string): Promise<Snapshot[]>;
  list(vertical: string, competitor?: string, limit?: number): Promise<SnapshotMeta[]>;
}

export const metaOf = (s: Snapshot): SnapshotMeta => ({ id: s.id, vertical: s.vertical, competitor: s.competitor, site: s.site, takenAt: s.takenAt, source: s.source, products: s.products.length, pages: s.pages.length });

export class MemorySnapshotStore implements SnapshotStore {
  readonly snapshots: Snapshot[] = [];
  async save(snapshot: Snapshot): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
  }
  private of(vertical: string, competitor?: string): Snapshot[] {
    return this.snapshots.filter((s) => s.vertical === vertical && (!competitor || s.competitor === competitor)).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }
  async latest(vertical: string, competitor: string, before?: Date): Promise<Snapshot | null> {
    return this.of(vertical, competitor).find((s) => !before || s.takenAt <= before.toISOString()) ?? null;
  }
  async lastTwo(vertical: string, competitor: string): Promise<Snapshot[]> {
    return this.of(vertical, competitor).slice(0, 2);
  }
  async list(vertical: string, competitor?: string, limit = 50): Promise<SnapshotMeta[]> {
    return this.of(vertical, competitor).slice(0, limit).map(metaOf);
  }
}

export const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export const textHash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");

const snapProduct = (p: CatalogueProduct): SnapshotProduct => ({
  key: p.key,
  name: p.name,
  url: p.url,
  ...(p.sku ? { sku: p.sku } : {}),
  ...(p.price !== undefined ? { price: p.price } : {}),
  ...(p.currency ? { currency: p.currency } : {}),
  available: p.available,
});

export function buildSnapshot(input: { vertical: string; competitor: string; catalogue: Catalogue; pages?: SnapshotPage[]; now?: Date }): Snapshot {
  return {
    id: randomUUID(),
    vertical: input.vertical,
    competitor: input.competitor,
    site: input.catalogue.site,
    takenAt: (input.now ?? new Date()).toISOString(),
    source: input.catalogue.source,
    currency: input.catalogue.currency,
    truncated: input.catalogue.truncated,
    products: input.catalogue.products.map(snapProduct),
    pages: input.pages ?? [],
  };
}

export interface PriceChange {
  key: string;
  name: string;
  url: string;
  from: number;
  to: number;
  currency: string | null;
  /** Percentage change, one decimal; negative is a price cut. */
  percent: number;
}

export interface SnapshotDiff {
  competitor: string;
  from: { id: string; takenAt: string; products: number } | null;
  to: { id: string; takenAt: string; products: number };
  /** First snapshot: there is nothing to compare with yet. */
  first: boolean;
  newProducts: SnapshotProduct[];
  removedProducts: SnapshotProduct[];
  priceChanges: PriceChange[];
  outOfStock: SnapshotProduct[];
  backInStock: SnapshotProduct[];
  pagesChanged: { url: string; title: string | null; excerpt: string }[];
  unchanged: number;
  /** Reasons to distrust this diff (a failed read looks like "everything was removed"). */
  warnings: string[];
}

/** What changed from `prev` to `next`. Products are matched by key, then by URL (a shop that moved platform keeps its URLs more often than its ids). */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot): SnapshotDiff {
  const to = { id: next.id, takenAt: next.takenAt, products: next.products.length };
  const empty = { newProducts: [], removedProducts: [], priceChanges: [], outOfStock: [], backInStock: [], pagesChanged: [], unchanged: 0 };
  if (!prev) return { competitor: next.competitor, from: null, to, first: true, ...empty, warnings: [] };
  const warnings: string[] = [];
  const byKey = new Map(prev.products.map((p) => [p.key, p]));
  const byUrl = new Map(prev.products.map((p) => [p.url, p]));
  const matched = new Set<SnapshotProduct>();
  const diff: SnapshotDiff = { competitor: next.competitor, from: { id: prev.id, takenAt: prev.takenAt, products: prev.products.length }, to, first: false, ...empty, warnings };

  for (const p of next.products) {
    const old = byKey.get(p.key) ?? byUrl.get(p.url);
    if (!old || matched.has(old)) {
      diff.newProducts.push(p);
      continue;
    }
    matched.add(old);
    let changed = false;
    if (old.price !== undefined && p.price !== undefined && old.price !== p.price && (old.currency ?? null) === (p.currency ?? null)) {
      diff.priceChanges.push({ key: p.key, name: p.name, url: p.url, from: old.price, to: p.price, currency: p.currency ?? null, percent: old.price ? Math.round(((p.price - old.price) / old.price) * 1000) / 10 : 0 });
      changed = true;
    }
    if (old.available === true && p.available === false) {
      diff.outOfStock.push(p);
      changed = true;
    } else if (old.available === false && p.available === true) {
      diff.backInStock.push(p);
      changed = true;
    }
    if (!changed) diff.unchanged++;
  }
  diff.removedProducts = prev.products.filter((p) => !matched.has(p));

  const oldPages = new Map(prev.pages.map((p) => [p.url, p]));
  for (const page of next.pages) {
    const old = oldPages.get(page.url);
    if (old && old.hash !== page.hash) diff.pagesChanged.push({ url: page.url, title: page.title, excerpt: page.excerpt });
  }

  if (prev.source !== next.source) {
    warnings.push(`The catalogue was read a different way this time (${prev.source} then, ${next.source} now): new and removed products may just be the two sources naming things differently`);
  }
  if ((prev.currency ?? null) !== (next.currency ?? null)) warnings.push(`The currency differs (${prev.currency ?? "unknown"} then, ${next.currency ?? "unknown"} now): prices were not compared across currencies`);
  if (prev.products.length >= 5 && next.products.length < prev.products.length / 2) {
    warnings.push(`Far fewer products were read this time (${next.products.length} against ${prev.products.length}): the read probably failed or was blocked, so don't report these as removed without checking the shop`);
  }
  if (next.truncated || prev.truncated) warnings.push("A catalogue was cut at the read limit, so some products marked new or removed may only have fallen outside it");
  return diff;
}

/** A diff trimmed for an agent: counts, and at most `max` rows of each kind (biggest price moves first). */
export function summariseDiff(diff: SnapshotDiff, max = 40) {
  const cut = <T>(rows: T[]) => (rows.length > max ? { count: rows.length, shown: max, rows: rows.slice(0, max) } : { count: rows.length, rows });
  return {
    competitor: diff.competitor,
    from: diff.from,
    to: diff.to,
    first: diff.first,
    counts: {
      new: diff.newProducts.length,
      removed: diff.removedProducts.length,
      priceChanges: diff.priceChanges.length,
      outOfStock: diff.outOfStock.length,
      backInStock: diff.backInStock.length,
      pagesChanged: diff.pagesChanged.length,
      unchanged: diff.unchanged,
    },
    newProducts: cut(diff.newProducts),
    removedProducts: cut(diff.removedProducts),
    priceChanges: cut([...diff.priceChanges].sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent))),
    outOfStock: cut(diff.outOfStock),
    backInStock: cut(diff.backInStock),
    pagesChanged: diff.pagesChanged,
    warnings: diff.warnings,
  };
}
