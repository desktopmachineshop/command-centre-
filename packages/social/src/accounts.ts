import { z } from "zod";
import { adapters as defaultAdapters } from "./adapters";
import { type Platform, type PlatformAdapter, SocialAccount } from "./types";

/** Adapters by platform. Tests (and the server's `socialAdapters` override) pass fakes. */
export type AdapterMap = Partial<Record<Platform, PlatformAdapter>>;

export const SocialAccounts = z
  .array(SocialAccount)
  .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "account ids must be unique");

export interface ParseSocialAccountsOptions {
  /** Adapters whose `credentials` schemas check each account. Defaults to the real ones. */
  adapters?: AdapterMap;
  /**
   * false checks only the account shape and unique ids, not credentials. The server
   * does this at config load and checks credentials once it knows which adapters it runs.
   */
  checkCredentials?: boolean;
  /** Name used in error messages. */
  name?: string;
}

/**
 * Parses the `SOCIAL_ACCOUNTS` JSON (an array of `SocialAccount`). Empty or unset
 * means no accounts. Errors name the account and field but never echo a value,
 * because this JSON holds API tokens.
 */
export function parseSocialAccounts(json: string | undefined, options: ParseSocialAccountsOptions = {}): SocialAccount[] {
  const name = options.name ?? "SOCIAL_ACCOUNTS";
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    // V8's message quotes the input around the error, which could be a token: keep only the position.
    const at = /position (\d+)/.exec((err as Error).message)?.[1];
    throw new Error(`${name} is not valid JSON${at ? ` (error at character ${at})` : ""}`);
  }
  const parsed = SocialAccounts.safeParse(raw);
  if (!parsed.success) {
    const secrets = secretValues(raw);
    const issues = parsed.error.issues.map((i) => `${describePath(raw, i.path)}: ${scrub(i.message, secrets)}`).join("; ");
    throw new Error(`${name} is invalid: ${issues}`);
  }
  if (options.checkCredentials === false) return parsed.data;
  return validateSocialCredentials(parsed.data, options.adapters ?? defaultAdapters, name);
}

/**
 * Checks each account's credentials against its adapter's schema and returns
 * the accounts with the parsed credentials. Throws one error listing every problem.
 */
export function validateSocialCredentials(accounts: SocialAccount[], adapters: AdapterMap, name = "SOCIAL_ACCOUNTS"): SocialAccount[] {
  const problems: string[] = [];
  const out = accounts.map((account) => {
    const adapter = adapters[account.platform];
    if (!adapter) {
      problems.push(`account "${account.id}": no adapter for platform "${account.platform}"`);
      return account;
    }
    const result = adapter.credentials.safeParse(account.credentials);
    if (!result.success) {
      const secrets = Object.values(account.credentials);
      for (const issue of result.error.issues) {
        const field = issue.path.length ? `credentials.${issue.path.join(".")}` : "credentials";
        problems.push(`account "${account.id}" (${account.platform}) ${field}: ${scrub(issue.message, secrets)}`);
      }
      return account;
    }
    return { ...account, credentials: result.data };
  });
  if (problems.length) throw new Error(`${name} is invalid: ${problems.join("; ")}`);
  return out;
}

/** "account 2 (\"3dp-x\").credentials.apiKey" rather than "2.credentials.apiKey". */
function describePath(raw: unknown, path: PropertyKey[]): string {
  if (!path.length) return "(root)";
  const [index, ...rest] = path;
  const id = Array.isArray(raw) && typeof index === "number" ? (raw[index] as { id?: unknown } | undefined)?.id : undefined;
  const head = typeof index === "number" ? `account ${index + 1}${typeof id === "string" ? ` ("${id}")` : ""}` : String(index);
  return [head, ...rest.map(String)].join(".");
}

/** Every string under any `credentials` object in the raw JSON. */
function secretValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const creds = (a as { credentials?: unknown } | null)?.credentials;
    return creds && typeof creds === "object" ? Object.values(creds).filter((v): v is string => typeof v === "string") : [];
  });
}

/** Removes any secret that a (custom) validation message might have quoted. */
function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

/** The account's own handle without "@", lower-cased, for self-author checks. */
export function normaliseHandle(handle: string | undefined | null): string | null {
  const h = handle?.trim().replace(/^@/, "").toLowerCase();
  return h || null;
}

/** Public view of an account for the UI and API: never credentials or options. */
export function publicAccount(account: SocialAccount, adapters: AdapterMap) {
  const adapter = adapters[account.platform];
  return {
    id: account.id,
    platform: account.platform,
    vertical: account.vertical,
    handle: account.handle ?? null,
    displayName: account.displayName ?? null,
    inbound: account.inbound,
    capabilities: adapter?.capabilities ?? null,
    inboundSupported: Boolean(adapter?.inbound && adapter.capabilities.inbound),
  };
}
export type PublicSocialAccount = ReturnType<typeof publicAccount>;
