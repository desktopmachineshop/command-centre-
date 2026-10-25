import { type AdapterContext, refreshInstagramToken, refreshThreadsToken } from "@cc/social";
import type { Notifier } from "../push";
import { KINDS } from "./catalog";
import { IntegrationError, type IntegrationService } from "./service";

const DAY_MS = 86_400_000;
/** Renew Meta tokens this close to expiry (they last 60 days; a refresh needs one at least a day old). */
export const REFRESH_WITHIN_DAYS = 15;
/** Warn Dave when a token still expires this soon after the attempt. */
export const ALERT_WITHIN_DAYS = 7;

const REFRESHERS: Record<string, (token: string, ctx: AdapterContext) => Promise<{ accessToken: string; expiresAt: string }>> = {
  instagram: refreshInstagramToken,
  threads: refreshThreadsToken,
};

export interface RefreshResult {
  refreshed: string[];
  failed: string[];
  alerted: string[];
}

/**
 * The daily job: renews Instagram and Threads long-lived tokens saved on the Accounts page that
 * expire within 15 days, saving the new token and expiry (actor "system"). When a renewal fails,
 * or a token still expires within 7 days, Dave gets an alert pointing at the Accounts page.
 */
export async function refreshExpiringTokens(options: {
  service: IntegrationService;
  notifier: Pick<Notifier, "notify">;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<RefreshResult> {
  const now = options.now ?? (() => new Date());
  const ctx: AdapterContext = {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now,
    log: { info: () => {}, error: (m) => console.error(`[integrations-refresh] ${m}`) },
  };
  const result: RefreshResult = { refreshed: [], failed: [], alerted: [] };

  for (const kind of Object.keys(REFRESHERS)) {
    const label = KINDS.get(kind)!.label;
    for (const entry of await options.service.entries(kind)) {
      const expiresAt = entry.meta.expiresAt ? Date.parse(entry.meta.expiresAt) : NaN;
      const token = entry.secrets.accessToken;
      if (!Number.isFinite(expiresAt) || !token || entry.unreadable) continue;
      if (expiresAt - now().getTime() > REFRESH_WITHIN_DAYS * DAY_MS) continue;

      const key = `${kind}/${entry.id}`;
      let error: string | undefined;
      let newExpiry = expiresAt;
      if (expiresAt > now().getTime()) {
        try {
          const t = await REFRESHERS[kind]!(token, ctx);
          await options.service.save(kind, entry.id, { secrets: { accessToken: t.accessToken } }, "system", { expiresAt: t.expiresAt, refreshError: undefined }, { ifUpdatedAt: entry.updatedAt });
          newExpiry = Date.parse(t.expiresAt);
          result.refreshed.push(key);
        } catch (err) {
          // Reconnected while this ran: the new sign-in wins; nothing to renew or report.
          if (err instanceof IntegrationError && err.status === 409) continue;
          error = (err as Error).message;
          result.failed.push(key);
          await options.service.patchMeta(kind, entry.id, { refreshError: error.slice(0, 300) }).catch(() => {});
        }
      } else {
        error = "it has already expired";
        result.failed.push(key);
      }

      const daysLeft = Math.floor((newExpiry - now().getTime()) / DAY_MS);
      if (error || daysLeft <= ALERT_WITHIN_DAYS) {
        const name = entry.meta.account ?? entry.id;
        const when = newExpiry <= now().getTime() ? "has expired" : daysLeft < 1 ? "expires today" : `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
        await options.notifier
          .notify({
            title: `${label} sign-in ${newExpiry <= now().getTime() ? "expired" : "expiring"}`,
            body: `${name} ${when}${error ? ` and couldn't be renewed (${error.slice(0, 160)})` : ""}. Reconnect it on the Accounts page.`,
            url: "/accounts",
            category: "alert",
            tag: `integration-expiry-${kind}-${entry.id}`,
            ...(typeof entry.data.vertical === "string" ? { vertical: entry.data.vertical } : {}),
          })
          .catch(() => {});
        result.alerted.push(key);
      }
    }
  }
  return result;
}
