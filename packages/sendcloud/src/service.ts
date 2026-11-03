import type { SendcloudAccount } from "./accounts";
import { type SendcloudParcel, SendcloudClient } from "./client";
import { type ShippingDigest, summariseParcels } from "./digest";

export interface ShippingServiceOptions {
  /** Parcels updated within this many days are read for the digest. Default 30. */
  lookbackDays?: number;
  /** In transit with no update for this many days counts as a problem. Default 5. */
  stalledDays?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Every configured Sendcloud account, with a client each. */
export class ShippingService {
  readonly clients: { account: SendcloudAccount; client: SendcloudClient }[];

  constructor(
    accounts: SendcloudAccount[],
    private readonly options: ShippingServiceOptions = {},
  ) {
    this.clients = accounts.map((account) => ({
      account,
      client: new SendcloudClient({ ...account, baseUrl: options.baseUrl, fetch: options.fetch, timeoutMs: options.timeoutMs }),
    }));
  }

  verticals(): string[] {
    return [...new Set(this.clients.map((c) => c.account.vertical))];
  }

  /** The business's recent parcels across its accounts; unreadable accounts come back as errors. */
  async recentParcels(vertical: string | null, since: Date): Promise<{ parcels: (SendcloudParcel & { account: string })[]; errors: string[] }> {
    const mine = this.clients.filter((c) => !vertical || c.account.vertical === vertical);
    const parcels: (SendcloudParcel & { account: string })[] = [];
    const errors: string[] = [];
    await Promise.all(
      mine.map(async ({ account, client }) => {
        try {
          for (const p of await client.listParcels({ updatedAfter: since })) parcels.push({ ...p, account: account.id });
        } catch (err) {
          errors.push(`${account.id}: ${(err as Error).message}`);
        }
      }),
    );
    return { parcels, errors };
  }

  /** The Shipping section of `vertical`'s digest for [start, end); null without accounts or news. */
  async digest(vertical: string, start: Date, end: Date, now = new Date()): Promise<ShippingDigest | null> {
    if (!this.clients.some((c) => c.account.vertical === vertical)) return null;
    const lookback = (this.options.lookbackDays ?? 30) * 86_400_000;
    const { parcels, errors } = await this.recentParcels(vertical, new Date(Math.min(start.getTime(), now.getTime() - lookback)));
    return summariseParcels(parcels, { start, end, now: now < end ? now : end, stalledDays: this.options.stalledDays }, errors);
  }
}
