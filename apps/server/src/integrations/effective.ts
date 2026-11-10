import { createHash } from "node:crypto";
import { EmailAccount } from "@cc/email";
import { parseOdooEventsConfig } from "@cc/odoo";
import { OpenGymAccount } from "@cc/opengym";
import { type CalendarAccount, GoogleCalendarAccount } from "@cc/pa";
import { SendcloudAccount } from "@cc/sendcloud";
import { parseElevenLabsVoices } from "@cc/voice";
import type { Platform, SocialAccount } from "@cc/social";
import { AGENT_ROUTES, type AgentRoute, type Config } from "../config";
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

const SOCIAL: readonly string[] = ["discord", "instagram", "threads", "x", "reddit", "reddit-session", "reddit-browser", "youtube"];
/** Kinds that are a second way to sign in to a platform, not a platform of their own. */
const KIND_PLATFORM: Record<string, Platform> = { "reddit-session": "reddit", "reddit-browser": "reddit" };
/** The social platform an Accounts-page kind signs in to. */
export const platformOfKind = (kind: string): Platform => KIND_PLATFORM[kind] ?? (kind as Platform);
/** The Accounts-page kind a social account was (or would be) saved as. */
export const kindOfAccount = (account: Pick<SocialAccount, "platform" | "credentials">): string =>
  account.platform !== "reddit" ? account.platform : account.credentials.browserNode ? "reddit-browser" : account.credentials.sessionCookie ? "reddit-session" : "reddit";
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
  if (JSON.stringify(all).includes("\\u0000")) errors.push("Fields can't contain control characters");
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

function plainObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${label} must be a JSON object, e.g. {}`);
  return v as Record<string, unknown>;
}

/**
 * The Google sign-in an inbox sends through (Gmail API): the connected Google account with the
 * same address, when "Send replies with" is auto or gmail.
 */
function gmailSender(e: EntryInput, address: string | undefined, base: Config | undefined, entries: EntryInput[]) {
  const via = str(e.data.sendVia) ?? "auto";
  if (via === "smtp" || !address || !base) return undefined;
  const google = entries.find((g) => g.kind === "google" && str(g.data.email)?.toLowerCase() === address.toLowerCase());
  const refreshToken = google ? str(google.secrets.refreshToken) : undefined;
  const { clientId, clientSecret } = googleApp(base, entries);
  const ready = google && refreshToken && clientId && clientSecret && (via === "gmail" || google.data.sendMail === true);
  if (!ready) {
    if (via === "gmail") throw new Error(`connect ${address} under Google (Accounts → Google → Add account) so it can send through Gmail`);
    return undefined;
  }
  return { via: "gmail" as const, clientId: clientId!, clientSecret: clientSecret!, refreshToken: refreshToken! };
}

export function emailAccountOf(e: EntryInput, base?: Config, entries: EntryInput[] = []): EmailAccount {
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
    send: gmailSender(e, address, base, entries),
  });
}

/** Personal Microsoft accounts send through smtp-mail.outlook.com; work (Microsoft 365) ones through smtp.office365.com. */
const PERSONAL_MICROSOFT = /@(outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;

export function gmailInboxOf(e: EntryInput, base: Config, entries: EntryInput[]): EmailAccount {
  const { clientId, clientSecret } = googleApp(base, entries);
  if (!clientId || !clientSecret) throw new Error("needs the Google OAuth client (Developer apps → Google OAuth client)");
  const refreshToken = str(e.secrets.refreshToken);
  const address = str(e.data.address);
  if (!refreshToken || !address) throw new Error("not connected yet: press Connect");
  return EmailAccount.parse({
    id: e.id,
    vertical: e.data.vertical,
    address,
    displayName: str(e.data.displayName),
    imap: { host: "imap.gmail.com", port: 993, secure: true, user: address },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: address },
    mailbox: str(e.data.mailbox) ?? "INBOX",
    ignoreFrom: Array.isArray(e.data.ignoreFrom) ? e.data.ignoreFrom : [],
    oauth: { provider: "google", clientId, clientSecret, refreshToken },
  });
}

export function outlookAccountOf(e: EntryInput, entries: EntryInput[]): EmailAccount {
  const app = single(entries, "microsoft-app");
  const clientId = app ? str(app.data.clientId) : undefined;
  if (!clientId) throw new Error("needs the Microsoft app (Developer apps → Microsoft app)");
  const refreshToken = str(e.secrets.refreshToken);
  const address = str(e.data.address);
  if (!refreshToken || !address) throw new Error("not connected yet: press Connect");
  const smtpHost = PERSONAL_MICROSOFT.test(address) ? "smtp-mail.outlook.com" : "smtp.office365.com";
  return EmailAccount.parse({
    id: e.id,
    vertical: e.data.vertical,
    address,
    displayName: str(e.data.displayName),
    imap: { host: "outlook.office365.com", port: 993, secure: true, user: address },
    smtp: { host: smtpHost, port: 587, secure: false, user: address },
    mailbox: str(e.data.mailbox) ?? "INBOX",
    ignoreFrom: Array.isArray(e.data.ignoreFrom) ? e.data.ignoreFrom : [],
    oauth: { provider: "microsoft", clientId, clientSecret: str(app!.secrets.clientSecret), tenant: str(app!.data.tenant) ?? "common", refreshToken },
  });
}

export function socialAccountOf(e: EntryInput, entries: EntryInput[]): SocialAccount {
  const platform = platformOfKind(e.kind);
  const def = KINDS.get(e.kind)!;
  const credentials: Record<string, string> = {};
  // A session sign-in needs no developer app (and must not pick one up).
  const app = e.kind in KIND_PLATFORM ? undefined : APP_CREDENTIALS[platform];
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
  // Reddit from Dave's PC: which PC is all it needs (no secret at all); blank is any PC.
  if (e.kind === "reddit-browser") credentials.browserNode = str(e.data.browserNode) ?? "any";
  return {
    id: e.id,
    platform,
    vertical: String(e.data.vertical ?? ""),
    ...(Array.isArray(e.data.alsoVerticals) && e.data.alsoVerticals.length
      ? { alsoVerticals: [...new Set(e.data.alsoVerticals.map((v) => String(v).trim()).filter((v) => v && v !== e.data.vertical))] }
      : {}),
    handle: str(e.data.handle),
    displayName: str(e.data.displayName),
    inbound: bool(e.data.inbound, true),
    credentials,
    options: { ...pacingOptions(e), ...plainObject(json<unknown>(e.data.options, {}), "Advanced options") },
  };
}

/** The pacing fields of a paced kind (Reddit session), as the account options the executors read. */
function pacingOptions(e: EntryInput): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["minGapMinutes", "dailyCap"] as const) {
    const v = e.data[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < (key === "dailyCap" ? 1 : 0)) throw new Error(`${key === "dailyCap" ? "Most submissions in 24 hours must be at least 1" : "Minutes between submissions can't be negative"}`);
    out[key] = n;
  }
  return out;
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
    agent.oauthToken = str(claude.secrets.oauthToken);
  }
  const anthropic = single(entries, "anthropic");
  if (anthropic) agent.fallbackApiKey = str(anthropic.secrets.fallbackApiKey);
  const codex = single(entries, "codex");
  if (codex) {
    agent.codexAuth = str(codex.secrets.authJson);
    agent.codexModel = str(codex.data.model);
  }
  const agents = single(entries, "agents");
  if (agents) agent.route = AGENT_ROUTES.includes(agents.data.route as AgentRoute) ? (agents.data.route as AgentRoute) : "claude";

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
    const listed = voice.data.elevenlabsVoices;
    providers.elevenlabsVoices = Array.isArray(listed) ? parseElevenLabsVoices(listed.map(String)) : base.voice.providers.elevenlabsVoices;
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

  // --- shipping (Sendcloud) ---
  const sendcloudEntries = entries.filter((e) => e.kind === "sendcloud");
  const sendcloudAccounts = mergeById(
    base.shipping.accounts,
    sendcloudEntries.flatMap(
      (e) => attempt(e, () => SendcloudAccount.parse({
            id: e.id,
            vertical: e.data.vertical ?? "dms",
            publicKey: str(e.data.publicKey),
            secretKey: str(e.secrets.secretKey),
            ...(typeof e.data.odooNotes === "boolean" ? { odooNotes: e.data.odooNotes } : {}),
          })) ?? [],
    ),
  );

  // --- gym (openGym): a single entry replaces the env account ---
  const gymEntry = entries.find((e) => e.kind === "opengym");
  const gymAccounts = gymEntry
    ? (attempt(gymEntry, () => [
        OpenGymAccount.parse({ id: DEFAULT_ID, vertical: gymEntry.data.vertical ?? "personal", url: str(gymEntry.data.url), token: str(gymEntry.secrets.token) }),
      ]) ?? [])
    : base.gym.accounts;

  // --- email ---
  const emailEntries = entries.filter((e) => e.kind === "email" || e.kind === "outlook" || e.kind === "gmail");
  const emailAccounts = mergeById(
    base.email.accounts,
    emailEntries.flatMap((e) => attempt(e, () => (e.kind === "outlook" ? outlookAccountOf(e, entries) : e.kind === "gmail" ? gmailInboxOf(e, base, entries) : emailAccountOf(e, base, entries))) ?? []),
  );

  // --- social ---
  const socialEntries = entries.filter((e) => SOCIAL.includes(e.kind));
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
      shipping: { ...base.shipping, accounts: sendcloudAccounts },
      gym: { ...base.gym, accounts: gymAccounts },
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
      return {
        runner: config.agent.runner,
        oauthToken: config.agent.oauthToken,
        fallbackApiKey: config.agent.fallbackApiKey,
        bin: config.agent.claudeBin,
        route: config.agent.route,
        codexAuth: config.agent.codexAuth,
        codexModel: config.agent.codexModel,
        codexBin: config.agent.codexBin,
      };
    case "triage":
      return config.triage;
    case "voice":
      return config.voice.providers;
    case "odoo":
      return { odoo: config.odoo, events: config.odooEvents };
    case "shipping":
      return config.shipping.accounts;
    case "gym":
      return config.gym.accounts;
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
  if (a.codexAuth) add("codex", DEFAULT_ID, { model: a.codexModel }, { authJson: a.codexAuth });
  if (a.route !== "claude") add("agents", DEFAULT_ID, { route: a.route }, {});
  if (a.fallbackApiKey || base.triage.anthropicApiKey) add("anthropic", DEFAULT_ID, {}, { fallbackApiKey: a.fallbackApiKey, triageApiKey: base.triage.anthropicApiKey });
  if (base.triage.jevApiKey) add("jev", DEFAULT_ID, { baseUrl: base.triage.jevBaseUrl, model: base.triage.jevModel }, { apiKey: base.triage.jevApiKey });
  const p = base.voice.providers;
  if (p.openaiApiKey) add("openai", DEFAULT_ID, {}, { apiKey: p.openaiApiKey });
  if (p.elevenlabsApiKey) add("elevenlabs", DEFAULT_ID, {}, { apiKey: p.elevenlabsApiKey });
  if (base.odoo) add("odoo", DEFAULT_ID, { url: base.odoo.url, db: base.odoo.db, username: base.odoo.username, api: base.odoo.api }, { apiKey: base.odoo.apiKey });
  for (const a of base.shipping.accounts) add("sendcloud", a.id, { vertical: a.vertical, publicKey: a.publicKey, odooNotes: a.odooNotes }, { secretKey: a.secretKey });
  for (const g of base.gym.accounts) add("opengym", DEFAULT_ID, { vertical: g.vertical, url: g.url }, { token: g.token });
  for (const m of base.email.accounts) {
    if (m.oauth?.provider === "google") {
      add("gmail", m.id, { vertical: m.vertical, address: m.address, displayName: m.displayName, mailbox: m.mailbox, ignoreFrom: m.ignoreFrom }, { refreshToken: m.oauth.refreshToken });
      continue;
    }
    if (m.oauth) {
      add("outlook", m.id, { vertical: m.vertical, address: m.address, displayName: m.displayName, mailbox: m.mailbox, ignoreFrom: m.ignoreFrom }, { refreshToken: m.oauth.refreshToken });
      continue;
    }
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
      { vertical: s.vertical, alsoVerticals: s.alsoVerticals?.length ? s.alsoVerticals : undefined, handle: s.handle, displayName: s.displayName, inbound: s.inbound, options: Object.keys(s.options).length ? JSON.stringify(s.options) : undefined },
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
