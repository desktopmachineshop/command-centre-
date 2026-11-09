import { decodeEntities, extractPage } from "./html";
import type { SafeFetchResult } from "./safe-fetch";

/**
 * A shop's catalogue from its own public endpoints, tried in order:
 * 1. Shopify's `/products.json` (paged);
 * 2. WooCommerce's Store API (`/wp-json/wc/store/v1/products`, paged);
 * 3. `sitemap.xml` (and the sitemaps `robots.txt` names): product page URLs, optionally read one
 *    by one for their structured data (`enrich`).
 * Each is a plain GET of a page the shop publishes for anyone. Nothing is guessed: a price or
 * stock state the source doesn't give is left out.
 */

export interface CatalogueProduct {
  /** Stable within the site: the handle, the product id or the URL path. Snapshots are diffed on it. */
  key: string;
  name: string;
  url: string;
  sku?: string;
  /** The (lowest variant) price. */
  price?: number;
  priceMax?: number;
  /** A struck-through "was" price, when the shop shows one. */
  compareAtPrice?: number;
  currency?: string;
  /** null: the source doesn't say. */
  available: boolean | null;
  vendor?: string;
  category?: string;
  variants?: number;
}

export interface Catalogue {
  site: string;
  source: "shopify" | "woocommerce" | "sitemap" | "none";
  currency: string | null;
  products: CatalogueProduct[];
  /** More products exist than were read (the `limit`). */
  truncated: boolean;
  /** What was tried and what each answered, for the agent's report. */
  notes: string[];
}

/** GET a URL as text: the research server passes `safeFetch` bound to its options. */
export type Get = (url: string) => Promise<SafeFetchResult>;

export interface DiscoverOptions {
  /** Most products returned. Default 500. */
  limit?: number;
  /** With a sitemap source: read up to this many product pages for name, price and stock. Default 0. */
  enrich?: number;
  /** Pause between requests to the same shop. Default 400 ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** "rival-tools.co.uk", "https://rival-tools.co.uk/shop" -> "https://rival-tools.co.uk". */
export function siteOrigin(site: string): string {
  const raw = site.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return url.origin;
}

async function getJson(get: Get, url: string): Promise<{ status: number; data: unknown; finalUrl: string } | null> {
  try {
    const res = await get(url);
    if (res.status !== 200) return { status: res.status, data: null, finalUrl: res.url };
    try {
      return { status: 200, data: JSON.parse(res.text), finalUrl: res.url };
    } catch {
      return { status: 200, data: null, finalUrl: res.url };
    }
  } catch {
    return null;
  }
}

interface ShopifyVariant {
  sku?: string | null;
  price?: string | number | null;
  compare_at_price?: string | number | null;
  available?: boolean;
}
interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  variants?: ShopifyVariant[];
}

export function shopifyProduct(p: ShopifyProduct, origin: string, currency: string | null): CatalogueProduct | null {
  if (!p.handle || !p.title) return null;
  const variants = p.variants ?? [];
  const prices = variants.map((v) => num(v.price)).filter((n): n is number => n !== undefined);
  const compare = variants.map((v) => num(v.compare_at_price)).filter((n): n is number => n !== undefined && n > 0);
  const known = variants.filter((v) => typeof v.available === "boolean");
  const out: CatalogueProduct = {
    key: p.handle,
    name: p.title,
    url: `${origin}/products/${p.handle}`,
    available: known.length ? known.some((v) => v.available) : null,
  };
  const sku = variants.find((v) => v.sku)?.sku;
  if (sku) out.sku = sku;
  if (prices.length) {
    out.price = Math.min(...prices);
    if (Math.max(...prices) !== out.price) out.priceMax = Math.max(...prices);
  }
  if (compare.length && out.price !== undefined && Math.min(...compare) > out.price) out.compareAtPrice = Math.min(...compare);
  if (currency) out.currency = currency;
  if (p.vendor) out.vendor = p.vendor;
  if (p.product_type) out.category = p.product_type;
  if (variants.length > 1) out.variants = variants.length;
  return out;
}

async function shopify(get: Get, origin: string, o: Required<Pick<DiscoverOptions, "limit" | "delayMs" | "sleep">>, notes: string[]): Promise<Catalogue | null> {
  const products: CatalogueProduct[] = [];
  let currency: string | null = null;
  let truncated = false;
  for (let page = 1; page <= 20; page++) {
    const res = await getJson(get, `${origin}/products.json?limit=250&page=${page}`);
    const list = (res?.data as { products?: ShopifyProduct[] } | null)?.products;
    if (!res || !Array.isArray(list)) {
      if (page === 1) {
        notes.push(`Shopify /products.json: ${res ? (res.status === 200 ? "not a product list" : `HTTP ${res.status}`) : "no answer"}`);
        return null;
      }
      notes.push(`Shopify /products.json page ${page} failed; the list may be incomplete`);
      truncated = true;
      break;
    }
    if (page === 1) {
      if (!list.length) {
        notes.push("Shopify /products.json: an empty list");
        return null;
      }
      // Shopify's product list has no currency; the shop's /meta.json names it.
      const meta = await getJson(get, `${origin}/meta.json`);
      const c = (meta?.data as { currency?: unknown } | null)?.currency;
      if (typeof c === "string" && /^[A-Za-z]{3}$/.test(c)) currency = c.toUpperCase();
      else notes.push("The shop doesn't state its currency in /meta.json: check it on a product page before comparing prices");
    }
    for (const p of list) {
      const row = shopifyProduct(p, origin, currency);
      if (row) products.push(row);
    }
    if (products.length >= o.limit) {
      truncated = list.length === 250 || products.length > o.limit;
      break;
    }
    if (list.length < 250) break;
    await o.sleep(o.delayMs);
  }
  notes.push(`Shopify /products.json: ${products.length} products`);
  return { site: origin, source: "shopify", currency, products: products.slice(0, o.limit), truncated, notes };
}

interface WooProduct {
  id?: number;
  name?: string;
  sku?: string;
  permalink?: string;
  is_in_stock?: boolean;
  prices?: { price?: string; regular_price?: string; price_range?: { min_amount?: string; max_amount?: string } | null; currency_code?: string; currency_minor_unit?: number };
  categories?: { name?: string }[];
  type?: string;
}

export function wooProduct(p: WooProduct): CatalogueProduct | null {
  if (!p.name || !p.permalink || p.id === undefined) return null;
  // Store API prices are integers in the currency's minor unit ("1299" = 12.99).
  const unit = 10 ** (p.prices?.currency_minor_unit ?? 2);
  const minor = (v: string | undefined) => {
    const n = num(v);
    return n === undefined ? undefined : n / unit;
  };
  const out: CatalogueProduct = { key: String(p.id), name: decodeEntities(p.name), url: p.permalink, available: typeof p.is_in_stock === "boolean" ? p.is_in_stock : null };
  if (p.sku) out.sku = p.sku;
  const low = minor(p.prices?.price_range?.min_amount) ?? minor(p.prices?.price);
  const high = minor(p.prices?.price_range?.max_amount);
  const regular = minor(p.prices?.regular_price);
  if (low !== undefined) out.price = low;
  if (high !== undefined && low !== undefined && high > low) out.priceMax = high;
  if (regular !== undefined && low !== undefined && regular > low) out.compareAtPrice = regular;
  if (p.prices?.currency_code) out.currency = p.prices.currency_code.toUpperCase();
  const category = p.categories?.[0]?.name;
  if (category) out.category = decodeEntities(category);
  return out;
}

async function woocommerce(get: Get, origin: string, o: Required<Pick<DiscoverOptions, "limit" | "delayMs" | "sleep">>, notes: string[]): Promise<Catalogue | null> {
  const products: CatalogueProduct[] = [];
  let truncated = false;
  for (let page = 1; page <= 30; page++) {
    const res = await getJson(get, `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    const list = res?.data;
    if (!res || !Array.isArray(list)) {
      if (page === 1) {
        notes.push(`WooCommerce Store API: ${res ? (res.status === 200 ? "not a product list" : `HTTP ${res.status}`) : "no answer"}`);
        return null;
      }
      notes.push(`WooCommerce Store API page ${page} failed; the list may be incomplete`);
      truncated = true;
      break;
    }
    if (page === 1 && !list.length) {
      notes.push("WooCommerce Store API: an empty list");
      return null;
    }
    for (const p of list as WooProduct[]) {
      const row = wooProduct(p);
      if (row) products.push(row);
    }
    if (products.length >= o.limit) {
      truncated = list.length === 100 || products.length > o.limit;
      break;
    }
    if (list.length < 100) break;
    await o.sleep(o.delayMs);
  }
  notes.push(`WooCommerce Store API: ${products.length} products`);
  return { site: origin, source: "woocommerce", currency: products.find((p) => p.currency)?.currency ?? null, products: products.slice(0, o.limit), truncated, notes };
}

/** `<loc>` values of a sitemap or sitemap index. */
export function sitemapLocs(xml: string): { sitemaps: string[]; urls: string[] } {
  const locs = (block: string) => [...block.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));
  const sitemaps = [...xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)].flatMap((m) => locs(m[1]!));
  const urls = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].flatMap((m) => locs(m[1]!).slice(0, 1));
  return { sitemaps, urls };
}

/** URL paths that look like one product's page (not a category or the shop's front page). */
const PRODUCT_PATH = /\/(products?|produkt|produit|producto|item|p|shop|store|catalog(?:ue)?)\/[^/?#]+\/?$/i;
const NOT_PRODUCT = /\/(category|categories|collections?|tag|tags|page|cart|checkout|account|blog|news)\//i;

export const isProductUrl = (url: string) => PRODUCT_PATH.test(url.split(/[?#]/)[0]!) && !NOT_PRODUCT.test(url);

const titleFromPath = (url: string) => {
  const slug = decodeURIComponent(new URL(url).pathname.replace(/\/$/, "").split("/").pop() ?? "").replace(/\.(html?|php|aspx?)$/i, "");
  const words = slug.replace(/[-_+]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : url;
};

async function sitemap(get: Get, origin: string, o: Required<Pick<DiscoverOptions, "limit" | "delayMs" | "sleep" | "enrich">>, notes: string[]): Promise<Catalogue | null> {
  const queue: string[] = [];
  try {
    const robots = await get(`${origin}/robots.txt`);
    if (robots.status === 200) for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]!);
  } catch {
    // No robots.txt: fall through to the default name.
  }
  if (!queue.length) queue.push(`${origin}/sitemap.xml`);
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const seenMaps = new Set<string>();
  const urls = new Set<string>();
  let fetched = 0;
  let truncated = false;
  while (queue.length && fetched < 12) {
    // Sitemaps named for products first.
    queue.sort((a, b) => Number(/product/i.test(b)) - Number(/product/i.test(a)));
    const next = queue.shift()!;
    if (seenMaps.has(next)) continue;
    seenMaps.add(next);
    let xml: SafeFetchResult;
    try {
      xml = await get(next);
    } catch {
      continue;
    }
    fetched++;
    if (xml.status !== 200) continue;
    const { sitemaps, urls: found } = sitemapLocs(xml.text);
    queue.push(...sitemaps.filter((s) => !seenMaps.has(s)));
    for (const u of found) {
      let h: string;
      try {
        h = new URL(u).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (h === host && isProductUrl(u)) urls.add(u);
    }
    if (urls.size >= o.limit) {
      truncated = true;
      break;
    }
    if (queue.length) await o.sleep(o.delayMs);
  }
  if (!urls.size) {
    notes.push(`Sitemap: ${fetched ? "no product page URLs found" : "no sitemap found"}`);
    return null;
  }
  const products: CatalogueProduct[] = [...urls].slice(0, o.limit).map((url) => ({ key: new URL(url).pathname.replace(/\/$/, ""), name: titleFromPath(url), url, available: null }));
  notes.push(`Sitemap: ${products.length} product page URLs (names are from the URLs; prices and stock only for pages read with enrich)`);
  let read = 0;
  for (const p of products.slice(0, o.enrich)) {
    await o.sleep(o.delayMs);
    try {
      const page = await get(p.url);
      if (page.status !== 200) continue;
      const extract = extractPage(page.text, page.url, { maxText: 0, maxLinks: 0 });
      const s = extract.products[0];
      if (s?.name) p.name = s.name;
      else if (extract.title) p.name = extract.title;
      if (s?.price !== undefined) p.price = s.price;
      if (s?.priceMax !== undefined) p.priceMax = s.priceMax;
      if (s?.currency) p.currency = s.currency;
      if (s?.sku) p.sku = s.sku;
      if (s?.availability) p.available = s.availability === "InStock" || s.availability === "LimitedAvailability" ? true : s.availability === "OutOfStock" || s.availability === "SoldOut" || s.availability === "Discontinued" ? false : null;
      read++;
    } catch {
      // One unreadable page doesn't spoil the list.
    }
  }
  if (o.enrich) notes.push(`Read ${read} of the first ${Math.min(o.enrich, products.length)} product pages for price and stock`);
  return { site: origin, source: "sitemap", currency: products.find((p) => p.currency)?.currency ?? null, products, truncated, notes };
}

/** The shop's catalogue, from the first source that answers. Never throws for a shop that has none: `source` is "none". */
export async function discoverProducts(site: string, get: Get, options: DiscoverOptions = {}): Promise<Catalogue> {
  const origin = siteOrigin(site);
  const o = {
    limit: options.limit ?? 500,
    enrich: options.enrich ?? 0,
    delayMs: options.delayMs ?? 400,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const notes: string[] = [];
  const found = (await shopify(get, origin, o, notes)) ?? (await woocommerce(get, origin, o, notes)) ?? (await sitemap(get, origin, o, notes));
  return found ?? { site: origin, source: "none", currency: null, products: [], truncated: false, notes: [...notes, "No catalogue found: read the shop's category pages with fetch_page instead"] };
}
