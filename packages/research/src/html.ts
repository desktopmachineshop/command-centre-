/**
 * A small, dependency-free reader for web pages: title, description, headings, the readable main
 * text, links, and product data from JSON-LD, OpenGraph and microdata. It is deliberately
 * forgiving rather than a full HTML parser: pages are outside content read for facts, and a
 * field it can't find is left out, never guessed.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  pound: "£",
  euro: "€",
  dollar: "$",
  yen: "¥",
  copy: "©",
  reg: "®",
  trade: "™",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  deg: "°",
  frac12: "½",
  middot: "·",
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** HTML to plain text: block tags become line breaks, everything else is dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol|\/table|\/blockquote|\/dd|\/dt)\b[^>]*>/gi, "\n")
      .replace(/<\/t[dh]\s*>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Attributes of one tag as a map (lower-cased names, entity-decoded values). */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export interface PageLink {
  url: string;
  text: string;
}

/** A product (or offer) a page describes about itself, from its structured data. */
export interface StructuredProduct {
  name?: string;
  sku?: string;
  brand?: string;
  /** The (lowest) price as a number, in `currency`. */
  price?: number;
  /** The highest price when the page gives a range. */
  priceMax?: number;
  currency?: string;
  /** "InStock", "OutOfStock", "PreOrder", ... (schema.org's names, without the URL). */
  availability?: string;
  url?: string;
  rating?: number;
  reviewCount?: number;
  /** Where on the page it was found. */
  from: "json-ld" | "opengraph" | "microdata";
}

export interface PageExtract {
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  siteName: string | null;
  headings: { level: number; text: string }[];
  /** The readable text of the page's main content. */
  text: string;
  links: { internal: PageLink[]; outbound: PageLink[] };
  products: StructuredProduct[];
  /** The page asks robots not to index or follow it (reported, not enforced). */
  robots: string | null;
}

const price = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  // "1,299.00", "1.299,00", "£12.50", "12,5"
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return undefined;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma > dot) s = s.length - comma - 1 === 3 && dot === -1 ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() ? clean(v).slice(0, 300) : undefined;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) return text((v as Record<string, unknown>).name ?? (v as Record<string, unknown>)["@id"]);
  return undefined;
};

const schemaName = (v: unknown): string | undefined => (typeof v === "string" && v ? v.replace(/^https?:\/\/schema\.org\//i, "").trim() : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const isType = (node: Record<string, unknown>, name: string) => list(node["@type"]).some((t) => typeof t === "string" && t.replace(/^https?:\/\/schema\.org\//i, "") === name);

/** Every JSON-LD object on the page, with @graph and arrays flattened (bad JSON is skipped). */
export function jsonLdNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== "object") return;
    const node = v as Record<string, unknown>;
    out.push(node);
    walk(node["@graph"], depth + 1);
    walk(node.mainEntity, depth + 1);
    walk(node.itemListElement, depth + 1);
    walk(node.item, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      walk(JSON.parse(m[1]!.trim()), 0);
    } catch {
      // Not valid JSON: leave it.
    }
  }
  return out;
}

function productFromJsonLd(node: Record<string, unknown>): StructuredProduct | null {
  if (!isType(node, "Product") && !isType(node, "ProductGroup")) return null;
  const offers = list(node.offers).flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const offer = o as Record<string, unknown>;
    // An AggregateOffer may hold its offers, or just lowPrice / highPrice.
    return isType(offer, "AggregateOffer") && list(offer.offers).length ? [offer, ...(list(offer.offers) as Record<string, unknown>[])] : [offer];
  });
  const prices: number[] = [];
  let currency: string | undefined;
  let availability: string | undefined;
  for (const o of offers) {
    const spec = list(o.priceSpecification)[0] as Record<string, unknown> | undefined;
    for (const p of [o.price, o.lowPrice, o.highPrice, spec?.price]) {
      const n = price(p);
      if (n !== undefined) prices.push(n);
    }
    currency ??= text(o.priceCurrency ?? spec?.priceCurrency);
    const a = schemaName(o.availability);
    // In stock anywhere wins over an out-of-stock variant.
    if (a && (!availability || a === "InStock")) availability = a;
  }
  const rating = node.aggregateRating as Record<string, unknown> | undefined;
  const p: StructuredProduct = { from: "json-ld" };
  const name = text(node.name);
  if (name) p.name = name;
  const sku = text(node.sku ?? node.mpn ?? node.gtin13 ?? node.gtin);
  if (sku) p.sku = sku;
  const brand = text(node.brand);
  if (brand) p.brand = brand;
  if (prices.length) {
    p.price = Math.min(...prices);
    if (Math.max(...prices) !== p.price) p.priceMax = Math.max(...prices);
  }
  if (currency) p.currency = currency.toUpperCase();
  if (availability) p.availability = availability;
  const url = typeof node.url === "string" ? node.url : undefined;
  if (url) p.url = url;
  const r = price(rating?.ratingValue);
  if (r !== undefined) p.rating = r;
  const count = price(rating?.reviewCount ?? rating?.ratingCount);
  if (count !== undefined) p.reviewCount = count;
  return p.name || p.price !== undefined ? p : null;
}

/** `<meta property|name=… content=…>` as a map; the first value of a key wins. */
function metas(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (key && a.content !== undefined && !out.has(key)) out.set(key, a.content.trim());
  }
  return out;
}

function productFromMeta(meta: Map<string, string>): StructuredProduct | null {
  const amount = price(meta.get("product:price:amount") ?? meta.get("og:price:amount") ?? meta.get("product:sale_price:amount"));
  if (amount === undefined) return null;
  const p: StructuredProduct = { from: "opengraph", price: amount };
  const name = meta.get("og:title");
  if (name) p.name = clean(name).slice(0, 300);
  const currency = meta.get("product:price:currency") ?? meta.get("og:price:currency");
  if (currency) p.currency = currency.toUpperCase();
  const availability = meta.get("product:availability") ?? meta.get("og:availability");
  if (availability) p.availability = /^(in ?stock|instock|available)/i.test(availability) ? "InStock" : /out|oos|unavailable/i.test(availability) ? "OutOfStock" : availability;
  const sku = meta.get("product:retailer_item_id");
  if (sku) p.sku = sku;
  return p;
}

/** The first microdata Product on the page: itemprop values inside an itemtype=…/Product scope. */
function productFromMicrodata(html: string): StructuredProduct | null {
  const start = html.search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i);
  if (start < 0) return null;
  const scope = html.slice(start, start + 60_000);
  const prop = (name: string): string | undefined => {
    const m = new RegExp(`<([a-z0-9]+)\\b[^>]*itemprop\\s*=\\s*["']${name}["'][^>]*>([^<]*)`, "i").exec(scope);
    if (!m) return undefined;
    const a = attrs(m[0]);
    return (a.content ?? a.href ?? a.value ?? clean(m[2] ?? "")).trim() || undefined;
  };
  const amount = price(prop("price"));
  const name = prop("name");
  if (amount === undefined && !name) return null;
  const p: StructuredProduct = { from: "microdata" };
  if (name) p.name = name.slice(0, 300);
  if (amount !== undefined) p.price = amount;
  const currency = prop("priceCurrency");
  if (currency) p.currency = currency.toUpperCase();
  const availability = schemaName(prop("availability"));
  if (availability) p.availability = availability;
  const sku = prop("sku");
  if (sku) p.sku = sku;
  return p;
}

/** The inner HTML of the first `<tag>` element, or null. */
function element(html: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, "i").exec(html);
  return m ? m[1]! : null;
}

/** Reads a page. `pageUrl` (the final URL after redirects) resolves relative links. */
export function extractPage(html: string, pageUrl: string, options: { maxText?: number; maxLinks?: number } = {}): PageExtract {
  const maxText = options.maxText ?? 12_000;
  const maxLinks = options.maxLinks ?? 60;
  const meta = metas(html);
  const products: StructuredProduct[] = [];
  for (const node of jsonLdNodes(html)) {
    const p = productFromJsonLd(node);
    if (p) products.push(p);
  }
  if (!products.length) {
    const p = productFromMeta(meta) ?? productFromMicrodata(html);
    if (p) products.push(p);
  }

  const bare = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const body = element(bare, "body") ?? bare;
  // The main content when the page marks it; otherwise the body without its chrome.
  const main = element(body, "main") ?? element(body, "article") ?? body;
  const content = main.replace(/<(nav|header|footer|aside|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ");
  let pageText = htmlToText(content);
  if (pageText.length > maxText) pageText = `${pageText.slice(0, maxText)}…`;

  // Headings of the content, not of the menus around it.
  const headings = [...content.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .map((m) => ({ level: Number(m[1]), text: clean(m[2]!).slice(0, 200) }))
    .filter((h) => h.text)
    .slice(0, 40);

  let base: URL | null = null;
  try {
    base = new URL(pageUrl);
  } catch {
    base = null;
  }
  const internal: PageLink[] = [];
  const outbound: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attrs(`<a ${m[1]}>`).href;
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href.trim())) continue;
    let url: URL;
    try {
      url = new URL(href.trim(), base ?? undefined);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const link = { url: key, text: clean(m[2]!).slice(0, 120) };
    const same = base && url.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    if (same) {
      if (internal.length < maxLinks) internal.push(link);
    } else if (outbound.length < maxLinks) outbound.push(link);
  }

  const title = element(bare, "title");
  const canonical = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html);
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i.exec(html)?.[1] ?? null;
  return {
    title: (title ? clean(title) : meta.get("og:title") ? clean(meta.get("og:title")!) : "") || null,
    description: (meta.get("description") ?? meta.get("og:description") ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || null,
    canonical: canonical ? (attrs(canonical[0]).href ?? null) : null,
    lang,
    siteName: meta.get("og:site_name") ?? null,
    headings,
    text: pageText,
    links: { internal, outbound },
    products,
    robots: meta.get("robots") ?? null,
  };
}
