import { createHash } from "node:crypto";
import { EmailAccount } from "@cc/email";
import { parseOdooEventsConfig } from "@cc/odoo";
import { type CalendarAccount, GoogleCalendarAccount } from "@cc/pa";
import type { Platform, SocialAccount } from "@cc/social";
import type { Config } from "../config";
import { DEFAULT_ID, type Field, type Group, KINDS, type KindDef } from "./catalog";
import type { Entry } from "./store";

/**
 * Turns Accounts-page entries into server config: the env config (Railway) with each saved
 * entry laid over it. A single-entry kind replaces its env values outright; a multi-entry kind
 * (mailboxes, social accounts, Google accounts) adds accounts, replacing an env account with
 * the same id. Pure: the reload code diffs the result per group (fingerprint).
 */
export interface EntryInput {
  kind: string;
  id: string;
  data: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface EntryError {
  kind: string;
  id: string;
  message: string;
}

const SOCIAL: readonly Platform[] = ["discord", "instagram", "threads", "x", "reddit", "youtube"];
/** The developer-app kind whose keys each platform's credentials include. */
const APP_CREDENTIALS: Partial<Record<Platform, { kind: string; map: Record<string, string> }>> = {
  x: { kind: "x-app", map: { apiKey: "apiKey", apiSecret: "apiSecret" } },
  reddit: { kind: "reddit-app", map: { clientId: "clientId", clientSecret: "clientSecret", userAgent: "userAgent" } },
  youtube: { kind: "google-app", map: { clientId: "clientId", clientSecret: "clientSecret" } },
};

/** Field values of an entry: non-secret data, then secrets. */
function values(e: EntryInput): Record<string, unknown> {
  return { ...e.data, ...e.secrets };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function json<T>(v: unknown, fallback: T): T {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string") return v as T;
  return JSON.parse(v) as T;
}

/** Field-level checks against the catalogue; returns messages naming fields, never values. */
export function validateFields(def: KindDef, data: Record<string, unknown>, secrets: Record<string, string>): string[] {
  const errors: string[] = [];
  const all = { ...data, ...secrets };
  for (const f of def.fields) {
    const v = all[f.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (f.required && !f.fromOAuth) errors.push(`${f.label} is required`);
      continue;
    }
    errors.push(...checkField(f, v));
  }
  return errors;
}

function checkField(f: Field, v: unknown): string[] {
  switch (f.type) {
    case "number":
      return Number.isFinite(Number(v)) ? [] : [`${f.label} must be a number`];
    case "boolean":
      return typeof v === "boolean" ? [] : [`${f.label} must be on or off`];
    case "select":
      return f.options && !f.options.includes(String(v)) ? [`${f.label} must be one of ${f.options.join(", ")}`] : [];
    case "url":
      return /^https?:\/\/\S+$/.test(String(v)) ? [] : [`${f.label} must be an http(s) URL`];
    case "email":
      return /^\S+@\S+\.\S+$/.test(String(v)) ? [] : [`${f.label} must be an email address`];
    case "list":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? [] : [`${f.label} must be a list`];
    case "json":
      try {
        json(v, null);
        return [];
      } catch {
        return [`${f.label} is not valid JSON`];
      }
    default:
      return typeof v === "string" ? [] : [`${f.label} must be text`];
  }
}

function single(entries: EntryInput[], kind: string): EntryInput | undefined {
  return entries.find((e) => e.kind === kind && e.id === DEFAULT_ID);
}

/** Merges accounts by id: later lists replace earlier ones with the same id. */
function mergeById<T extends { id: string }>(base: T[], extra: T[]): T[] {
  const ids = new Set(extra.map((a) => a.id));
  return [...base.filter((a) => !ids.has(a.id)), ...extra];
}

export function emailAccountOf(e: EntryInput): EmailAccount {
  const v = values(e);
  const address = str(v.address);
  const user = str(v.user) ?? address;
  return EmailAccount.parse({
    id: e.id,
    vertical: v.vertical,
    address,
    displayName: str(v.displayName),
    imap: { host: v.imapHost, port: Number(v.imapPort ?? 993), secure: bool(v.imapSecure, true), user, pass: v.password },
    smtp: { host: v.smtpHost, port: Number(v.smtpPort ?? 465), secure: bool(v.smtpSecure, true), user, pass: v.password },
    mailbox: str(v.mailbox) ?? "INBOX",
    ignoreFrom: Array.isArray(v.ignoreFrom) ? v.ignoreFrom : [],
  });
}

export function socialAccountOf(e: EntryInput, entries: EntryInput[]): SocialAccount {
  const platform = e.kind as Platform;
  const def = KINDS.get(e.kind)!;
  const credentials: Record<string, string> = {};
  const app = APP_CREDENTIALS[platform];
  if (app) {
    const appEntry = single(entries, app.kind);
    if (appEntry) for (const [from, to] of Object.entries(app.map)) {
      const value = str(values(appEntry)[from]);
      if (value) credentials[to] = value;
    }
  }
  // Credential fields: every secret, plus fromOAuth ids (igUserId, channelId...).
  for (const f of def.fields) if (f.type === "secret" || f.fromOAuth) {
    const value = str(values(e)[f.key]);
    if (value) credentials[f.key] = value;
  }
  // Anything else stored as a secret (e.g. a Reddit password moved in from Railway).
  for (const [k, value] of Object.entries(e.secrets)) if (value && !(k in credentials)) credentials[k] = value;
  return {
    id: e.id,
    platform,
    vertical: String(e.data.vertical ?? ""),
    handle: str(e.data.handle),
    displayName: str(e.data.displayName),
    inbound: bool(e.data.inbound, true),
    credentials,
    options: json<Record<string, unknown>>(e.data.options, {}),
  };
}

function googleApp(base: Config, entries: EntryInput[]): { clientId?: string; clientSecret?: string } {
  const app = single(entries, "google-app");
  if (app) return { clientId: str(app.data.clientId), clientSecret: str(app.secrets.clientSecret) };
  // Calendar accounts from Railway carry the shared client; so does Drive.
  const fromEnv = base.storage.google ?? base.pa.calendarAccounts[0]?.credentials;
  return { clientId: fromEnv?.clientId, clientSecret: fromEnv?.clientSecret };
}

export function calendarAccountOf(e: EntryInput, base: Config, entries: EntryInput[]): CalendarAccount {
  const { clientId, clientSecret } = googleApp(base, entries);
  const refreshToken = str(e.secrets.refreshToken);
  if (!clientId || !clientSecret) throw new Error("needs the Google OAuth client (Developer apps → Google)");
  if (!refreshToken) throw new Error("not connected yet: press Connect");
  const parsed = GoogleCalendarAccount.parse({
    id: e.id,
    provider: "google",
    vertical: e.data.vertical ?? "personal",
    calendars: json(e.data.calendars, [{ id: "primary" }]),
  });
  return { ...parsed, credentials: { clientId, clientSecret, refreshToken } };
}

/** The env config with every entry applied. Entries that don't make a valid account are skipped and reported. */
export function applyEntries(base: Config, all: EntryInput[]): { config: Config; errors: EntryError[] } {
  const errors: EntryError[] = [];
  const entries = all.filter((e) => KINDS.has(e.kind));
  const attempt = <T>(e: EntryInput, build: () => T): T | undefined => {
    try {
      return build();
    } catch (err) {
      const message = err instanceof Error && "issues" in err ? zodMessage(err) : (err as Error).message;
      errors.push({ kind: e.kind, id: e.id, message });
      return undefined;
    }
  };

  // --- runner ---
  const agent = { ...base.agent };
  const claude = single(entries, "claude");
  if (claude) {
    agent.runner = claude.data.runner === "echo" ? "echo" : "claude-code";
    agent.oauthToken = str(claude.secrets.oauthToken) ?? base.agent.oauthToken;
  }
  const anthropic = single(entries, "anthropic");
  if (anthropic) agent.fallbackApiKey = str(anthropic.secrets.fallbackApiKey);

  // --- triage ---
  const triage = { ...base.triage };
  if (anthropic) triage.anthropicApiKey = str(anthropic.secrets.triageApiKey);
  const jev = single(entries, "jev");
  if (jev) Object.assign(triage, { jevApiKey: str(jev.secrets.apiKey), jevBaseUrl: str(jev.data.baseUrl), jevModel: str(jev.data.model) });

  // --- voice ---
  const providers = { ...base.voice.providers };
  const openai = single(entries, "openai");
  if (openai) providers.openaiApiKey = str(openai.secrets.apiKey);
  const eleven = single(entries, "elevenlabs");
  if (eleven) providers.elevenlabsApiKey = str(eleven.secrets.apiKey);
  const voice = single(entries, "voice");
  if (voice) {
    const pick = (v: unknown) => (["auto", "openai", "elevenlabs", "off"].includes(String(v)) ? (v as typeof providers.stt) : "auto");
    providers.stt = pick(voice.data.stt);
    providers.tts = pick(voice.data.tts);
    providers.openaiVoice = str(voice.data.openaiVoice) ?? base.voice.providers.openaiVoice;
    providers.elevenlabsVoice = str(voice.data.elevenlabsVoice) ?? base.voice.providers.elevenlabsVoice;
  }
  // A named provider without its key would throw when built: fall back to auto, and say so.
  for (const dir of ["stt", "tts"] as const) {
    const p = providers[dir];
    if ((p === "openai" && !providers.openaiApiKey) || (p === "elevenlabs" && !providers.elevenlabsApiKey)) {
      errors.push({ kind: "voice", id: DEFAULT_ID, message: `${dir === "stt" ? "Speech to text" : "Text to speech"} is set to ${p}, which has no API key; using auto` });
      providers[dir] = "auto";
    }
  }

  // --- odoo ---
  let odoo = base.odoo;
  let odooEvents = base.odooEvents;
  const odooEntry = single(entries, "odoo");
  if (odooEntry) {
    const v = values(odooEntry);
    const built = attempt(odooEntry, () => {
      const url = str(v.url), db = str(v.db), username = str(v.username), apiKey = str(v.apiKey);
      if (!url || !db || !username || !apiKey) throw new Error("URL, database, login and API key are all needed");
      return { url: url.replace(/\/+$/, ""), db, username, apiKey, api: v.api === "json2" ? ("json2" as const) : ("jsonrpc" as const) };
    });
    odoo = built;
    if (built && !base.odoo) {
      odooEvents = attempt(odooEntry, () => parseOdooEventsConfig(base.odooEventsRaw) ?? undefined);
    }
    if (!built) odooEvents = undefined;
  }

  // --- email ---
  const emailEntries = entries.filter((e) => e.kind === "email");
  const emailAccounts = mergeById(
    base.email.accounts,
    emailEntries.flatMap((e) => attempt(e, () => emailAccountOf(e)) ?? []),
  );

  // --- social ---
  const socialEntries = entries.filter((e) => (SOCIAL as readonly string[]).includes(e.kind));
  const socialAccounts = mergeById(
    base.social.accounts,
    socialEntries.flatMap((e) => attempt(e, () => socialAccountOf(e, entries)) ?? []),
  );

  // --- calendar ---
  const googleEntries = entries.filter((e) => e.kind === "google");
  const calendarAccounts = mergeById(
    base.pa.calendarAccounts,
    googleEntries.filter((e) => bool(e.data.useForCalendar, true)).flatMap((e) => attempt(e, () => calendarAccountOf(e, base, entries)) ?? []),
  );

  // --- storage ---
  const storage = { ...base.storage };
  const storageEntry = single(entries, "storage");
  if (storageEntry) {
    if (storageEntry.data.backend === "gdrive") {
      const accountId = str(storageEntry.data.googleAccount) ?? googleEntries[0]?.id;
      const g = googleEntries.find((e) => e.id === accountId);
      const { clientId, clientSecret } = googleApp(base, entries);
      const refreshToken = g ? str(g.secrets.refreshToken) : undefined;
      if (clientId && clientSecret && refreshToken) {
        storage.backend = "gdrive";
        storage.google = { clientId, clientSecret, refreshToken };
      } else {
        errors.push({ kind: "storage", id: DEFAULT_ID, message: "Drive needs a connected Google account and the Google OAuth client; files stay on the volume" });
        storage.backend = base.storage.backend;
        storage.google = base.storage.google;
      }
    } else {
      storage.backend = "local";
      storage.google = undefined;
    }
  }

  return {
    config: {
      ...base,
      agent,
      triage,
      voice: { ...base.voice, providers },
      odoo,
      odooEvents,
      email: { ...base.email, accounts: emailAccounts },
      social: { ...base.social, accounts: socialAccounts },
      pa: { ...base.pa, calendarAccounts },
      storage,
    },
    errors,
  };
}

function zodMessage(err: Error): string {
  const issues = (err as unknown as { issues: { path: PropertyKey[]; message: string }[] }).issues;
  return issues.map((i) => `${i.path.join(".") || "value"}: ${i.message.replace(/, received .*/, "")}`).join("; ");
}

/** The part of the config each group is built from. */
export function groupSection(config: Config, group: Group): unknown {
  switch (group) {
    case "runner":
      return { runner: config.agent.runner, oauthToken: config.agent.oauthToken, fallbackApiKey: config.agent.fallbackApiKey, bin: config.agent.claudeBin };
    case "triage":
      return config.triage;
    case "voice":
      return config.voice.providers;
    case "odoo":
      return { odoo: config.odoo, events: config.odooEvents };
    case "email":
      return config.email.accounts;
    case "social":
      return config.social.accounts;
    case "calendar":
      return config.pa.calendarAccounts;
    case "storage":
      return config.storage;
  }
}

/** Stable hash of a group's section, so a reload touches only groups whose config changed. */
export function fingerprint(config: Config, group: Group): string {
  return createHash("sha256").update(stableJson(groupSection(config, group))).digest("hex");
}

function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/** What Railway (env) provides, as entries: shown as "From Railway" and copied by "Move into app". */
export function railwayEntries(base: Config): EntryInput[] {
  const out: EntryInput[] = [];
  const add = (kind: string, id: string, data: Record<string, unknown>, secrets: Record<string, string | undefined>) => {
    const s = Object.fromEntries(Object.entries(secrets).filter((kv): kv is [string, string] => !!kv[1]));
    const d = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    out.push({ kind, id, data: d, secrets: s });
  };
  const a = base.agent;
  if (a.oauthToken || a.runner === "echo") add("claude", DEFAULT_ID, { runner: a.runner }, { oauthToken: a.oauthToken });
  if (a.fallbackApiKey || base.triage.anthropicApiKey) add("anthropic", DEFAULT_ID, {}, { fallbackApiKey: a.fallbackApiKey, triageApiKey: base.triage.anthropicApiKey });
  if (base.triage.jevApiKey) add("jev", DEFAULT_ID, { baseUrl: base.triage.jevBaseUrl, model: base.triage.jevModel }, { apiKey: base.triage.jevApiKey });
  const p = base.voice.providers;
  if (p.openaiApiKey) add("openai", DEFAULT_ID, {}, { apiKey: p.openaiApiKey });
  if (p.elevenlabsApiKey) add("elevenlabs", DEFAULT_ID, {}, { apiKey: p.elevenlabsApiKey });
  if (base.odoo) add("odoo", DEFAULT_ID, { url: base.odoo.url, db: base.odoo.db, username: base.odoo.username, api: base.odoo.api }, { apiKey: base.odoo.apiKey });
  for (const m of base.email.accounts) {
    add(
      "email",
      m.id,
      {
        vertical: m.vertical,
        address: m.address,
        displayName: m.displayName,
        imapHost: m.imap.host,
        imapPort: m.imap.port,
        imapSecure: m.imap.secure,
        smtpHost: m.smtp.host,
        smtpPort: m.smtp.port,
        smtpSecure: m.smtp.secure,
        user: m.imap.user,
        mailbox: m.mailbox,
        ignoreFrom: m.ignoreFrom,
      },
      { password: m.imap.pass },
    );
  }
  for (const s of base.social.accounts) {
    add(
      s.platform,
      s.id,
      { vertical: s.vertical, handle: s.handle, displayName: s.displayName, inbound: s.inbound, options: Object.keys(s.options).length ? JSON.stringify(s.options) : undefined },
      // The whole credential map moves, app keys included, so nothing is lost.
      { ...s.credentials },
    );
  }
  const google = base.storage.google ?? base.pa.calendarAccounts[0]?.credentials;
  if (google?.clientId) add("google-app", DEFAULT_ID, { clientId: google.clientId }, { clientSecret: google.clientSecret });
  for (const c of base.pa.calendarAccounts) {
    add("google", c.id, { vertical: c.vertical, calendars: JSON.stringify(c.calendars.map(({ id, name, write }) => ({ id, name, write }))), useForCalendar: true }, { refreshToken: c.credentials.refreshToken });
  }
  if (base.storage.backend === "gdrive") add("storage", DEFAULT_ID, { backend: "gdrive", googleAccount: base.pa.calendarAccounts[0]?.id }, {});
  return out;
}
