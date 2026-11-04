import type { CalendarAccount } from "../calendar/accounts";
import { PLANNING_VERTICAL } from "../calendar/service";
import { type Contact, type ContactChange, type ContactInput, ContactsError, type ContactsProvider, GoogleContactsProvider } from "./google";

export interface ContactsServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests inject providers directly. */
  providers?: ContactsProvider[];
}

/**
 * Contacts on the same Google accounts as the calendar (one sign-in covers both),
 * scoped like the calendar: a vertical uses its own accounts, and the personal
 * vertical (and Dave) can search every account. Writes go to the vertical's own
 * account, or the one named.
 */
export class ContactsService {
  private readonly providers = new Map<string, ContactsProvider>();
  private readonly accountVertical = new Map<string, string>();

  constructor(accounts: CalendarAccount[], options: ContactsServiceOptions = {}) {
    const injected = new Map((options.providers ?? []).map((p) => [p.accountId, p]));
    for (const a of accounts) {
      this.providers.set(a.id, injected.get(a.id) ?? new GoogleContactsProvider({ accountId: a.id, credentials: a.credentials, fetch: options.fetch, now: options.now }));
      this.accountVertical.set(a.id, a.vertical);
    }
  }

  get configured(): boolean {
    return this.providers.size > 0;
  }

  private readable(vertical: string | undefined): string[] {
    return [...this.accountVertical].filter(([, v]) => vertical === undefined || vertical === PLANNING_VERTICAL || v === vertical).map(([id]) => id);
  }

  private writable(vertical: string | undefined): string[] {
    return [...this.accountVertical].filter(([, v]) => vertical === undefined || v === vertical).map(([id]) => id);
  }

  /** The account a read of a known contact (or a write) uses: the one named, else the first that fits. */
  private pick(ids: string[], accountId: string | undefined, vertical: string | undefined): ContactsProvider {
    const id = accountId ? ids.find((i) => i === accountId) : ids[0];
    if (!id) {
      throw new ContactsError(
        accountId
          ? `No Google account "${accountId}" for ${vertical ?? "Dave"}. Accounts: ${ids.join(", ") || "none"}`
          : `${vertical ? `The ${vertical} vertical has` : "There is"} no Google account connected (Accounts page → Google account)`,
      );
    }
    return this.providers.get(id)!;
  }

  /** Contacts matching a name, number, email or company across the readable accounts; failing accounts are reported, not fatal. */
  async search(query: string, options: { vertical?: string; limit?: number } = {}): Promise<{ contacts: Contact[]; errors: string[] }> {
    const errors: string[] = [];
    const results = await Promise.all(
      this.readable(options.vertical).map((id) =>
        this.providers
          .get(id)!
          .search(query, options.limit ?? 10)
          .catch((err) => {
            errors.push((err as Error).message);
            return [] as Contact[];
          }),
      ),
    );
    return { contacts: results.flat().slice(0, options.limit ?? 10), errors };
  }

  async get(id: string, options: { vertical?: string; accountId?: string } = {}): Promise<Contact> {
    return this.pick(this.readable(options.vertical), options.accountId, options.vertical).get(id);
  }

  async create(input: ContactInput, options: { vertical?: string; accountId?: string } = {}): Promise<Contact> {
    return this.pick(this.writable(options.vertical), options.accountId, options.vertical).create(input);
  }

  async update(id: string, change: ContactChange, options: { vertical?: string; accountId?: string } = {}): Promise<Contact> {
    return this.pick(this.writable(options.vertical), options.accountId, options.vertical).update(id, change);
  }
}

/** One line for agents: "Steve Smith (Smith Motors) · mobile 07700 900123 · steve@… {contact: people/c1, account: google}". */
export function describeContact(c: Contact, options: { ids?: boolean } = {}): string {
  const parts = [
    `${c.name}${c.company ? ` (${c.company})` : ""}`,
    ...c.phones.map((p) => `${p.type ? `${p.type} ` : ""}${p.value}`),
    ...c.emails.map((e) => e.value),
  ];
  const notes = c.notes ? ` · notes: ${c.notes.replace(/\s+/g, " ").slice(0, 120)}` : "";
  return `${parts.join(" · ")}${notes}${options.ids !== false ? ` {contact: ${c.id}, account: ${c.accountId}}` : ""}`;
}
