import { buildAuthUrl, DEFAULT_AUTH_SCOPES, exchangeCode, pkcePair } from "@cc/pa";
import { youtubeOAuth } from "@cc/social";
import { codeOf, jsonOf, OAuthFlowError, oauth2Callback, type ProviderDef } from "./provider";

/** Lets a Gmail inbox send replies through the Gmail API (HTTPS) when the host blocks SMTP. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Google account (Calendar + Contacts + Drive): the web-redirect version of `pnpm --filter @cc/pa google:auth`.
 * PKCE, access_type=offline and prompt=consent (so a refresh token comes back every time),
 * scopes: openid email + the calendar scopes + contacts + drive.file. The email comes from the userinfo endpoint.
 */
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", ...DEFAULT_AUTH_SCOPES, GMAIL_SEND_SCOPE];

export const google: ProviderDef = {
  provider: "google",
  appKeys: ["clientId", "clientSecret"],
  ...oauth2Callback,
  async start(_deps, { app, redirectUri, state }) {
    const { verifier, challenge } = pkcePair();
    return { url: buildAuthUrl({ clientId: app.clientId!, redirectUri, challenge, state, scopes: GOOGLE_SIGNIN_SCOPES }), keep: { verifier } };
  },
  async finish(deps, { app, redirectUri, query, keep }) {
    const tokens = await exchangeCode(
      { clientId: app.clientId!, clientSecret: app.clientSecret!, code: codeOf(query), verifier: keep.verifier ?? "", redirectUri },
      deps.fetch,
    ).catch((err: Error) => {
      throw new OAuthFlowError(err.message.slice(0, 200));
    });
    const info = await jsonOf<{ email?: string }>(
      await deps.fetch(deps.urls.googleUserinfo, { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
      "Reading the Google account's email",
    );
    if (!info.email) throw new OAuthFlowError("Google didn't say which account signed in (the email scope wasn't granted)");
    const sendMail = tokens.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE);
    return { data: { email: info.email, sendMail }, secrets: { refreshToken: tokens.refreshToken }, account: info.email };
  },
};

/** YouTube: the web-redirect version of `pnpm --filter @cc/social youtube:auth` (same Google client). */
export const youtube: ProviderDef = {
  provider: "youtube",
  appKeys: ["clientId", "clientSecret"],
  ...oauth2Callback,
  async start(_deps, { app, redirectUri, state }) {
    const pkce = youtubeOAuth.createPkce();
    return { url: youtubeOAuth.buildAuthUrl({ clientId: app.clientId!, redirectUri, state, challenge: pkce.challenge }), keep: { verifier: pkce.verifier } };
  },
  async finish(deps, { app, redirectUri, query, keep }) {
    const tokens = await youtubeOAuth
      .exchangeCode(deps.fetch, { clientId: app.clientId!, clientSecret: app.clientSecret!, code: codeOf(query), verifier: keep.verifier ?? "", redirectUri })
      .catch((err: Error) => {
        throw new OAuthFlowError(err.message.slice(0, 200));
      });
    const missing = ["youtube.upload", "youtube.force-ssl"].filter((s) => !tokens.scope.some((g) => g.endsWith(`/auth/${s}`)));
    if (missing.length) throw new OAuthFlowError(`Google didn't grant ${missing.join(" and ")}; connect again and tick every box`);
    const channels = await youtubeOAuth.fetchOwnChannels(deps.fetch, tokens.accessToken).catch((err: Error) => {
      throw new OAuthFlowError(err.message.slice(0, 200));
    });
    const channel = channels[0];
    if (!channel) throw new OAuthFlowError("That Google account has no YouTube channel; sign in as the channel's account (or pick the Brand Account)");
    return {
      data: { channelId: channel.id, displayName: channel.title, ...(channel.customUrl ? { handle: channel.customUrl } : {}) },
      secrets: { refreshToken: tokens.refreshToken },
      account: channel.customUrl ?? channel.title,
    };
  },
};

/** Gmail inbox: full mail access (https://mail.google.com/) covers IMAP (XOAUTH2) and the Gmail API, so there's no app password. */
export const GMAIL_SCOPES = ["openid", "email", "https://mail.google.com/"];

export const gmail: ProviderDef = {
  provider: "gmail",
  appKeys: ["clientId", "clientSecret"],
  ...oauth2Callback,
  async start(_deps, { app, redirectUri, state }) {
    const { verifier, challenge } = pkcePair();
    return { url: buildAuthUrl({ clientId: app.clientId!, redirectUri, challenge, state, scopes: GMAIL_SCOPES }), keep: { verifier } };
  },
  async finish(deps, { app, redirectUri, query, keep }) {
    const tokens = await exchangeCode(
      { clientId: app.clientId!, clientSecret: app.clientSecret!, code: codeOf(query), verifier: keep.verifier ?? "", redirectUri },
      deps.fetch,
    ).catch((err: Error) => {
      throw new OAuthFlowError(err.message.slice(0, 200));
    });
    if (!tokens.scope.split(/\s+/).includes("https://mail.google.com/")) {
      throw new OAuthFlowError("Google didn't grant access to the mailbox; connect again and tick \"Read, compose, send and permanently delete\"");
    }
    const info = await jsonOf<{ email?: string }>(
      await deps.fetch(deps.urls.googleUserinfo, { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
      "Reading the Google account's email",
    );
    if (!info.email) throw new OAuthFlowError("Google didn't say which mailbox signed in");
    const address = info.email.toLowerCase();
    return { data: { address }, secrets: { refreshToken: tokens.refreshToken }, account: address };
  },
};
