import { xOAuth1 } from "@cc/social";
import { OAuthFlowError, type ProviderDeps, type ProviderDef } from "./provider";

/**
 * X: OAuth 1.0a 3-legged sign-in ("Sign in with X"), signed with the adapter's oauth1.ts.
 * request_token (with oauth_callback) → the authorize page → the callback brings oauth_token and
 * oauth_verifier → access_token. The state row is keyed by the request token, and keeps its secret.
 */
async function signedPost(deps: ProviderDeps, url: string, creds: xOAuth1.OAuth1Credentials, extra: Record<string, string>, step: string): Promise<URLSearchParams> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { authorization: xOAuth1.authorizationHeader({ method: "POST", url }, creds, { extra }) },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // X answers with JSON errors or a plain message; neither carries our secrets.
    let why = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { errors?: { message?: string }[] };
      if (body.errors?.[0]?.message) why = body.errors[0].message;
    } catch {
      // not JSON
    }
    throw new OAuthFlowError(`${step} failed: ${why.slice(0, 120)}`);
  }
  return new URLSearchParams(text);
}

export const x: ProviderDef = {
  provider: "x",
  appKeys: ["apiKey", "apiSecret"],
  stateOf: (q) => q.get("oauth_token") ?? q.get("denied") ?? undefined,
  errorOf: (q) => (q.get("denied") ? "Access was not granted" : undefined),
  async start(deps, { app, redirectUri }) {
    const body = await signedPost(
      deps,
      `${deps.urls.xApi}/oauth/request_token`,
      { consumerKey: app.apiKey!, consumerSecret: app.apiSecret!, token: "", tokenSecret: "" },
      { oauth_callback: redirectUri },
      "X's request token",
    );
    const token = body.get("oauth_token");
    const secret = body.get("oauth_token_secret");
    if (!token || !secret || body.get("oauth_callback_confirmed") !== "true") throw new OAuthFlowError("X didn't accept the callback URL; add it to the X app's callback URLs");
    return { url: `${deps.urls.xApi}/oauth/authorize?oauth_token=${encodeURIComponent(token)}`, keep: { tokenSecret: secret }, stateKey: token };
  },
  async finish(deps, { app, query, keep }) {
    const token = query.get("oauth_token");
    const verifier = query.get("oauth_verifier");
    if (!token || !verifier) throw new OAuthFlowError("X sent no verifier");
    const body = await signedPost(
      deps,
      `${deps.urls.xApi}/oauth/access_token`,
      { consumerKey: app.apiKey!, consumerSecret: app.apiSecret!, token, tokenSecret: keep.tokenSecret ?? "" },
      { oauth_verifier: verifier },
      "X's access token",
    );
    const accessToken = body.get("oauth_token");
    const accessTokenSecret = body.get("oauth_token_secret");
    const screenName = body.get("screen_name");
    if (!accessToken || !accessTokenSecret) throw new OAuthFlowError("X returned no access token");
    return {
      data: screenName ? { handle: `@${screenName}` } : {},
      secrets: { accessToken, accessTokenSecret },
      account: screenName ? `@${screenName}` : (body.get("user_id") ?? "X account"),
    };
  },
};
