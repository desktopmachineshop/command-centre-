/**
 * Sendcloud API v2 client (read-only): the parcels you've made labels for and where each one is.
 * Auth is HTTP Basic with the integration's public key as the user and its secret key as the
 * password (Sendcloud panel → Settings → Integrations → Sendcloud API).
 * Docs: https://sendcloud.dev/api/v2/parcels/retrieve-parcels
 */

export const SENDCLOUD_API = "https://panel.sendcloud.sc/api/v2";

export interface SendcloudClientOptions {
  publicKey: string;
  secretKey: string;
  /** Default https://panel.sendcloud.sc/api/v2 (tests point it at a fake). */
  baseUrl?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A parcel as the API returns it; only the fields Command Centre reads are typed. */
export interface SendcloudParcel {
  id: number;
  name?: string | null;
  company_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: { iso_2?: string; name?: string } | null;
  email?: string | null;
  order_number?: string | null;
  external_reference?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  status?: { id?: number; message?: string } | null;
  carrier?: { code?: string } | null;
  shipment?: { id?: number; name?: string } | null;
  /** "DD-MM-YYYY HH:MM:SS", Sendcloud's own (Amsterdam) time. */
  date_created?: string | null;
  date_updated?: string | null;
  date_announced?: string | null;
  is_return?: boolean | null;
  [key: string]: unknown;
}

export interface ListParcelsOptions {
  /** Parcels updated after this time. */
  updatedAfter?: Date;
  trackingNumber?: string;
  orderNumber?: string;
  /** Pages of up to 500 parcels to follow at most. Default 10. */
  maxPages?: number;
}

export class SendcloudError extends Error {
  override name = "SendcloudError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class SendcloudAuthError extends SendcloudError {
  override name = "SendcloudAuthError";
}

export class SendcloudClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SendcloudClientOptions) {
    this.base = (options.baseUrl ?? SENDCLOUD_API).replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The account the keys belong to (a cheap call for "Test connection"). */
  async user(): Promise<{ username: string | null; companyName: string | null }> {
    const body = (await this.get(`${this.base}/user`)) as { user?: { username?: string; company_name?: string } };
    return { username: body.user?.username ?? null, companyName: body.user?.company_name ?? null };
  }

  /** Parcels matching the filters, newest pages followed through `next` up to `maxPages`. */
  async listParcels(options: ListParcelsOptions = {}): Promise<SendcloudParcel[]> {
    const url = new URL(`${this.base}/parcels`);
    if (options.updatedAfter) url.searchParams.set("updated_after", options.updatedAfter.toISOString());
    if (options.trackingNumber) url.searchParams.set("tracking_number", options.trackingNumber);
    if (options.orderNumber) url.searchParams.set("order_number", options.orderNumber);
    const out: SendcloudParcel[] = [];
    let next: string | null = url.toString();
    for (let page = 0; next && page < (options.maxPages ?? 10); page++) {
      const body = (await this.get(next)) as { parcels?: SendcloudParcel[]; next?: unknown };
      out.push(...(Array.isArray(body.parcels) ? body.parcels : []));
      next = this.nextUrl(body.next);
    }
    return out;
  }

  /** `next` is a full URL in practice; a bare cursor is accepted too. Only URLs on this API are followed. */
  private nextUrl(next: unknown): string | null {
    if (typeof next === "number") next = String(next);
    if (typeof next !== "string" || !next) return null;
    if (/^https?:\/\//.test(next)) {
      const u = new URL(next);
      const b = new URL(this.base);
      return u.origin === b.origin && u.pathname.startsWith(b.pathname) ? u.toString() : null;
    }
    const u = new URL(`${this.base}/parcels`);
    u.searchParams.set("cursor", next);
    return u.toString();
  }

  private async get(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { authorization: this.auth, accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const e = err as Error;
      throw new SendcloudError(e.name === "TimeoutError" ? `Sendcloud timed out after ${Math.round(this.timeoutMs / 1000)}s` : `Sendcloud unreachable: ${e.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new SendcloudAuthError(`Sendcloud rejected the API keys (HTTP ${res.status})`, res.status);
    // No parcels matching a filter comes back as 404 on some accounts.
    if (res.status === 404 && url.includes("/parcels")) return { parcels: [], next: null };
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new SendcloudError(`Sendcloud answered HTTP ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new SendcloudError("Sendcloud sent a response that isn't JSON", res.status);
    }
  }
}
