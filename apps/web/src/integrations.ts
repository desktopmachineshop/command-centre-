/**
 * The Accounts page's data (GET /api/integrations) and the pure logic behind it: an entry's
 * status pill, form values ↔ the save patch, id suggestions and OAuth redirect addresses.
 * Kept free of React so it is unit-tested (test/integrations.test.ts).
 */

export type Section = "ai" | "business" | "google" | "social" | "apps" | "settings";
export type Group = "runner" | "triage" | "voice" | "odoo" | "email" | "social" | "calendar" | "storage";
export type FieldType = "text" | "secret" | "url" | "email" | "number" | "boolean" | "select" | "list" | "json";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  /** Filled in by the sign-in flow, not typed. */
  fromOAuth?: boolean;
}

export interface KindDef {
  kind: string;
  label: string;
  section: Section;
  description: string;
  multi: boolean;
  fields: FieldDef[];
  oauth?: string;
  /** "claude": Connect runs `claude setup-token` on the server (ClaudeDialog). */
  connect?: "claude";
  needsApp?: string;
  affects: Group[];
  helpUrl?: string;
  testable: boolean;
}

export interface EntryMeta {
  account?: string;
  expiresAt?: string;
  lastTest?: { at: string; ok: boolean; message: string };
  [key: string]: unknown;
}

export interface EntryView {
  kind: string;
  id: string;
  source: "app" | "railway";
  data: Record<string, unknown>;
  /** Masked ("••••1234") or null when unset. */
  secrets: Record<string, string | null>;
  meta: EntryMeta;
  error?: string;
  updatedAt?: string;
}

export interface IntegrationsView {
  kinds: KindDef[];
  entries: EntryView[];
  railwayOnly: { name: string; label: string; set: boolean }[];
  groups: Record<Group, string | null>;
  publicBaseUrl: string | null;
}

export interface SavePatch {
  data?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
}

export interface SaveResult {
  ok: boolean;
  reloaded: Group[];
  failed: Partial<Record<Group, string>>;
}

export const DEFAULT_ID = "default";

export const SECTION_ORDER: { section: Section; title: string; sub?: string }[] = [
  { section: "ai", title: "AI" },
  { section: "business", title: "Business" },
  { section: "google", title: "Google" },
  { section: "social", title: "Social" },
  { section: "settings", title: "Settings" },
  { section: "apps", title: "Developer apps" },
];

export const GROUP_LABELS: Record<Group, string> = {
  runner: "Agents",
  triage: "Triage",
  voice: "Voice",
  odoo: "Odoo",
  email: "Email",
  social: "Social",
  calendar: "Calendar",
  storage: "File storage",
};

// --- status ---
export type Tone = "ok" | "info" | "warn" | "bad" | "none";
export interface EntryStatus {
  tone: Tone;
  label: string;
  /** Longer explanation (an error message), if any. */
  detail?: string;
}

const DAY = 86_400_000;
/** Warn this many days before a token stops working. */
export const EXPIRY_WARN_DAYS = 14;

/** Whole days until `iso` (rounded up, so "in 1 day" until it has expired), or null. */
export function daysUntil(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now) / DAY);
}

/** The status pill for an entry (undefined = nothing saved anywhere). */
export function entryStatus(entry: EntryView | undefined, def?: Pick<KindDef, "oauth" | "fields">, now: number = Date.now()): EntryStatus {
  if (!entry) return { tone: "none", label: "Not set" };
  if (entry.error) return { tone: "bad", label: "Error", detail: entry.error };
  const days = daysUntil(entry.meta?.expiresAt, now);
  if (days !== null && days <= 0) return { tone: "bad", label: "Expired", detail: "Sign in again to keep it working." };
  if (days !== null && days <= EXPIRY_WARN_DAYS) return { tone: "warn", label: `Expires in ${days} day${days === 1 ? "" : "s"}` };
  if (def?.oauth && !hasOAuthSecret(entry, def)) return { tone: "warn", label: "Not connected" };
  if (entry.source === "railway") return { tone: "info", label: "From Railway" };
  return { tone: "ok", label: "Connected" };
}

/** An OAuth kind counts as signed in once any of its sign-in secrets is stored. */
function hasOAuthSecret(entry: EntryView, def: Pick<KindDef, "fields">): boolean {
  const oauthSecrets = def.fields.filter((f) => f.type === "secret" && f.fromOAuth);
  if (!oauthSecrets.length) return true;
  return oauthSecrets.some((f) => !!entry.secrets?.[f.key]);
}

// --- forms ---
/** Form state: text for inputs, booleans for toggles; secrets are typed values ("" = keep). */
export type FormValues = Record<string, string | boolean>;

/** Fields a person types (sign-in fields are filled by the provider). */
export function editableFields(def: Pick<KindDef, "fields">): FieldDef[] {
  return def.fields.filter((f) => !f.fromOAuth);
}

/** Initial form values from an entry (or the field defaults for a new one). Secrets start empty. */
export function initialValues(def: Pick<KindDef, "fields">, entry?: EntryView): FormValues {
  const out: FormValues = {};
  for (const f of editableFields(def)) {
    const v = entry ? entry.data[f.key] : f.default;
    if (f.type === "secret") out[f.key] = "";
    else if (f.type === "boolean") out[f.key] = v === undefined ? f.default === true : v === true || v === "true";
    else if (f.type === "list") out[f.key] = Array.isArray(v) ? v.map(String).join("\n") : typeof v === "string" ? v : "";
    else if (f.type === "json") out[f.key] = v === undefined || v === null ? "" : typeof v === "string" ? prettyJson(v) : JSON.stringify(v, null, 2);
    else out[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** Client-side checks before saving: required fields, numbers, JSON, URLs. Field key → message. */
export function validate(def: Pick<KindDef, "fields">, values: FormValues, entry?: EntryView, cleared: ReadonlySet<string> = new Set()): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of editableFields(def)) {
    const v = values[f.key];
    if (f.type === "boolean") continue;
    const s = typeof v === "string" ? v.trim() : "";
    if (f.type === "secret") {
      const hasCurrent = !!entry?.secrets?.[f.key] && !cleared.has(f.key);
      if (f.required && !s && !hasCurrent) errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (!s) {
      if (f.required) errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (f.type === "number" && !Number.isFinite(Number(s))) errors[f.key] = `${f.label} must be a number`;
    if (f.type === "url" && !/^https?:\/\/\S+$/.test(s)) errors[f.key] = `${f.label} must start with https://`;
    if (f.type === "email" && !/^\S+@\S+\.\S+$/.test(s)) errors[f.key] = `${f.label} must be an email address`;
    if (f.type === "json") {
      try {
        JSON.parse(s);
      } catch {
        errors[f.key] = `${f.label} isn't valid JSON`;
      }
    }
  }
  return errors;
}

/**
 * The PUT body for a form. Empty non-secret fields are removed from an existing entry (omitted on
 * a new one); empty secrets keep what's stored; `cleared` secrets are removed.
 */
export function toPatch(def: Pick<KindDef, "fields">, values: FormValues, options: { isNew: boolean; cleared?: ReadonlySet<string> } = { isNew: false }): SavePatch {
  const data: Record<string, unknown> = {};
  const secrets: Record<string, string | null> = {};
  for (const f of editableFields(def)) {
    const v = values[f.key];
    if (f.type === "secret") {
      if (options.cleared?.has(f.key)) secrets[f.key] = null;
      else if (typeof v === "string" && v.trim()) secrets[f.key] = v.trim();
      continue;
    }
    if (f.type === "boolean") {
      data[f.key] = v === true;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) {
      if (!options.isNew) data[f.key] = null;
      continue;
    }
    if (f.type === "number") data[f.key] = Number(s);
    else if (f.type === "list")
      data[f.key] = s
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    else if (f.type === "json") data[f.key] = JSON.stringify(JSON.parse(s));
    else data[f.key] = s;
  }
  const patch: SavePatch = { data };
  if (Object.keys(secrets).length) patch.secrets = secrets;
  return patch;
}

/** The Gmail preset for the email form. */
export const GMAIL_PRESET: FormValues = {
  imapHost: "imap.gmail.com",
  imapPort: "993",
  imapSecure: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: "465",
  smtpSecure: true,
};

// --- ids ---
const ID = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
export const isValidId = (id: string) => ID.test(id);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 63);
}

/** A free id like "dms-instagram", "dms-instagram-2"… for a new account. */
export function suggestId(vertical: string | undefined, kind: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify([vertical, kind].filter(Boolean).join("-")) || kind;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** What an entry is called on its card. */
export function entryTitle(def: Pick<KindDef, "label" | "multi">, entry: EntryView): string {
  if (!def.multi) return def.label;
  const d = entry.data;
  const pick = [d.displayName, d.handle, d.address, d.email, entry.meta?.account].find((v) => typeof v === "string" && v.trim());
  return (pick as string | undefined) ?? entry.id;
}

// --- OAuth ---
/** Developer app → the sign-in providers whose callback must be registered in its console. */
export const APP_PROVIDERS: Record<string, string[]> = {
  "google-app": ["google", "youtube"],
  "instagram-app": ["instagram"],
  "threads-app": ["threads"],
  "x-app": ["x"],
  "reddit-app": ["reddit"],
};

export function redirectUri(publicBaseUrl: string | null, provider: string): string | null {
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl.replace(/\/+$/, "")}/oauth/${provider}/callback`;
}

/** The query the server sends the browser back with after a sign-in. */
export function oauthReturn(query: URLSearchParams): { kind: "connected"; entryKind: string; id: string | null } | { kind: "error"; message: string } | null {
  const err = query.get("oauthError");
  if (err) return { kind: "error", message: err };
  const connected = query.get("connected");
  if (connected) return { kind: "connected", entryKind: connected, id: query.get("id") };
  return null;
}

/** The calendars chosen on a Google entry (its `calendars` JSON field). */
export function chosenCalendars(entry: EntryView | undefined): { id: string; name?: string; write?: boolean }[] {
  const raw = entry?.data.calendars;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(v)) return v.filter((c) => c && typeof c.id === "string");
  } catch {
    // fall through
  }
  return [{ id: "primary" }];
}

/** "Saved." plus which parts restarted or failed, for the page notice. */
export function describeResult(result: Pick<SaveResult, "reloaded" | "failed">, verb = "Saved"): { ok: boolean; text: string } {
  const failed = Object.entries(result.failed ?? {}).filter(([, m]) => m);
  if (failed.length) {
    return { ok: false, text: `${verb}, but ${failed.map(([g, m]) => `${GROUP_LABELS[g as Group] ?? g} couldn't restart: ${m}`).join("; ")}` };
  }
  const restarted = (result.reloaded ?? []).map((g) => GROUP_LABELS[g] ?? g);
  return { ok: true, text: restarted.length ? `${verb}. ${restarted.join(", ")} restarted with the new settings.` : `${verb}.` };
}
