import { randomBytes } from "node:crypto";
import { createGoogleTokenProvider, listCalendars } from "@cc/pa";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type AuthHttpOptions, clientIp, readSessionToken, requireApiAuth } from "../../accounts/http";
import type { AuthService } from "../../accounts/service";
import { CATALOG, KINDS, type KindDef, type OAuthProvider } from "../catalog";
import { validateFields } from "../effective";
import { actorOf, integrationBodyLimit } from "../routes";
import { IntegrationError, type IntegrationService } from "../service";
import type { IntegrationStore } from "../store";
import { google, youtube } from "./google";
import { instagram, threads } from "./meta";
import { DEFAULT_ENDPOINTS, type Endpoints, OAuthFlowError, type ProviderDef, type ProviderDeps } from "./provider";
import { reddit } from "./reddit";
import { x } from "./x";

export const PROVIDERS: Record<OAuthProvider, ProviderDef> = { google, youtube, instagram, threads, x, reddit };

/** Sign-ins expire after 10 minutes. */
const STATE_TTL_SECONDS = 600;
const ID = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
/** The admin token has no account; a flow it starts may finish in any browser (see the callback). */
const ADMIN_ACTOR = "admin token";

export interface OAuthDeps {
  service: IntegrationService;
  store: IntegrationStore;
  auth: AuthService;
  authHttp: AuthHttpOptions;
  /** PUBLIC_BASE_URL (no trailing slash); the redirect URIs are built from it. */
  publicBaseUrl: () => string | undefined;
  verticals: () => string[];
  fetch?: typeof fetch;
  /** Provider hosts, for tests. */
  urls?: Partial<Endpoints>;
  now?: () => Date;
}

const StartBody = z.object({
  id: z.string().max(63),
  vertical: z.string().max(100).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

interface StateData {
  kind: string;
  id: string;
  vertical?: string;
  data: Record<string, unknown>;
  redirectUri: string;
  keep: Record<string, string>;
}

export function redirectUriFor(publicBaseUrl: string, provider: OAuthProvider): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/oauth/${provider}/callback`;
}

function kindFor(provider: OAuthProvider): KindDef {
  return CATALOG.find((k) => k.oauth === provider)!;
}

/** "Add the X app keys first (Developer apps → X app: API key, API key secret)". */
function missingAppMessage(def: KindDef, missing: string[]): string {
  const app = KINDS.get(def.needsApp!)!;
  const labels = missing.map((k) => app.fields.find((f) => f.key === k)?.label ?? k);
  return `Add the ${app.label} keys first (Developer apps → ${app.label}: ${labels.join(", ")})`;
}

/** Replaces any known secret value in a message, and keeps it short enough for a URL. */
function safeMessage(err: unknown, secrets: string[]): string {
  let message = err instanceof OAuthFlowError || err instanceof IntegrationError ? err.message : `The sign-in failed: ${(err as Error)?.message ?? String(err)}`;
  for (const s of secrets) if (s && s.length >= 6) message = message.split(s).join("[redacted]");
  return message.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * The Accounts page's "Connect" buttons.
 * - `api` (mount at /api): POST /integrations/oauth/:provider/start and
 *   GET /integrations/google/:id/calendars, each behind the dashboard auth.
 * - `callbacks` (mount at /oauth, outside /api): GET /:provider/callback, where the provider
 *   sends the browser back. It finishes the sign-in, saves the entry and redirects to the
 *   Accounts page with ?connected=<kind>&id=<id> or ?oauthError=<message>.
 */
export function integrationOAuth(deps: OAuthDeps) {
  const providerDeps: ProviderDeps = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    urls: { ...DEFAULT_ENDPOINTS, ...deps.urls },
    now: deps.now ?? (() => new Date()),
  };
  const requireAuth = requireApiAuth(deps.auth, deps.authHttp);

  const api = new Hono();
  api.use("/integrations/*", integrationBodyLimit);
  api.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof IntegrationError) return c.json({ error: err.message, fields: err.fields }, err.status);
    if (err instanceof OAuthFlowError) return c.json({ error: err.message }, 502);
    throw err;
  });

  api.post("/integrations/oauth/:provider/start", requireAuth, async (c) => {
    const name = c.req.param("provider") as OAuthProvider;
    const provider = PROVIDERS[name];
    if (!provider) throw new IntegrationError(`unknown sign-in provider ${name}`, 404);
    const def = kindFor(name);
    const body = StartBody.parse(await c.req.json().catch(() => ({})));
    if (!ID.test(body.id)) throw new IntegrationError("Name must be letters, digits, - or _ (e.g. dms-instagram)", 400, ["id"]);

    const base = deps.publicBaseUrl();
    if (!base) throw new IntegrationError("Set PUBLIC_BASE_URL in Railway (the server's public https address) first: the sign-in comes back to it");

    const app = (await deps.service.appValues(def.needsApp!)) ?? {};
    const missing = provider.appKeys.filter((k) => !app[k]);
    if (missing.length) throw new IntegrationError(missingAppMessage(def, missing), 400, missing);

    // Extra fields to save with the account; the sign-in fills the fromOAuth and secret ones.
    const data = { ...body.data };
    if ("vertical" in data) throw new IntegrationError("Pass the business as `vertical`, not in data", 400, ["vertical"]);
    for (const key of Object.keys(data)) {
      const field = def.fields.find((f) => f.key === key);
      if (!field || field.type === "secret" || field.fromOAuth) throw new IntegrationError(`${def.label} sign-in can't set ${key}`, 400, [key]);
    }
    const problems = validateFields({ ...def, fields: def.fields.filter((f) => f.key in data) }, data, {});
    if (problems.length) throw new IntegrationError(problems.join("; "), 400, problems);

    // A business is needed before the round trip, not after it.
    const existing = await deps.service.resolved(def.kind, body.id);
    const verticalField = def.fields.find((f) => f.key === "vertical");
    const vertical = body.vertical ?? (existing?.data.vertical as string | undefined) ?? (verticalField?.default as string | undefined);
    if (verticalField?.required && !vertical) throw new IntegrationError("Pick which business this account speaks for", 400, ["vertical"]);
    if (vertical !== undefined && !deps.verticals().includes(vertical)) throw new IntegrationError(`Business "${vertical}" doesn't exist`, 400, ["vertical"]);

    const state = randomBytes(32).toString("base64url");
    const redirectUri = redirectUriFor(base, name);
    const started = await provider.start(providerDeps, { app, redirectUri, state });
    const stateData: StateData = { kind: def.kind, id: body.id, ...(body.vertical ? { vertical: body.vertical } : {}), data, redirectUri, keep: started.keep ?? {} };
    await deps.store.putState({ state: started.stateKey ?? state, provider: name, actor: actorOf(c), data: { ...stateData }, ttlSeconds: STATE_TTL_SECONDS });
    return c.json({ url: started.url });
  });

  /** The calendars a connected Google account can see, for the calendar picker. */
  api.get("/integrations/google/:id/calendars", requireAuth, async (c) => {
    const id = c.req.param("id");
    const entry = await deps.service.resolved("google", id);
    if (!entry) throw new IntegrationError(`Google account ${id} isn't set up`, 404);
    const refreshToken = entry.secrets.refreshToken;
    if (!refreshToken) throw new IntegrationError("Not connected yet: press Connect");
    const app = (await deps.service.appValues("google-app")) ?? {};
    if (!app.clientId || !app.clientSecret) throw new IntegrationError(missingAppMessage(KINDS.get("google")!, ["clientId", "clientSecret"].filter((k) => !app[k])));
    const tokens = createGoogleTokenProvider({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken, fetch: providerDeps.fetch, label: `Google account ${id}` });
    let accessToken: string;
    try {
      accessToken = await tokens.getAccessToken();
    } catch (err) {
      throw new OAuthFlowError(safeMessage(err, [refreshToken, app.clientSecret]));
    }
    return c.json({ calendars: await listCalendars(accessToken, providerDeps.fetch) });
  });

  /** The signed-in dashboard user's email from the session cookie, if any. */
  const sessionEmail = async (c: Context): Promise<string | null> => {
    const token = readSessionToken(c);
    if (!token) return null;
    const found = await deps.auth.authenticate(token, clientIp(c, deps.authHttp.trustedProxyHops));
    return found && found.user.role === "admin" ? found.user.email : null;
  };

  const callbacks = new Hono();
  callbacks.get("/:provider/callback", async (c) => {
    const name = c.req.param("provider") as OAuthProvider;
    const fail = (message: string) => {
      console.warn(`[oauth ${String(name).slice(0, 20)}] ${message}`);
      return c.redirect(`/#/accounts?oauthError=${encodeURIComponent(message)}`, 302);
    };
    const provider = PROVIDERS[name];
    if (!provider) return fail("Unknown sign-in provider");
    const query = new URL(c.req.url).searchParams;
    const key = provider.stateOf(query);
    if (!key) return fail("The sign-in came back without its state; start again from the Accounts page");
    const taken = await deps.store.takeState(key, name);
    if (!taken) return fail("This sign-in has expired or was already used; start again from the Accounts page");
    const st = taken.data as unknown as StateData;

    // Bound to whoever pressed Connect: the same signed-in user must finish it, so nobody can
    // slip their own account into Dave's server with a link. A flow started with the admin
    // token (automation) already had full access, so it may finish in any browser.
    if (taken.actor !== ADMIN_ACTOR) {
      const email = await sessionEmail(c);
      if (!email || email.toLowerCase() !== taken.actor.toLowerCase()) return fail("Sign in to Command Centre as the user who pressed Connect, then start again");
    }
    const refused = provider.errorOf(query);
    if (refused) return fail(refused);

    const def = KINDS.get(st.kind)!;
    let app: Record<string, string> = {};
    try {
      app = (await deps.service.appValues(def.needsApp!)) ?? {};
      const missing = provider.appKeys.filter((k) => !app[k]);
      if (missing.length) throw new IntegrationError(missingAppMessage(def, missing));
      const connected = await provider.finish(providerDeps, { app, redirectUri: st.redirectUri, query, keep: st.keep ?? {} });
      const data = { ...connected.data, ...st.data, ...(st.vertical ? { vertical: st.vertical } : {}) };
      await deps.service.save(st.kind, st.id, { data, secrets: connected.secrets }, taken.actor, {
        account: connected.account,
        ...(connected.expiresAt ? { expiresAt: connected.expiresAt } : {}),
      });
      return c.redirect(`/#/accounts?connected=${encodeURIComponent(st.kind)}&id=${encodeURIComponent(st.id)}`, 302);
    } catch (err) {
      return fail(safeMessage(err, [...Object.values(app), ...Object.values(st.keep ?? {}), query.get("code") ?? "", query.get("oauth_verifier") ?? ""]));
    }
  });

  return { api, callbacks };
}
