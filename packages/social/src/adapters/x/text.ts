/**
 * X's weighted character counting, following twitter-text config v3
 * (https://github.com/twitter/twitter-text/blob/master/config/v3.json) and
 * https://docs.x.com/fundamentals/counting-characters:
 *
 * - the limit is 280 weighted characters, after Unicode NFC normalisation;
 * - code points in the ranges below weigh 1 (Latin, Greek, Cyrillic, Hebrew, Arabic, Indic and
 *   general punctuation, among others); everything else (CJK, most symbols) weighs 2;
 * - an emoji weighs 2 whatever its length (ZWJ sequences, skin tones, flags and keycaps included);
 * - every URL weighs 23, however long it is.
 *
 * URL detection is a reasonable approximation of twitter-text's extractor: `http(s)://…`,
 * `www.…`, and bare domains on common TLDs (e.g. `desktopmachineshop.com/shop`).
 */

export const MAX_WEIGHTED_LENGTH = 280;
export const URL_WEIGHT = 23;

const LIGHT_RANGES: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const COMMON_TLDS = [
  "com", "net", "org", "uk", "co", "io", "dev", "ai", "app", "shop", "store", "me", "tv", "ly", "gl",
  "be", "eu", "de", "fr", "nl", "us", "ca", "au", "info", "biz", "xyz", "blog", "tech", "online", "site",
];

const URL_PATTERN = new RegExp(
  [
    String.raw`https?:\/\/[^\s<>"]+`,
    String.raw`www\.[^\s<>"]+`,
    String.raw`(?<![@\w.\-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${COMMON_TLDS.join("|")})(?![a-z0-9-])(?:[/?#][^\s<>"]*)?`,
  ].join("|"),
  "giu",
);

/** Trailing punctuation that ends a sentence rather than the URL. */
const TRAILING_PUNCTUATION = /[.,:;!?'")\]}]+$/u;

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** URLs as X would detect them, with trailing sentence punctuation removed. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFC").matchAll(URL_PATTERN)) {
    let url = m[0];
    // Keep a closing bracket that is balanced inside the URL, e.g. wiki links.
    while (TRAILING_PUNCTUATION.test(url)) {
      const last = url.at(-1)!;
      if (last === ")" && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    if (url) out.push(url);
  }
  return out;
}

function codePointWeight(cp: number): number {
  for (const [start, end] of LIGHT_RANGES) if (cp >= start && cp <= end) return 1;
  return 2;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function weightOfPlainText(text: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI.test(segment)) {
      total += 2;
      continue;
    }
    for (const ch of segment) total += codePointWeight(ch.codePointAt(0)!);
  }
  return total;
}

/** The weighted length X uses for the 280 limit. */
export function weightedLength(text: string): number {
  const normalised = text.normalize("NFC");
  let total = 0;
  let rest = normalised;
  for (const url of extractUrls(normalised)) {
    const at = rest.indexOf(url);
    if (at < 0) continue;
    total += weightOfPlainText(rest.slice(0, at)) + URL_WEIGHT;
    rest = rest.slice(at + url.length);
  }
  return total + weightOfPlainText(rest);
}
