import { createPublicKey, type JsonWebKey, verify } from "node:crypto";

/**
 * Verifies a GitHub Actions OIDC token (the `id-token: write` permission). The Desktop
 * workflow uses one to upload the installer it built, so the server needs no shared secret:
 * GitHub vouches for which repository and workflow file the request comes from.
 */

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** The audience the Desktop workflow asks for. */
export const DESKTOP_UPLOAD_AUDIENCE = "command-centre-desktop";

export interface GithubOidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  repository: string;
  /** e.g. `owner/repo/.github/workflows/desktop.yml@refs/heads/main` */
  workflow_ref: string;
  ref: string;
  sha: string;
  event_name: string;
}

export class OidcError extends Error {}

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };

export function createGithubOidcVerifier(options: { fetch?: typeof fetch; now?: () => number; jwksTtlMs?: number } = {}) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cache: { jwks: Jwks; at: number } | null = null;

  const jwks = async (refresh: boolean): Promise<Jwks> => {
    if (!refresh && cache && now() - cache.at < (options.jwksTtlMs ?? 3_600_000)) return cache.jwks;
    const res = await doFetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);
    if (!res.ok) throw new OidcError(`Couldn't fetch GitHub's signing keys (HTTP ${res.status})`);
    cache = { jwks: (await res.json()) as Jwks, at: now() };
    return cache.jwks;
  };

  /**
   * Checks the signature, issuer, audience and lifetime, then that it comes from `repository`'s
   * `workflowPath` (e.g. `.github/workflows/desktop.yml`). Throws OidcError otherwise.
   */
  return async function verifyGithubOidc(token: string, expected: { audience: string; repository: string; workflowPath: string }): Promise<GithubOidcClaims> {
    const [h, p, s, ...rest] = token.split(".");
    if (h === undefined || p === undefined || s === undefined || rest.length) throw new OidcError("Not a JWT");
    let header: { alg?: string; kid?: string };
    let claims: GithubOidcClaims;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      throw new OidcError("Malformed JWT");
    }
    if (header.alg !== "RS256") throw new OidcError("Unexpected JWT algorithm");

    let key = (await jwks(false)).keys.find((k) => k.kid === header.kid);
    if (!key) key = (await jwks(true)).keys.find((k) => k.kid === header.kid); // GitHub rotated its keys
    if (!key) throw new OidcError("Unknown signing key");
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
    if (!ok) throw new OidcError("Bad signature");

    const t = Math.floor(now() / 1000);
    const skew = 60;
    if (claims.iss !== GITHUB_OIDC_ISSUER) throw new OidcError("Wrong issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(expected.audience)) throw new OidcError("Wrong audience");
    if (typeof claims.exp !== "number" || claims.exp + skew < t) throw new OidcError("Token expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > t) throw new OidcError("Token not valid yet");
    if (claims.repository?.toLowerCase() !== expected.repository.toLowerCase()) throw new OidcError(`Token is for ${claims.repository}, not ${expected.repository}`);
    const workflow = `${expected.repository}/${expected.workflowPath}@`.toLowerCase();
    if (!claims.workflow_ref?.toLowerCase().startsWith(workflow)) throw new OidcError("Token is from a different workflow");
    if (claims.event_name === "pull_request" || claims.event_name === "pull_request_target") throw new OidcError("Pull request builds can't publish the installer");
    return claims;
  };
}

export type GithubOidcVerifier = ReturnType<typeof createGithubOidcVerifier>;
