import { MICROSOFT_MAIL_SCOPES } from "@cc/email";
import { pkcePair } from "@cc/pa";
import { codeOf, jsonOf, OAuthFlowError, oauth2Callback, postForm, type ProviderDef } from "./provider";

/**
 * Microsoft (Outlook.com, Hotmail, Live, Microsoft 365) for email: the authorization-code flow
 * with PKCE on the v2.0 endpoint. The scopes are IMAP and SMTP on outlook.office.com plus
 * offline_access (refresh token) and openid email (who signed in, from the id token).
 */
const tenantOf = (app: Record<string, string>) => encodeURIComponent(app.tenant || "common");

/** The id token's claims. It comes straight from Microsoft's token endpoint over TLS, so it isn't re-verified. */
function claimsOf(idToken: string | undefined): { email?: string; preferred_username?: string } {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; preferred_username?: string };
  } catch {
    return {};
  }
}

export const microsoft: ProviderDef = {
  provider: "microsoft",
  appKeys: ["clientId", "clientSecret"],
  ...oauth2Callback,
  async start(deps, { app, redirectUri, state }) {
    const { verifier, challenge } = pkcePair();
    const url = new URL(`${deps.urls.microsoftLogin}/${tenantOf(app)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: app.clientId!,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: MICROSOFT_MAIL_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), keep: { verifier } };
  },
  async finish(deps, { app, redirectUri, query, keep }) {
    const tokens = await jsonOf<{ access_token?: string; refresh_token?: string; id_token?: string; scope?: string }>(
      await postForm(deps, `${deps.urls.microsoftLogin}/${tenantOf(app)}/oauth2/v2.0/token`, {
        client_id: app.clientId!,
        client_secret: app.clientSecret!,
        grant_type: "authorization_code",
        code: codeOf(query),
        redirect_uri: redirectUri,
        code_verifier: keep.verifier ?? "",
        scope: MICROSOFT_MAIL_SCOPES.join(" "),
      }),
      "Microsoft's code exchange",
    );
    if (!tokens.refresh_token) throw new OAuthFlowError("Microsoft returned no refresh token (offline_access wasn't granted)");
    const granted = (tokens.scope ?? "").toLowerCase();
    const missing = ["imap.accessasuser.all", "smtp.send"].filter((s) => granted && !granted.includes(s));
    if (missing.length) throw new OAuthFlowError(`Microsoft didn't grant ${missing.join(" and ")}; add them under the app's API permissions and connect again`);
    const claims = claimsOf(tokens.id_token);
    const address = claims.email ?? claims.preferred_username;
    if (!address || !address.includes("@")) throw new OAuthFlowError("Microsoft didn't say which mailbox signed in");
    return { data: { address: address.toLowerCase() }, secrets: { refreshToken: tokens.refresh_token }, account: address.toLowerCase() };
  },
};
