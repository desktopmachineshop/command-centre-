import { type EmailAccount, type ImapConnector, imapflowConnector, sendRoute, smtpAuth, verifyHttpsSending } from "@cc/email";
import { OdooClient } from "@cc/odoo";
import { createGoogleTokenProvider } from "@cc/pa";
import { SENDCLOUD_API, SendcloudClient } from "@cc/sendcloud";
import { IG_GRAPH_BASE, REDDIT_API, REDDIT_TOKEN_URL, THREADS_BASE, X_API_BASE, xOAuth1, youtubeOAuth } from "@cc/social";
import nodemailer from "nodemailer";
import { emailAccountOf, type EntryInput } from "./effective";
import type { CredentialTest } from "./service";

/**
 * "Test connection" per kind: one cheap authenticated call where the service has one, a
 * format check where it doesn't (or where a call would cost money or run an agent).
 * Messages name the service and the outcome, never a credential.
 */
export interface TestEndpoints {
  anthropic: string;
  openai: string;
  elevenlabs: string;
  googleUserinfo: string;
  instagramApi: string;
  threadsApi: string;
  xApi: string;
  redditToken: string;
  redditApi: string;
  discord: string;
  sendcloud: string;
}

export const DEFAULT_TEST_ENDPOINTS: TestEndpoints = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  elevenlabs: "https://api.elevenlabs.io",
  googleUserinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  instagramApi: IG_GRAPH_BASE,
  threadsApi: THREADS_BASE,
  xApi: X_API_BASE,
  redditToken: REDDIT_TOKEN_URL,
  redditApi: REDDIT_API,
  discord: "https://discord.com/api/v10",
  sendcloud: SENDCLOUD_API,
};

export interface TestDeps {
  fetch?: typeof fetch;
  urls?: Partial<TestEndpoints>;
  /** IMAP login for email (tests use a MemoryMailbox). */
  imap?: ImapConnector;
  /** SMTP login check for email. Default: nodemailer's verify(). */
  smtpVerify?: (account: EmailAccount) => Promise<void>;
  timeoutMs?: number;
}

type Result = { ok: boolean; message: string; account?: string };

const ok = (message: string, account?: string): Result => ({ ok: true, message, ...(account ? { account } : {}) });
const fail = (message: string): Result => ({ ok: false, message });

function redact(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 6) for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("[redacted]");
  return out;
}

/** A plain "rejected" / "unreachable" message for a failed response. */
async function failed(res: Response, label: string): Promise<Result> {
  if (res.status === 401 || res.status === 403) return fail(`${label} rejected the credentials (HTTP ${res.status})`);
  if (res.status === 429) return fail(`${label} is rate limiting this key (HTTP 429); try again later`);
  return fail(`${label} answered HTTP ${res.status}`);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

const defaultSmtpVerify = async (account: EmailAccount): Promise<void> => {
  const transport = nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, auth: await smtpAuth(account) });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
};

export function credentialTests(deps: TestDeps = {}): Record<string, CredentialTest> {
  const f: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const urls = { ...DEFAULT_TEST_ENDPOINTS, ...deps.urls };
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const get = (url: string, headers: Record<string, string> = {}) => f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

  /** Google access token from a refresh token and the shared OAuth client. */
  const googleToken = async (entry: EntryInput, app: Record<string, string> | undefined): Promise<string> => {
    const clientId = app?.clientId ?? entry.secrets.clientId;
    const clientSecret = app?.clientSecret ?? entry.secrets.clientSecret;
    const refreshToken = entry.secrets.refreshToken;
    if (!clientId || !clientSecret) throw new Error("Add the Google OAuth client first (Developer apps → Google OAuth client)");
    if (!refreshToken) throw new Error("Not connected yet: press Connect");
    return createGoogleTokenProvider({ clientId, clientSecret, refreshToken, fetch: f, label: entry.id }).getAccessToken();
  };

  const metaMe = (label: string, base: string, fields: string, idKey: "user_id" | "id"): CredentialTest => async (entry) => {
    const token = entry.secrets.accessToken;
    if (!token) return fail("Not connected yet: press Connect");
    const url = new URL(`${base}/me`);
    url.search = new URLSearchParams({ fields, access_token: token }).toString();
    const res = await get(url.toString());
    if (!res.ok) {
      const body = await json<{ error?: { message?: string; code?: number } }>(res);
      if (body.error?.code === 190) return fail(`${label} says the sign-in has expired or was revoked; reconnect it`);
      return failed(res, label);
    }
    const me = await json<{ username?: string; user_id?: string | number; id?: string }>(res);
    const account = me.username ? `@${me.username}` : String(me[idKey] ?? "");
    return ok(`${label} accepted the token${account ? ` (${account})` : ""}`, account || undefined);
  };

  /** IMAP login and open the folder, then an SMTP login: what the poller and replies need. */
  const mailboxTest = async (account: EmailAccount, secrets: string[]) => {
    try {
      const session = await withTimeout((deps.imap ?? imapflowConnector)(account), timeoutMs, "IMAP login");
      try {
        await session.open(account.mailbox);
      } finally {
        await session.close().catch(() => {});
      }
    } catch (err) {
      return fail(redact(`IMAP (${account.imap.host}): ${(err as Error).message}`, secrets).slice(0, 300));
    }
    const route = sendRoute(account);
    if (route !== "smtp" && !deps.smtpVerify) {
      const api = route === "gmail" ? "the Gmail API" : "Microsoft Graph";
      try {
        await withTimeout(verifyHttpsSending(account), timeoutMs, "Sign-in for sending");
      } catch (err) {
        return fail(redact(`IMAP works, but sending through ${api}: ${(err as Error).message}`, secrets).slice(0, 300));
      }
      return ok(`Signed in to IMAP as ${account.imap.user}; replies send through ${api}`, account.address);
    }
    try {
      await withTimeout((deps.smtpVerify ?? defaultSmtpVerify)(account), timeoutMs, "SMTP login");
    } catch (err) {
      const hint = /timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test((err as Error).message)
        ? " The server can't reach the SMTP port: Railway blocks outgoing SMTP below the Pro plan. For Gmail, connect the same address under Google so replies send through the Gmail API."
        : "";
      return fail(redact(`IMAP works, but SMTP (${account.smtp.host}): ${(err as Error).message}.${hint}`, secrets).slice(0, 400));
    }
    return ok(`Signed in to IMAP and SMTP as ${account.imap.user}`, account.address);
  };

  const tests: Record<string, CredentialTest> = {
    async claude(entry) {
      if (entry.data.runner === "echo") return ok("The echo runner makes no AI calls; nothing to check");
      const token = entry.secrets.oauthToken;
      if (!token) return fail("No subscription token saved");
      if (!token.startsWith("sk-ant-oat01-")) return fail("That isn't a subscription token (they start sk-ant-oat01-; run `claude setup-token` on your PC)");
      return ok("Looks like a subscription token; it will be checked on the first agent run");
    },

    async anthropic(entry) {
      const keys = (["fallbackApiKey", "triageApiKey"] as const).filter((k) => entry.secrets[k]);
      if (!keys.length) return fail("No API key saved");
      const label = { fallbackApiKey: "Fallback key", triageApiKey: "Triage key" };
      const results = await Promise.all(
        keys.map(async (k) => {
          const res = await get(`${urls.anthropic}/v1/models?limit=1`, { "x-api-key": entry.secrets[k]!, "anthropic-version": "2023-06-01" });
          return { k, res: res.ok ? ok("works") : await failed(res, "Anthropic") };
        }),
      );
      const allOk = results.every((r) => r.res.ok);
      return { ok: allOk, message: results.map((r) => `${label[r.k]}: ${r.res.ok ? "works" : r.res.message}`).join("; ") };
    },

    async jev(entry) {
      const key = entry.secrets.apiKey;
      if (!key) return fail("No API key saved");
      if (key.length < 16 || /\s/.test(key)) return fail("That doesn't look like a Jev API key");
      return ok("Saved. Jev has no free check call, so the key is checked on the next triage");
    },

    async openai(entry) {
      const key = entry.secrets.apiKey;
      if (!key) return fail("No API key saved");
      const res = await get(`${urls.openai}/v1/models`, { authorization: `Bearer ${key}` });
      return res.ok ? ok("OpenAI accepted the key") : failed(res, "OpenAI");
    },

    async elevenlabs(entry) {
      const key = entry.secrets.apiKey?.trim();
      if (!key) return fail("No API key saved");
      const headers = { "xi-api-key": key };
      // ElevenLabs keys can be restricted to some permissions. A key without "User: Read" gets 401 on /v1/user
      // even though it works for speech, so a 401 is only "rejected" when ElevenLabs says the key itself is bad.
      const reason = async (res: Response) => (await json<{ detail?: { status?: string; message?: string } }>(res)).detail;
      const res = await get(`${urls.elevenlabs}/v1/user`, headers);
      if (res.ok) {
        const body = await json<{ first_name?: string; subscription?: { tier?: string } }>(res);
        return ok(`ElevenLabs accepted the key${body.subscription?.tier ? ` (${body.subscription.tier} plan)` : ""}`, body.first_name);
      }
      if (res.status !== 401) return failed(res, "ElevenLabs");
      const detail = await reason(res);
      if (detail?.status !== "missing_permissions") {
        const why = detail?.message ? `: ${redact(detail.message, [key]).slice(0, 200)}` : "";
        return fail(`ElevenLabs rejected the API key (HTTP 401${why}). Copy it again from elevenlabs.io → Developers → API keys`);
      }
      const voices = await get(`${urls.elevenlabs}/v1/voices`, headers);
      if (voices.ok) return ok("ElevenLabs accepted the key (restricted key, so the plan isn't shown)");
      if (voices.status === 401 && (await reason(voices))?.status === "missing_permissions") {
        return ok("ElevenLabs accepted the key, but it is restricted: make sure Text to Speech, Speech to Text and Voices (read) are allowed");
      }
      return failed(voices, "ElevenLabs");
    },

    async odoo(entry) {
      const { url, db, username, api } = entry.data as Record<string, string | undefined>;
      const apiKey = entry.secrets.apiKey;
      if (!url || !db || !username || !apiKey) return fail("URL, database, login and API key are all needed");
      const client = new OdooClient({ url, db, username, apiKey, api: api === "json2" ? "json2" : "jsonrpc", fetch: f, timeoutMs });
      try {
        const uid = await client.authenticate();
        const [user] = await client.read("res.users", [uid], ["name"]);
        const name = typeof user?.name === "string" ? user.name : username;
        return ok(`Signed in to Odoo as ${name}`, name);
      } catch (err) {
        return fail(redact(`Odoo: ${(err as Error).message}`, [apiKey]).slice(0, 300));
      }
    },

    async sendcloud(entry) {
      const publicKey = (entry.data.publicKey as string | undefined)?.trim();
      const secretKey = entry.secrets.secretKey;
      if (!publicKey || !secretKey) return fail("Public key and secret key are both needed");
      try {
        const user = await new SendcloudClient({ publicKey, secretKey, baseUrl: urls.sendcloud, fetch: f, timeoutMs }).user();
        const account = user.companyName ?? user.username ?? undefined;
        return ok(`Sendcloud accepted the keys${account ? ` (${account})` : ""}`, account);
      } catch (err) {
        return fail(redact((err as Error).message, [secretKey, publicKey]).slice(0, 300));
      }
    },

    async email(entry, config) {
      // The account in use (with its Gmail sign-in for sending, if any), else the entry as typed.
      let account: EmailAccount | undefined = config?.email?.accounts.find((a) => a.id === entry.id && !a.oauth);
      try {
        account ??= emailAccountOf(entry);
      } catch {
        return fail("The mailbox settings are incomplete");
      }
      return mailboxTest(account, [account.imap.pass ?? "", account.smtp.pass ?? ""]);
    },

    async gmail(entry, config) {
      const account = config.email.accounts.find((a) => a.id === entry.id && a.oauth?.provider === "google");
      if (!account) return fail("Not connected yet: press Connect (and add the Google OAuth client first)");
      return mailboxTest(account, [account.oauth?.refreshToken ?? "", account.oauth?.clientSecret ?? ""]);
    },

    async outlook(entry, config) {
      const account = config.email.accounts.find((a) => a.id === entry.id && a.oauth);
      if (!account) return fail("Not connected yet: press Connect (and add the Microsoft app's keys first)");
      return mailboxTest(account, [account.oauth?.refreshToken ?? "", account.oauth?.clientSecret ?? ""]);
    },

    async google(entry, _config, ctx) {
      let token: string;
      try {
        token = await googleToken(entry, await ctx.app("google-app"));
      } catch (err) {
        return fail((err as Error).message);
      }
      const res = await get(urls.googleUserinfo, { authorization: `Bearer ${token}` });
      if (!res.ok) return failed(res, "Google");
      const info = await json<{ email?: string }>(res);
      return ok(`Google accepted the sign-in${info.email ? ` (${info.email})` : ""}`, info.email);
    },

    async youtube(entry, _config, ctx) {
      try {
        const token = await googleToken(entry, await ctx.app("google-app"));
        const channels = await youtubeOAuth.fetchOwnChannels(f, token);
        const channelId = String(entry.data.channelId ?? entry.secrets.channelId ?? "");
        const channel = channels.find((c) => c.id === channelId) ?? channels[0];
        if (!channel) return fail("That Google account has no YouTube channel");
        if (channelId && channel.id !== channelId) return fail(`The sign-in is for channel ${channel.title}, not the saved channel id`);
        const name = channel.customUrl ?? channel.title;
        return ok(`YouTube accepted the sign-in (${name})`, name);
      } catch (err) {
        return fail((err as Error).message.slice(0, 300));
      }
    },

    instagram: metaMe("Instagram", urls.instagramApi, "user_id,username", "user_id"),
    threads: metaMe("Threads", urls.threadsApi, "id,username", "id"),

    async x(entry, _config, ctx) {
      const app = await ctx.app("x-app");
      const consumerKey = app?.apiKey ?? entry.secrets.apiKey;
      const consumerSecret = app?.apiSecret ?? entry.secrets.apiSecret;
      const { accessToken, accessTokenSecret } = entry.secrets;
      if (!consumerKey || !consumerSecret) return fail("Add the X app keys first (Developer apps → X app)");
      if (!accessToken || !accessTokenSecret) return fail("Not connected yet: press Connect");
      const url = `${urls.xApi}/2/users/me`;
      const auth = xOAuth1.authorizationHeader({ method: "GET", url }, { consumerKey, consumerSecret, token: accessToken, tokenSecret: accessTokenSecret });
      const res = await get(url, { authorization: auth });
      if (!res.ok) return failed(res, "X");
      const body = await json<{ data?: { username?: string } }>(res);
      const handle = body.data?.username ? `@${body.data.username}` : undefined;
      return ok(`X accepted the sign-in${handle ? ` (${handle})` : ""}`, handle);
    },

    async reddit(entry, _config, ctx) {
      const c = { ...(await ctx.app("reddit-app")), ...entry.secrets };
      if (!c.clientId || !c.clientSecret) return fail("Add the Reddit app keys first (Developer apps → Reddit app)");
      const userAgent = c.userAgent ?? "web:command-centre:1.0";
      const grant: Record<string, string> | null = c.refreshToken
        ? { grant_type: "refresh_token", refresh_token: c.refreshToken }
        : c.username && c.password
          ? { grant_type: "password", username: c.username, password: c.password }
          : null;
      if (!grant) return fail("Not connected yet: press Connect");
      const res = await f(urls.redditToken, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": userAgent,
        },
        body: new URLSearchParams(grant).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const token = await json<{ access_token?: string; error?: string }>(res);
      if (!res.ok || !token.access_token) {
        if (token.error === "invalid_grant") return fail("Reddit says the sign-in was revoked or has expired; reconnect it");
        return res.ok ? fail("Reddit refused the sign-in") : failed(res, "Reddit");
      }
      const me = await get(`${urls.redditApi}/api/v1/me`, { authorization: `bearer ${token.access_token}`, "user-agent": userAgent });
      if (!me.ok) return failed(me, "Reddit");
      const name = (await json<{ name?: string }>(me)).name;
      return ok(`Reddit accepted the sign-in${name ? ` (u/${name})` : ""}`, name ? `u/${name}` : undefined);
    },

    async discord(entry) {
      const token = entry.secrets.botToken;
      if (!token) return fail("No bot token saved");
      const res = await get(`${urls.discord}/users/@me`, { authorization: `Bot ${token}` });
      if (!res.ok) return failed(res, "Discord");
      const bot = await json<{ username?: string }>(res);
      return ok(`Discord accepted the bot token${bot.username ? ` (${bot.username})` : ""}`, bot.username);
    },

    // --- Developer apps: format checks; the keys are really checked by the first Connect ---
    async "google-app"(entry) {
      const id = String(entry.data.clientId ?? "");
      if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) return fail("The client ID should end in .apps.googleusercontent.com");
      if (!entry.secrets.clientSecret) return fail("No client secret saved");
      return ok("Looks right; Google checks it when you connect an account");
    },
    async "instagram-app"(entry) {
      return metaAppCheck(entry, "Instagram");
    },
    async "threads-app"(entry) {
      return metaAppCheck(entry, "Threads");
    },
    async "x-app"(entry) {
      const key = String(entry.data.apiKey ?? "");
      if (key.length < 10 || /\s/.test(key)) return fail("That doesn't look like an X API key");
      if ((entry.secrets.apiSecret ?? "").length < 20) return fail("That doesn't look like an X API key secret");
      return ok("Looks right; X checks it when you connect an account");
    },
    async "reddit-app"(entry) {
      if (!String(entry.data.clientId ?? "").trim()) return fail("No client id saved");
      if (!entry.secrets.clientSecret) return fail("No secret saved");
      const ua = String(entry.data.userAgent ?? "");
      if (ua && !/\(by \/?u\/[A-Za-z0-9_-]+\)/.test(ua)) return fail("The user agent should look like web:command-centre:1.0 (by /u/yourname)");
      return ok("Looks right; Reddit checks it when you connect an account");
    },
  };
  return tests;
}

function metaAppCheck(entry: EntryInput, label: string): Result {
  if (!/^\d{6,}$/.test(String(entry.data.appId ?? ""))) return fail(`The ${label} app ID should be a number`);
  if (!/^[0-9a-f]{32}$/i.test(entry.secrets.appSecret ?? "")) return fail(`The ${label} app secret should be 32 hex characters`);
  return ok(`Looks right; Meta checks it when you connect an account`);
}
