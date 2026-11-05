import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from "node:crypto";

/**
 * Signing in with DMSid (https://id.desktopmachineshop.com), the one login for DMS products.
 * Command Centre is DMSid's OpenID Connect client `command-centre`: the authorization code flow
 * with PKCE S256, `state` and `nonce`; the ID token is checked against DMSid's published keys.
 *
 * Command Centre is Dave's private app. Only the addresses in DMSID_ALLOWED_EMAILS may sign in
 * this way, only when DMSid vouches for them (`email_verified: true`), and only to a Command
 * Centre user that already exists with that address. DMSid enforces the same list on its side
 * (the client is registered with `allowedEmails`), so it never shows the app to anyone else.
 */

/** Who may sign in with DMSid. Deliberately in code, not configuration: widening it is a reviewed change. */
export const DMSID_ALLOWED_EMAILS: readonly string[] = ["dave@desktopmachineshop.com"];

export function dmsidAllows(email: string): boolean {
  return DMSID_ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}

export interface DmsIdConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `<PUBLIC_BASE_URL>/api/auth/dmsid/callback`, registered at DMSid exactly. */
  redirectUri: string;
}

export interface DmsIdPerson {
  email: string;
  verified: boolean;
}

export class DmsIdError extends Error {}

type Jwks = { keys: (JsonWebKey & { kid?: string; use?: string })[] };

/** One round trip's secrets, kept server-side under its `state` until the callback. */
interface Flow {
  nonce: string;
  verifier: string;
  expiresAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 200;
const CLOCK_SKEW_S = 60;

const b64url = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class DmsIdSignIn {
  private readonly flows = new Map<string, Flow>();
  private keys: { jwks: Jwks; at: number } | null = null;

  constructor(
    readonly config: DmsIdConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts a sign-in: the URL to send the browser to, and the state to bind to it (a cookie). */
  start(): { url: string; state: string } {
    this.sweep();
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    const state = b64url();
    const flow: Flow = { nonce: b64url(), verifier: b64url(48), expiresAt: this.now() + FLOW_TTL_MS };
    this.flows.set(state, flow);
    const url = new URL(`${this.config.issuer}/oidc/authorize`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce: flow.nonce,
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.href, state };
  }

  /** Takes the flow for `state` (once). Null when unknown or expired. */
  take(state: string): Flow | null {
    const flow = this.flows.get(state);
    this.flows.delete(state);
    return flow && flow.expiresAt > this.now() ? flow : null;
  }

  /** Redeems the code and returns who signed in, from the verified ID token. Throws DmsIdError. */
  async redeem(code: string, flow: Flow): Promise<DmsIdPerson> {
    const basic = Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString("base64");
    const res = await this.fetchImpl(`${this.config.issuer}/oidc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: flow.verifier, redirect_uri: this.config.redirectUri }).toString(),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: unknown };
    if (!res.ok || typeof tokens.id_token !== "string") throw new DmsIdError(`DMSid token endpoint answered ${res.status}`);
    const claims = await this.verifyIdToken(tokens.id_token);
    if (claims.nonce !== flow.nonce) throw new DmsIdError("ID token nonce mismatch");
    if (typeof claims.email !== "string" || !claims.email) throw new DmsIdError("ID token carries no email");
    return { email: claims.email.toLowerCase(), verified: claims.email_verified === true };
  }

  private async verifyIdToken(token: string): Promise<Record<string, unknown>> {
    const [h, p, s, ...rest] = token.split(".");
    if (h === undefined || p === undefined || s === undefined || rest.length) throw new DmsIdError("ID token is not a JWT");
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      throw new DmsIdError("ID token is malformed");
    }
    if (header.alg !== "RS256") throw new DmsIdError("ID token has an unexpected algorithm");
    let key = (await this.jwks(false)).keys.find((k) => k.kid === header.kid);
    if (!key) key = (await this.jwks(true)).keys.find((k) => k.kid === header.kid); // DMSid rotated its keys
    if (!key) throw new DmsIdError("ID token is signed with an unknown key");
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
    if (!ok) throw new DmsIdError("ID token signature is bad");

    const t = Math.floor(this.now() / 1000);
    if (claims.iss !== this.config.issuer) throw new DmsIdError("ID token is from another issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.clientId)) throw new DmsIdError("ID token is for another app");
    if (aud.length > 1 && claims.azp !== this.config.clientId) throw new DmsIdError("ID token is for another app");
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < t) throw new DmsIdError("ID token has expired");
    if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > t) throw new DmsIdError("ID token is from the future");
    return claims;
  }

  private async jwks(refresh: boolean): Promise<Jwks> {
    if (!refresh && this.keys && this.now() - this.keys.at < 3_600_000) return this.keys.jwks;
    // A forced refresh at most once a minute, so a token with a made-up kid can't hammer DMSid.
    if (refresh && this.keys && this.now() - this.keys.at < 60_000) return this.keys.jwks;
    const res = await this.fetchImpl(`${this.config.issuer}/oidc/jwks`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!res.ok) throw new DmsIdError(`DMSid keys answered ${res.status}`);
    const jwks = (await res.json()) as Jwks;
    if (!Array.isArray(jwks?.keys)) throw new DmsIdError("DMSid keys are malformed");
    this.keys = { jwks, at: this.now() };
    return jwks;
  }

  private sweep() {
    const t = this.now();
    for (const [state, flow] of this.flows) if (flow.expiresAt <= t) this.flows.delete(state);
  }
}
