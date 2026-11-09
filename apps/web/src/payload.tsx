import type { CSSProperties, ReactNode } from "react";

/**
 * Proposal payloads and results as something a person reads: labelled fields, paragraphs, bullet
 * lists, links, images and colour swatches, never raw JSON. A video.produce spec reads as a
 * storyboard (what each scene shows and says). The editor (Edit on an approval) still works on
 * the stored values.
 */

/** A value turned into something to show. */
export type Readable =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "image"; url: string }
  | { kind: "colour"; hex: string }
  | { kind: "list"; items: Readable[] }
  | { kind: "fields"; fields: Field[] };
export interface Field {
  key: string;
  label: string;
  value: Readable;
}

/** Keys the server owns or that mean nothing to a reader. */
const HIDDEN = new Set(["policyDowngrade", "version"]);
/** Addressing first, the long text last, the rest in between (stored JSON comes back in no useful order). */
const FIRST = ["to", "cc", "bcc", "subject", "title", "name", "heading", "subheading"];
const LAST = ["narration", "body", "text", "message", "html", "content"];
const rank = (key: string) => (FIRST.includes(key) ? FIRST.indexOf(key) : LAST.includes(key) ? 100 + LAST.indexOf(key) : 50);

const WORDS: Record<string, string> = { cta: "Call to action", url: "Link", id: "Id", fps: "Frames per second", bcc: "Bcc", cc: "Cc" };
/** "accountId" → "Account id", "scheduled_at" → "Scheduled at". */
export function labelOf(key: string): string {
  if (WORDS[key]) return WORDS[key]!;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?$/i;

/** Turns any JSON value into a Readable, or null when there is nothing to show. */
export function readable(value: unknown): Readable | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (HEX.test(s)) return { kind: "colour", hex: s };
    if (URL_RE.test(s)) return IMAGE_RE.test(s) ? { kind: "image", url: s } : { kind: "link", url: s };
    return { kind: "text", text: value };
  }
  if (typeof value === "number") return { kind: "text", text: Number.isFinite(value) ? value.toLocaleString("en-GB") : String(value) };
  if (typeof value === "boolean") return { kind: "text", text: value ? "Yes" : "No" };
  if (Array.isArray(value)) {
    const items = value.map(readable).filter((x): x is Readable => x != null);
    return items.length ? { kind: "list", items } : null;
  }
  if (typeof value === "object") {
    const fields = fieldsOf(value as Record<string, unknown>);
    return fields.length ? { kind: "fields", fields } : null;
  }
  return { kind: "text", text: String(value) };
}

/** An object's fields in reading order, empty and hidden ones left out. */
export function fieldsOf(obj: Record<string, unknown>, skip: readonly string[] = []): Field[] {
  return Object.keys(obj)
    .filter((k) => !HIDDEN.has(k) && !skip.includes(k))
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((key) => {
      const value = readable(obj[key]);
      return value ? [{ key, label: labelOf(key), value }] : [];
    });
}

/** Shows a Readable. */
export function ReadableView({ value }: { value: Readable }): ReactNode {
  switch (value.kind) {
    case "text":
      return <span className="readable-text">{value.text}</span>;
    case "link":
      return (
        <a href={value.url} target="_blank" rel="noreferrer" className="readable-link">
          {value.url}
        </a>
      );
    case "image":
      return (
        <a href={value.url} target="_blank" rel="noreferrer">
          <img className="readable-image" src={value.url} alt="" loading="lazy" />
        </a>
      );
    case "colour":
      return (
        <span className="readable-colour">
          <span className="swatch" style={{ background: value.hex }} aria-hidden="true" />
          {value.hex}
        </span>
      );
    case "list":
      return (
        <ul className="readable-list">
          {value.items.map((item, i) => (
            <li key={i}>
              <ReadableView value={item} />
            </li>
          ))}
        </ul>
      );
    case "fields":
      return <FieldList fields={value.fields} />;
  }
}

export function FieldList({ fields }: { fields: Field[] }) {
  return (
    <dl className="readable-fields">
      {fields.map((f) => (
        <div key={f.key} className={`readable-field ${f.value.kind === "fields" || f.value.kind === "list" ? "block" : ""}`}>
          <dt>{f.label}</dt>
          <dd>
            <ReadableView value={f.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Payload keys a quote summary replaces: the preview itself, and the raw ids and lines it spells out. */
const QUOTE_KEYS = ["quotePreview", "partner_id", "lines", "id"];

/** A payload (or result) as readable fields; a video spec as a storyboard; a quote as its summary. `skip` leaves out fields shown elsewhere. */
export function PayloadView({ payload, skip = [] }: { payload: Record<string, unknown>; skip?: readonly string[] }) {
  const spec = videoSpecOf(payload.spec);
  const quote = quotePreviewOf(payload.quotePreview);
  const record = recordPreviewOf(payload.recordPreview);
  const fields = fieldsOf(payload, [...skip, ...(spec ? ["spec"] : []), ...(quote ? QUOTE_KEYS : []), ...(record ? RECORD_KEYS : [])]);
  if (!spec && !quote && !record && !fields.length) return null;
  return (
    <div className="readable">
      {quote && <QuoteSummary quote={quote} />}
      {record && (
        <section>
          <div className="small muted">{record.title}</div>
          <ul className="readable-list">
            {record.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      {spec && <Storyboard spec={spec} />}
      {fields.length > 0 && <FieldList fields={fields} />}
    </div>
  );
}

/** True when a payload has anything PayloadView would show. */
export function hasReadable(payload: Record<string, unknown>, skip: readonly string[] = []): boolean {
  return videoSpecOf(payload.spec) != null || quotePreviewOf(payload.quotePreview) != null || fieldsOf(payload, skip).length > 0;
}

// ---- Generic Odoo record changes (odoo.record.*) ----

/** Payload keys the record summary replaces: the preview itself and the raw ids and values it spells out. */
const RECORD_KEYS = ["recordPreview", "ids", "values"];

/**
 * The server's preview of a generic Odoo change (packages/odoo record-executors.ts) as a title
 * and plain lines: which records, each field's value now → after, a new record's values, and
 * possible duplicates. Null for anything else (e.g. "Could not check Odoo").
 */
export function recordPreviewOf(value: unknown): { title: string; lines: string[] } | null {
  if (!isObj(value) || typeof value.model !== "string") return null;
  const label = typeof value.label === "string" && value.label !== value.model ? `${value.label} (${value.model})` : value.model;
  const records = Array.isArray(value.records) ? value.records.filter(isObj) : [];
  const count = typeof value.count === "number" ? value.count : records.length;
  const lines: string[] = [];
  if (records.length) {
    const names = records.map((r) => `${String(r.name)}${typeof r.state === "string" ? ` (${r.state})` : ""}`).join(", ");
    lines.push(count > records.length ? `${names} and ${count - records.length} more` : names);
  }
  for (const c of Array.isArray(value.changes) ? value.changes.filter(isObj) : []) {
    const from = typeof c.from === "string" ? c.from : Array.isArray(c.from) ? c.from.filter(isObj).map((f) => `${String(f.value)} (${String(f.records)})`).join(", ") : "?";
    const scope = count > 1 && typeof c.changes === "number" ? ` (changes ${c.changes} of ${count})` : "";
    lines.push(c.changes === 0 ? `${String(c.label)}: already ${String(c.to)}` : `${String(c.label)}: ${from} → ${String(c.to)}${scope}`);
  }
  if (isObj(value.values)) for (const [k, v] of Object.entries(value.values)) lines.push(`${k}: ${String(v)}`);
  if (Array.isArray(value.duplicates)) {
    for (const d of value.duplicates.filter(isObj)) lines.push(`Possible duplicate: ${String(d.name)} #${String(d.id)}${d.archived ? " (archived)" : ""}, same ${String(d.same)}`);
  } else if (typeof value.duplicates === "string") lines.push(`Duplicates: ${value.duplicates}`);
  const what = typeof value.method === "string" ? `Press ${value.method} on` : isObj(value.values) ? "New" : count > 1 ? `${count} records of` : "";
  return { title: `${what} ${label}`.trim(), lines };
}

// ---- Quotes (odoo.quote.create / odoo.quote.send) ----

export interface QuoteLineView {
  product_id: number | null;
  part_number: string | null;
  name: string;
  qty: number;
  unit_price: number;
  discount: number;
  subtotal: number;
  cost?: number | null;
  margin?: number | null;
  margin_pct?: number | null;
  stock?: QuoteStockView;
}
export interface QuoteStockView {
  status: "ok" | "incoming" | "order" | "untracked";
  on_hand: number | null;
  forecast: number | null;
  short?: number;
}
export interface QuoteView {
  quote?: string;
  customer: Obj & { name: string };
  lines: QuoteLineView[];
  currency: string | null;
  untaxed: number;
  tax: number | null;
  total: number | null;
  margin?: number | null;
  margin_pct?: number | null;
  needs_ordering?: number;
  estimated: boolean;
  notes: string[];
}

/** The server's quote preview (packages/odoo quote-preview.ts), or null. */
export function quotePreviewOf(value: unknown): QuoteView | null {
  if (!isObj(value) || !isObj(value.customer) || typeof value.customer.name !== "string" || !Array.isArray(value.lines)) return null;
  if (typeof value.untaxed !== "number") return null;
  return value as unknown as QuoteView;
}

/** An amount in the quote's currency: "£1,234.50". */
export function moneyText(n: number, currency: string | null): string {
  try {
    if (currency && /^[A-Z]{3}$/.test(currency)) return n.toLocaleString("en-GB", { style: "currency", currency });
  } catch {
    // Unknown currency code: plain number.
  }
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The customer's facts worth reading before a quote goes out, as label/value pairs. */
export function customerFacts(c: QuoteView["customer"]): [string, string][] {
  const facts: [string, unknown][] = [
    ["Customer", c.company ? `${c.name} (${String(c.company)})` : c.name],
    ["Email", c.email],
    ["Phone", c.phone],
    ["Address", c.address],
    ["VAT", c.vat],
    ["Reference", c.ref],
    ["Pricelist", c.pricelist],
    ["Previous orders", typeof c.previousOrders === "number" ? (c.previousOrders === 0 ? "None (new customer)" : String(c.previousOrders)) : null],
  ];
  return facts.filter((f): f is [string, string] => typeof f[1] === "string" && f[1].trim() !== "");
}

const qtyText = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 3 });

/** A line's stock in words, and whether that's good (ok), worth watching (warn) or bad (bad); null when not stocked. */
export function stockText(s: QuoteStockView | undefined): { tone: "ok" | "warn" | "bad"; text: string; detail: string } | null {
  if (!s || s.status === "untracked") return null;
  const onHand = qtyText(s.on_hand ?? 0);
  const detail = `${onHand} on hand, ${qtyText(s.forecast ?? 0)} forecast after incoming and other orders`;
  if (s.status === "ok") return { tone: "ok", text: `In stock (${onHand})`, detail };
  if (s.status === "incoming") return { tone: "warn", text: `Incoming (${onHand} now)`, detail: `Short now; incoming stock covers it. ${detail}` };
  return { tone: "bad", text: `Order ${qtyText(s.short ?? 0)} more`, detail: `Needs ordering. ${detail}` };
}

/** "44.7%". */
const pctText = (n: number) => `${n.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;

export function QuoteSummary({ quote }: { quote: QuoteView }) {
  const money = (n: number) => moneyText(n, quote.currency);
  const est = quote.estimated ? " (estimate)" : "";
  const ordering = quote.needs_ordering ?? 0;
  return (
    <div className="quote-summary">
      <section>
        <div className="small muted">{quote.quote ? `Quote ${quote.quote}` : "Customer summary"}</div>
        <dl className="readable-fields">
          {customerFacts(quote.customer).map(([k, v]) => (
            <div key={k} className="readable-field">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {ordering > 0 && (
        <p className="quote-stock-alert" role="status">
          {ordering === 1 ? "1 line needs" : `${ordering} lines need`} ordering before this quote can be filled.
        </p>
      )}
      <div className="quote-lines-wrap">
        <table className="quote-lines">
          <thead>
            <tr>
              <th>Part no. / product</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">
                Subtotal
                <span className="quote-margin small">margin</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <span className="quote-part mono small">
                    {l.part_number ?? "No part no."}
                    {l.product_id != null && <span className="muted"> · id {l.product_id}</span>}
                  </span>
                  <span className="quote-name">{l.name}</span>
                  {(() => {
                    const st = stockText(l.stock);
                    return (
                      st && (
                        <span className={`quote-stock small tone-${st.tone}`} title={st.detail}>
                          {st.text}
                        </span>
                      )
                    );
                  })()}
                </td>
                <td className="num">{qtyText(l.qty)}</td>
                <td className="num">
                  {money(l.unit_price)}
                  {l.discount ? <span className="quote-disc small muted">−{qtyText(l.discount)}%</span> : null}
                </td>
                <td className="num">
                  {money(l.subtotal)}
                  {l.margin != null && (
                    <span className={`quote-margin small ${l.margin < 0 ? "tone-bad" : "muted"}`}>
                      {money(l.margin)}
                      {l.margin_pct != null && ` · ${pctText(l.margin_pct)}`}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>Subtotal (before tax)</th>
              <td className="num">{money(quote.untaxed)}</td>
            </tr>
            <tr>
              <th colSpan={3}>Tax{est}</th>
              <td className="num">{quote.tax != null ? money(quote.tax) : "Set by Odoo"}</td>
            </tr>
            <tr className="quote-total">
              <th colSpan={3}>Quote total{est}</th>
              <td className="num">{quote.total != null ? money(quote.total) : `${money(quote.untaxed)} + tax`}</td>
            </tr>
            {quote.margin != null && (
              <tr className="quote-margin-row">
                <th colSpan={3}>Margin (before tax)</th>
                <td className={`num ${quote.margin < 0 ? "tone-bad" : ""}`}>
                  {money(quote.margin)}
                  {quote.margin_pct != null && <span className="quote-margin small muted">{pctText(quote.margin_pct)}</span>}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
      {quote.notes.length > 0 && (
        <ul className="readable-list small muted">
          {quote.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Video specs ----

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** A video spec (has scenes), or null. */
export function videoSpecOf(value: unknown): Obj | null {
  return isObj(value) && Array.isArray(value.scenes) && value.scenes.length > 0 ? value : null;
}

const SCENE_KINDS: Record<string, string> = { title: "Title card", slide: "Slide", capture: "Screen recording", image: "Image", outro: "Closing card", logo: "Logo card" };
const TYPES: Record<string, string> = { short: "Short", demo: "Demo", walkthrough: "Walkthrough", announcement: "Announcement", explainer: "Explainer" };

/** One browser step of a screen recording, in words. */
export function stepText(step: Obj): string {
  const sel = str(step.selector) ?? "the page";
  switch (step.action) {
    case "goto":
      return `Open ${str(step.url) ?? "a page"}`;
    case "click":
      return `Click ${sel}`;
    case "hover":
      return `Point at ${sel}`;
    case "type":
      return `Type “${str(step.text) ?? ""}” into ${sel}`;
    case "press":
      return `Press ${str(step.key) ?? "a key"}`;
    case "select":
      return `Choose “${str(step.value) ?? ""}” in ${sel}`;
    case "scroll":
      return step.selector ? `Scroll to ${sel}` : "Scroll down";
    case "wait":
      return `Pause ${typeof step.ms === "number" ? `${(step.ms / 1000).toLocaleString("en-GB")} s` : ""}`.trim();
    case "highlight":
      return `Highlight ${sel}`;
    case "zoom":
      return `Zoom in on ${sel}`;
    default:
      return String(step.action ?? "Step");
  }
}

/** "kokoro:bm_george" → "George (server voice, most natural)". */
export function voiceText(provider: string, voiceId?: string): string {
  if (provider === "silent") return "None (captions only)";
  if (provider === "local") {
    if (!voiceId) return "Server default voice";
    const [family, name = family] = voiceId.split(":");
    const first = name!.replace(/^b[fm]_/, "").split("_")[0]!;
    const label = first.charAt(0).toUpperCase() + first.slice(1);
    return `${label} (server voice${family === "kokoro" ? ", most natural" : family === "piper" ? ", fast" : ""})`;
  }
  return voiceId ? `${provider}: ${voiceId}` : provider;
}

/** The headline facts of a spec: title, shape, length type, voice. */
export function specFacts(spec: Obj): [string, string][] {
  const voice = isObj(spec.voice) ? str(spec.voice.provider) : undefined;
  const facts: [string, string | undefined][] = [
    ["Title", str(spec.title)],
    ["Kind", str(spec.type) ? (TYPES[spec.type as string] ?? (spec.type as string)) : undefined],
    ["Format", str(spec.format) ? `${spec.format}${spec.format === "9:16" ? " (portrait)" : spec.format === "16:9" ? " (landscape)" : spec.format === "1:1" ? " (square)" : ""}` : undefined],
    ["Voiceover", voice ? voiceText(voice, isObj(spec.voice) ? str(spec.voice.voiceId) : undefined) : undefined],
    ["Captions", isObj(spec.captions) && spec.captions.enabled === false ? "Off" : undefined],
    ["Music", isObj(spec.music) ? (str(spec.music.credit) ?? "Yes") : undefined],
  ];
  return facts.filter((f): f is [string, string] => f[1] != null);
}

function Storyboard({ spec }: { spec: Obj }) {
  const brand = isObj(spec.brand) ? spec.brand : null;
  const colours = brand && isObj(brand.colours) ? Object.entries(brand.colours).filter(([, v]) => typeof v === "string" && HEX.test(v)) : [];
  const scenes = (spec.scenes as unknown[]).filter(isObj);
  const sources = Array.isArray(spec.sources) ? spec.sources.filter(isObj) : [];
  return (
    <div className="storyboard">
      <dl className="readable-fields">
        {specFacts(spec).map(([k, v]) => (
          <div key={k} className="readable-field">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {brand && (
          <div className="readable-field">
            <dt>Brand</dt>
            <dd className="row wrap">
              {str(brand.name)}
              {colours.map(([k, v]) => (
                <span key={k} className="swatch" title={`${labelOf(k)} ${v}`} style={{ background: v as string }} />
              ))}
            </dd>
          </div>
        )}
      </dl>
      <ol className="scenes">
        {scenes.map((s, i) => {
          const bullets = Array.isArray(s.bullets) ? s.bullets.filter((b): b is string => typeof b === "string") : [];
          const steps = Array.isArray(s.steps) ? s.steps.filter(isObj) : [];
          return (
            <li key={str(s.id) ?? i} className="scene">
              <div className="scene-head small muted">
                Scene {i + 1} · {SCENE_KINDS[s.kind as string] ?? String(s.kind ?? "")}
              </div>
              <div className="scene-screen" style={brand && isObj(brand.colours) ? screenStyle(brand.colours) : undefined}>
                {str(s.heading) && <strong className="scene-heading">{s.heading as string}</strong>}
                {str(s.subheading) && <span>{s.subheading as string}</span>}
                {bullets.length > 0 && (
                  <ul>
                    {bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
                {s.kind === "image" && str(s.url) && <img className="readable-image" src={s.url as string} alt={str(s.alt) ?? ""} loading="lazy" />}
                {steps.length > 0 && (
                  <ol className="scene-steps small">
                    {steps.map((st, j) => (
                      <li key={j}>{stepText(st)}</li>
                    ))}
                  </ol>
                )}
                {str(s.cta) && <span className="scene-cta">{s.cta as string}</span>}
                {str(s.url) && s.kind !== "image" && <span className="small">{s.url as string}</span>}
              </div>
              {str(s.narration) && (
                <p className="scene-narration small">
                  <span className="muted">{isObj(spec.voice) && spec.voice.provider === "silent" ? "Caption: " : "Says: "}</span>
                  {s.narration as string}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {sources.length > 0 && (
        <div className="storyboard-sources">
          <div className="small muted">Sources</div>
          <ul className="readable-list small">
            {sources.map((src, i) => (
              <li key={i}>
                {[str(src.tool), str(src.ref)].filter(Boolean).join(": ")}
                {str(src.note) && <span className="muted"> ({src.note as string})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The scene preview in the brand's own colours. */
function screenStyle(colours: Obj) {
  const bg = str(colours.background);
  const fg = str(colours.text);
  const accent = str(colours.accent) ?? str(colours.primary);
  if (!bg || !HEX.test(bg)) return undefined;
  return { background: bg, color: fg && HEX.test(fg) ? fg : undefined, "--scene-accent": accent } as CSSProperties;
}
