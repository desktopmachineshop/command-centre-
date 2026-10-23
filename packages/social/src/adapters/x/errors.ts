/**
 * Turns X API failures into messages Dave can act on, without ever leaking credentials.
 *
 * - 429: when the window resets, from `x-rate-limit-reset` (documented at
 *   https://docs.x.com/x-api/fundamentals/rate-limits) or the 24-hour cap headers
 *   `x-user-limit-24hour-reset` / `x-app-limit-24hour-reset`, which X sends on posting limits.
 * - 402: pay-per-use credits are used up.
 * - 403: usually app permissions or access level, so the message explains the usual causes.
 */

export class XApiError extends Error {
  readonly status: number;
  /** When posting is allowed again (429 only). */
  readonly resetAt?: Date;

  constructor(message: string, status: number, resetAt?: Date) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    this.resetAt = resetAt;
  }
}

/** Replace every secret (and its percent-encoded form) that occurs in `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("[redacted]");
  }
  // Belt and braces: an Authorization header echoed back by a proxy or error page.
  return out.replace(/OAuth\s+oauth_[^\n]*/gi, "OAuth [redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

interface XErrorBody {
  title?: string;
  detail?: string;
  type?: string;
  reason?: string;
  required_enrollment?: string;
  errors?: { message?: string; title?: string; detail?: string; code?: number }[];
}

function describeBody(body: XErrorBody | undefined, raw: string): string {
  if (!body) return raw.slice(0, 300).trim();
  const parts = [body.title, body.detail, body.reason && `reason: ${body.reason}`].filter(Boolean) as string[];
  for (const e of body.errors ?? []) {
    const m = e.detail ?? e.message ?? e.title;
    if (m && !parts.includes(m)) parts.push(m);
  }
  return parts.join(" - ") || raw.slice(0, 300).trim();
}

function resetFromHeaders(headers: Headers): Date | undefined {
  const candidates: number[] = [];
  const remaining = headers.get("x-rate-limit-remaining");
  const windowReset = Number(headers.get("x-rate-limit-reset"));
  // The 15-minute window is the cause only if it is exhausted (or X didn't say).
  if (windowReset > 0 && (remaining === null || Number(remaining) === 0)) candidates.push(windowReset);
  for (const scope of ["user", "app"]) {
    const reset = Number(headers.get(`x-${scope}-limit-24hour-reset`));
    const left = headers.get(`x-${scope}-limit-24hour-remaining`);
    if (reset > 0 && (left === null || Number(left) === 0)) candidates.push(reset);
  }
  if (!candidates.length && windowReset > 0) candidates.push(windowReset);
  return candidates.length ? new Date(Math.max(...candidates) * 1000) : undefined;
}

function formatWait(resetAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${minutes % 60} min`;
}

export async function toXApiError(
  res: Response,
  what: string,
  secrets: readonly string[],
  now: Date,
): Promise<XApiError> {
  const raw = await res.text().catch(() => "");
  let body: XErrorBody | undefined;
  try {
    body = raw ? (JSON.parse(raw) as XErrorBody) : undefined;
  } catch {
    body = undefined;
  }
  const detail = describeBody(body, raw);
  let message: string;
  let resetAt: Date | undefined;

  switch (res.status) {
    case 429: {
      resetAt = resetFromHeaders(res.headers);
      message = resetAt
        ? `X rate limit reached while trying to ${what}. It resets at ${resetAt.toISOString()} (in ${formatWait(resetAt, now)}). ` +
          `Legacy free-tier apps may only create 17 posts per 24 hours.`
        : `X rate limit reached while trying to ${what}, and X didn't say when it resets. Try again later.`;
      break;
    }
    case 402:
      message =
        `X refused to ${what}: the developer account has no API credits left (pay-per-use). ` +
        `Add credits in the X Developer Console, then retry.`;
      break;
    case 403:
      message =
        `X refused to ${what} (403 Forbidden). On the free tier this usually means one of: ` +
        `the app's User authentication settings are "Read" only (switch to "Read and write", then regenerate the access token and secret, ` +
        `because old tokens keep the old permission); the app isn't attached to a Project; the endpoint isn't included in the account's access level ` +
        `(free/legacy apps can post but can't read mentions or timelines); or X rejected the post itself (for example duplicate text).`;
      break;
    case 401:
      message =
        `X rejected the credentials while trying to ${what} (401). Check the API key and secret and the access token and secret; ` +
        `regenerating any of them in the developer portal invalidates the old value.`;
      break;
    default:
      message = `X API error ${res.status} while trying to ${what}.`;
  }
  if (detail) message += ` X said: ${detail}`;
  return new XApiError(redact(message, secrets), res.status, resetAt);
}
