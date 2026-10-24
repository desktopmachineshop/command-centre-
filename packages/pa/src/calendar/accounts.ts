import { z } from "zod";
import { GOOGLE_ENV, type GoogleOAuthCredentials } from "../google/oauth";
import { GoogleCalendarProvider } from "./google";
import type { CalendarInfo, CalendarProvider } from "./types";

/**
 * A credential value, or `"env:NAME"` to read it from another variable
 * (keeps the refresh token out of the CALENDAR_ACCOUNTS JSON if you prefer).
 */
const Secret = z.string().min(1);

const CalendarEntry = z.union([
  z.string().min(1).transform((id) => ({ id, name: undefined as string | undefined, write: undefined as boolean | undefined })),
  z.object({
    /** "primary", or a calendar id such as "family01234@group.calendar.google.com". */
    id: z.string().min(1),
    /** Shown to agents and on the Today page. Default: "Primary" for primary, else the id. */
    name: z.string().min(1).optional(),
    /** May events be created here. Default true. Shared calendars you can only read: set false. */
    write: z.boolean().optional(),
  }),
]);

export const GoogleCalendarAccount = z.object({
  /** Stable id, used in action payloads and event references. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "id must be letters, digits, - or _"),
  provider: z.literal("google"),
  /** Which vertical's agents may use it. The personal vertical can read every account's events. */
  vertical: z.string().min(1),
  calendars: z.array(CalendarEntry).min(1).default([{ id: "primary", name: undefined, write: undefined }]),
  /**
   * Optional. Each field defaults to the shared GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
   * GOOGLE_REFRESH_TOKEN, so set it only to use a different Google account or client.
   */
  credentials: z.object({ clientId: Secret.optional(), clientSecret: Secret.optional(), refreshToken: Secret.optional() }).default({}),
});
type ParsedAccount = z.infer<typeof GoogleCalendarAccount>;
/** An account with its credentials resolved. */
export type CalendarAccount = Omit<ParsedAccount, "credentials"> & { credentials: GoogleOAuthCredentials };
export type CalendarAccountInput = z.input<typeof GoogleCalendarAccount>;

export const CalendarAccounts = z
  .array(GoogleCalendarAccount)
  .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "account ids must be unique");

/** Fills omitted credentials from the shared GOOGLE_* variables and resolves `"env:NAME"` values. */
function resolveSecrets(account: ParsedAccount, env: Record<string, string | undefined>): CalendarAccount {
  const credentials = {} as GoogleOAuthCredentials;
  for (const key of ["clientId", "clientSecret", "refreshToken"] as const) {
    const value = account.credentials[key] ?? `env:${GOOGLE_ENV[key]}`;
    const m = /^env:([A-Z_][A-Z0-9_]*)$/i.exec(value);
    if (!m) {
      credentials[key] = value;
      continue;
    }
    const resolved = env[m[1]!]?.trim();
    if (!resolved) {
      throw new Error(
        account.credentials[key]
          ? `CALENDAR_ACCOUNTS is invalid: ${account.id}.credentials.${key} refers to ${m[1]}, which is not set`
          : `CALENDAR_ACCOUNTS is invalid: ${account.id} needs ${m[1]} set (or credentials.${key} on the account)`,
      );
    }
    credentials[key] = resolved;
  }
  return { ...account, credentials };
}

/**
 * Parses `CALENDAR_ACCOUNTS`. Errors name the account and field, never a value:
 * the JSON holds OAuth secrets, so not even the JSON parser's snippet is echoed.
 */
export function parseCalendarAccounts(json: string | undefined, env: Record<string, string | undefined> = process.env): CalendarAccount[] {
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("CALENDAR_ACCOUNTS is not valid JSON (check quotes and commas; it must be one line in the variable)");
  }
  const parsed = CalendarAccounts.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const path = i.path.join(".") || "(root)";
      // Only the shape, never what was received.
      const message = i.code === "invalid_value" || i.code === "invalid_union" ? "invalid value" : i.message.replace(/, received .*/, "");
      return `${path}: ${message}`;
    });
    throw new Error(`CALENDAR_ACCOUNTS is invalid: ${issues.join("; ")}${parsed.error.issues.some((i) => i.path[1] === "provider") ? ' (only provider "google" is supported)' : ""}`);
  }
  return parsed.data.map((a) => resolveSecrets(a, env));
}

export function calendarInfos(account: CalendarAccount): CalendarInfo[] {
  return account.calendars.map((c) => ({
    id: c.id,
    name: c.name ?? (c.id === "primary" ? "Primary" : c.id),
    writable: c.write ?? true,
    primary: c.id === "primary",
  }));
}

/** An account as the app and agents may see it: no credentials. */
export function publicCalendarAccount(account: CalendarAccount) {
  return { id: account.id, provider: account.provider, vertical: account.vertical, calendars: calendarInfos(account) };
}

export function createProvider(account: CalendarAccount, options: { fetch?: typeof fetch; now?: () => number } = {}): CalendarProvider {
  return new GoogleCalendarProvider({ accountId: account.id, credentials: account.credentials, calendars: calendarInfos(account), ...options });
}
