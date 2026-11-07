/**
 * openGym HTTP API client (read-only): the profile's synced state document, which holds every
 * workout and weigh-in. Auth is a paired session token sent as `Authorization: Bearer`, the same
 * credential openGym's phone app holds. It is a full sign-in to the profile, so it only ever goes
 * over https (plain http to localhost aside), redirects are never followed, and it never appears
 * in an error message.
 * Spec: https://github.com/DuarteSantos8/openGym/blob/main/api/openapi.yaml
 */

export interface OpenGymClientOptions {
  /** The address openGym is opened at, e.g. https://gym.example.com (a subpath install keeps its path). */
  url: string;
  /** A paired session token. */
  token: string;
  /** Per-request timeout. Default 20s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface OpenGymUser {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export class OpenGymError extends Error {
  override name = "OpenGymError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class OpenGymAuthError extends OpenGymError {
  override name = "OpenGymAuthError";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** openGym's pairing-code alphabet: 8 characters, no 0/O/1/I. A dash or space in the middle is allowed. */
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}[-\s]?[A-HJ-NP-Z2-9]{4}$/i;
/** What a session token is made of (`uid:exp:ver` and a base64url MAC). */
const TOKEN_CHARS = /^[A-Za-z0-9._:~+/=-]+$/;

/** True when `value` is a pairing code rather than a token. */
export function isPairingCode(value: string): boolean {
  return PAIRING_CODE.test(value.trim());
}

/** The server's base URL, checked: https, or http to this machine. */
export function openGymBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new OpenGymError("The openGym address isn't a URL: use the address you open openGym at, e.g. https://gym.example.com");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new OpenGymError("The openGym address must start with https:// (the token is a full sign-in to your profile)");
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

async function call(
  f: typeof fetch,
  url: string,
  init: { method?: string; token?: string; body?: unknown; timeoutMs: number },
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
      // A redirect to http:// or another host would replay the token there.
      redirect: "manual",
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const why = e.name === "TimeoutError" ? `no answer within ${Math.round(init.timeoutMs / 1000)}s` : (e.cause?.code ?? e.name ?? "network error");
    throw new OpenGymError(`openGym unreachable (${why})`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new OpenGymError(`openGym redirects (HTTP ${res.status}): set the address to the https URL openGym is actually served at`, res.status);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // An HTML error page from a proxy: the status says enough.
  }
  if (res.status === 401) throw new OpenGymAuthError("openGym did not accept the token: it expired or was signed out everywhere. Pair again (openGym Settings → Pair the mobile app) and paste the new code on the Accounts page.", 401);
  if (!res.ok) {
    const said = body && typeof (body as { error?: unknown }).error === "string" ? `: ${((body as { error: string }).error).slice(0, 200)}` : "";
    throw new OpenGymError(`openGym answered HTTP ${res.status}${said}`, res.status);
  }
  return { status: res.status, body };
}

/** Swaps a pairing code (valid 5 minutes, one use) for a session token. */
export async function redeemPairingCode(
  url: string,
  code: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ token: string; user: OpenGymUser | null }> {
  const f = options.fetch ?? ((input, init) => fetch(input, init));
  const clean = code.trim().replace(/[-\s]/g, "").toUpperCase();
  let out: { body: unknown };
  try {
    out = await call(f, `${openGymBase(url)}/api/pair/redeem`, { method: "POST", body: { code: clean }, timeoutMs: options.timeoutMs ?? 20_000 });
  } catch (err) {
    if (err instanceof OpenGymError && err.status === 400) {
      throw new OpenGymAuthError("openGym refused the pairing code: it is used, expired (codes last 5 minutes) or mistyped. Make a new one and save it again.", 400);
    }
    throw err;
  }
  const body = (out.body ?? {}) as { token?: unknown; user?: OpenGymUser };
  if (typeof body.token !== "string" || !TOKEN_CHARS.test(body.token)) throw new OpenGymError("openGym accepted the code but sent no token");
  return { token: body.token, user: body.user ?? null };
}

export class OpenGymClient {
  readonly base: string;
  private token: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenGymClientOptions) {
    this.base = openGymBase(options.url);
    const token = options.token.trim();
    if (!TOKEN_CHARS.test(token)) throw new OpenGymError("The openGym token has characters a token never has (a line break or space from copying it?)");
    this.token = token;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** The current token (renewed by `me()` once past half its lifetime). */
  currentToken(): string {
    return this.token;
  }

  /**
   * Who the token signs in as. Past half its lifetime openGym also sends a renewed token, which
   * this client uses from then on and returns as `renewed` for the caller to save.
   */
  async me(): Promise<{ user: OpenGymUser | null; renewed: string | null }> {
    const { body } = await call(this.fetch, `${this.base}/api/me`, { token: this.token, timeoutMs: this.timeoutMs });
    const b = (body ?? {}) as { user?: OpenGymUser; token?: unknown };
    const renewed = typeof b.token === "string" && TOKEN_CHARS.test(b.token) && b.token !== this.token ? b.token : null;
    if (renewed) this.token = renewed;
    return { user: b.user ?? null, renewed };
  }

  /** The revision of the stored state (cheap: no document). */
  async rev(): Promise<number> {
    const { body } = await call(this.fetch, `${this.base}/api/data/rev`, { token: this.token, timeoutMs: this.timeoutMs });
    const rev = (body as { rev?: unknown } | null)?.rev;
    return typeof rev === "number" ? rev : 0;
  }

  /** The whole state document and its revision; `state` is null before any device has synced. */
  async data(): Promise<{ state: Record<string, unknown> | null; rev: number }> {
    const { body } = await call(this.fetch, `${this.base}/api/data`, { token: this.token, timeoutMs: this.timeoutMs });
    const b = (body ?? {}) as { state?: unknown; rev?: unknown };
    const state = b.state && typeof b.state === "object" && !Array.isArray(b.state) ? (b.state as Record<string, unknown>) : null;
    return { state, rev: typeof b.rev === "number" ? b.rev : 0 };
  }
}
