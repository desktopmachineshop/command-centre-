import { codeOf, jsonOf, OAuthFlowError, oauth2Callback, postForm, type ProviderDef } from "./provider";

/**
 * Reddit: the code flow for a "web app" with duration=permanent, so a refresh token comes back.
 * Scopes cover what the adapter calls: identity (/api/v1/me), submit, read (/api/info),
 * privatemessages (inbox, compose), edit and history.
 */
export const REDDIT_SCOPES = ["identity", "submit", "read", "privatemessages", "edit", "history"];

const userAgentOf = (app: Record<string, string>) => app.userAgent ?? "web:command-centre:1.0";

export const reddit: ProviderDef = {
  provider: "reddit",
  appKeys: ["clientId", "clientSecret"],
  ...oauth2Callback,
  async start(deps, { app, redirectUri, state }) {
    const url = new URL(deps.urls.redditAuthorize);
    url.search = new URLSearchParams({
      client_id: app.clientId!,
      response_type: "code",
      state,
      redirect_uri: redirectUri,
      duration: "permanent",
      scope: REDDIT_SCOPES.join(" "),
    }).toString();
    return { url: url.toString() };
  },
  async finish(deps, { app, redirectUri, query }) {
    const tokens = await jsonOf<{ access_token?: string; refresh_token?: string; error?: string }>(
      await postForm(
        deps,
        deps.urls.redditToken,
        { grant_type: "authorization_code", code: codeOf(query), redirect_uri: redirectUri },
        { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "user-agent": userAgentOf(app) },
      ),
      "Reddit's code exchange",
    );
    // Reddit reports some failures with HTTP 200 and {"error": ...}.
    if (tokens.error) throw new OAuthFlowError(`Reddit's code exchange failed: ${String(tokens.error).slice(0, 60)}`);
    if (!tokens.access_token || !tokens.refresh_token) throw new OAuthFlowError("Reddit returned no refresh token");
    const me = await jsonOf<{ name?: string }>(
      await deps.fetch(`${deps.urls.redditApi}/api/v1/me`, { headers: { authorization: `bearer ${tokens.access_token}`, "user-agent": userAgentOf(app) } }),
      "Reading the Reddit account",
    );
    if (!me.name) throw new OAuthFlowError("Reddit didn't say which account signed in");
    return { data: { handle: `u/${me.name}` }, secrets: { refreshToken: tokens.refresh_token }, account: `u/${me.name}` };
  },
};
