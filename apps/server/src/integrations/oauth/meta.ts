import { codeOf, expiresAtOf, jsonOf, OAuthFlowError, oauth2Callback, postForm, type ProviderDef } from "./provider";

/**
 * Instagram API with Instagram Login (Business Login for Instagram): the authorize page on
 * instagram.com, a short-lived token from api.instagram.com, swapped for a 60-day token
 * (ig_exchange_token) on graph.instagram.com, then `/me` for the professional account's
 * user_id and username. The adapter (packages/social) talks to the same Graph host.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
];

export const instagram: ProviderDef = {
  provider: "instagram",
  appKeys: ["appId", "appSecret"],
  ...oauth2Callback,
  async start(deps, { app, redirectUri, state }) {
    const url = new URL(deps.urls.instagramAuthorize);
    url.search = new URLSearchParams({
      client_id: app.appId!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
    }).toString();
    return { url: url.toString() };
  },
  async finish(deps, { app, redirectUri, query }) {
    // Instagram appends "#_" to the code in some browsers.
    const code = codeOf(query).replace(/#_$/, "");
    const short = await jsonOf<{ access_token?: string; user_id?: number | string; data?: { access_token?: string; user_id?: number | string }[] }>(
      await postForm(deps, deps.urls.instagramToken, {
        client_id: app.appId!,
        client_secret: app.appSecret!,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
      "Instagram's code exchange",
    );
    const first = short.data?.[0] ?? short;
    if (!first.access_token) throw new OAuthFlowError("Instagram returned no access token");

    const longUrl = new URL(`${deps.urls.instagramGraph}/access_token`);
    longUrl.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: app.appSecret!, access_token: first.access_token }).toString();
    const long = await jsonOf<{ access_token?: string; expires_in?: number }>(await deps.fetch(longUrl), "Instagram's long-lived token exchange");
    if (!long.access_token) throw new OAuthFlowError("Instagram returned no long-lived token");

    const meUrl = new URL(`${deps.urls.instagramApi}/me`);
    meUrl.search = new URLSearchParams({ fields: "user_id,username", access_token: long.access_token }).toString();
    const me = await jsonOf<{ user_id?: number | string; id?: string; username?: string }>(await deps.fetch(meUrl), "Reading the Instagram account");
    const igUserId = String(me.user_id ?? first.user_id ?? "");
    if (!/^\d+$/.test(igUserId)) throw new OAuthFlowError("Instagram didn't return the account's user id (is it a professional account?)");
    return {
      data: { igUserId, ...(me.username ? { handle: `@${me.username}` } : {}) },
      secrets: { accessToken: long.access_token },
      account: me.username ? `@${me.username}` : igUserId,
      expiresAt: expiresAtOf(deps, long.expires_in),
    };
  },
};

/**
 * Threads: authorize on threads.net, the code exchange and the 60-day token (th_exchange_token)
 * on graph.threads.net, then `/me` on the adapter's Graph base for the user id and username.
 */
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies", "threads_manage_mentions"];

export const threads: ProviderDef = {
  provider: "threads",
  appKeys: ["appId", "appSecret"],
  ...oauth2Callback,
  async start(deps, { app, redirectUri, state }) {
    const url = new URL(deps.urls.threadsAuthorize);
    url.search = new URLSearchParams({
      client_id: app.appId!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: THREADS_SCOPES.join(","),
      state,
    }).toString();
    return { url: url.toString() };
  },
  async finish(deps, { app, redirectUri, query }) {
    const code = codeOf(query).replace(/#_$/, "");
    const short = await jsonOf<{ access_token?: string; user_id?: number | string }>(
      await postForm(deps, `${deps.urls.threadsGraph}/oauth/access_token`, {
        client_id: app.appId!,
        client_secret: app.appSecret!,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
      "Threads' code exchange",
    );
    if (!short.access_token) throw new OAuthFlowError("Threads returned no access token");

    const longUrl = new URL(`${deps.urls.threadsGraph}/access_token`);
    longUrl.search = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: app.appSecret!, access_token: short.access_token }).toString();
    const long = await jsonOf<{ access_token?: string; expires_in?: number }>(await deps.fetch(longUrl), "Threads' long-lived token exchange");
    if (!long.access_token) throw new OAuthFlowError("Threads returned no long-lived token");

    const meUrl = new URL(`${deps.urls.threadsApi}/me`);
    meUrl.search = new URLSearchParams({ fields: "id,username", access_token: long.access_token }).toString();
    const me = await jsonOf<{ id?: string; username?: string }>(await deps.fetch(meUrl), "Reading the Threads account");
    const threadsUserId = String(me.id ?? short.user_id ?? "");
    if (!/^\d+$/.test(threadsUserId)) throw new OAuthFlowError("Threads didn't return the account's user id");
    return {
      data: { threadsUserId, ...(me.username ? { handle: `@${me.username}` } : {}) },
      secrets: { accessToken: long.access_token },
      account: me.username ? `@${me.username}` : threadsUserId,
      expiresAt: expiresAtOf(deps, long.expires_in),
    };
  },
};
