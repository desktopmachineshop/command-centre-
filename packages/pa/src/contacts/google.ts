import { createGoogleTokenProvider, GoogleAuthError, type GoogleOAuthCredentials, type GoogleTokenProvider, REAUTH_HINT } from "../google/oauth";

/**
 * Google Contacts through the People API v1 over plain fetch, with the same
 * refresh token as the calendar (one Google sign-in covers both).
 * - Search: people.searchContacts, after the one empty "warm-up" query Google asks for
 *   (https://developers.google.com/people/api/rest/v1/people/searchContacts).
 *   It matches names, nicknames, emails, phone numbers and organisations.
 * - Read: people.get. Create: people.createContact. Change: people.updateContact,
 *   which needs the contact's current etag and replaces each field it is given.
 */

export const PEOPLE_API = "https://people.googleapis.com/v1";
/** Read and change the account's contacts. https://developers.google.com/people/api/rest/v1/people/createContact#authorization-scopes */
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

/** The fields the app reads and writes. */
const PERSON_FIELDS = "names,phoneNumbers,emailAddresses,organizations,biographies";

export interface ContactValue {
  value: string;
  /** Google's label: mobile, home, work, other… (null when unlabelled). */
  type: string | null;
}

export interface Contact {
  accountId: string;
  /** Google's resource name, e.g. "people/c12345". */
  id: string;
  name: string;
  phones: ContactValue[];
  emails: ContactValue[];
  company: string | null;
  notes: string | null;
}

export interface ContactInput {
  /** Full name; the first word becomes the given name, the rest the family name. */
  name?: string;
  phones?: { value: string; type?: string | null }[];
  emails?: { value: string; type?: string | null }[];
  company?: string | null;
  notes?: string | null;
}

/** A change: fields given replace what is there; `addPhones`/`addEmails` keep the existing ones. Empty company/notes clear them. */
export interface ContactChange extends ContactInput {
  addPhones?: { value: string; type?: string | null }[];
  addEmails?: { value: string; type?: string | null }[];
}

export interface ContactsProvider {
  readonly accountId: string;
  search(query: string, limit: number): Promise<Contact[]>;
  get(id: string): Promise<Contact>;
  create(input: ContactInput): Promise<Contact>;
  update(id: string, change: ContactChange): Promise<Contact>;
}

export class ContactsError extends Error {}

type GooglePerson = {
  resourceName: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string; metadata?: { primary?: boolean } }[];
  phoneNumbers?: { value?: string; type?: string; metadata?: { primary?: boolean } }[];
  emailAddresses?: { value?: string; type?: string }[];
  organizations?: { name?: string }[];
  biographies?: { value?: string; contentType?: string }[];
};

export interface GoogleContactsOptions {
  accountId: string;
  credentials: GoogleOAuthCredentials;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GoogleContactsProvider implements ContactsProvider {
  readonly accountId: string;
  private readonly fetch: typeof fetch;
  private readonly tokens: GoogleTokenProvider;
  private warmed = false;

  constructor(options: GoogleContactsOptions) {
    this.accountId = options.accountId;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.tokens = createGoogleTokenProvider({ ...options.credentials, fetch: this.fetch, now: options.now, label: `contacts on Google account "${options.accountId}"` });
  }

  /** One API call; a 401 drops the cached token and retries once. Errors say what Dave can do about them. */
  private async api<T>(method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${PEOPLE_API}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.tokens.getAccessToken();
      } catch (err) {
        throw new ContactsError((err as Error).message);
      }
      const res = await this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw peopleError(res.status, json?.error, this.accountId);
      return json as T;
    }
  }

  async search(query: string, limit: number): Promise<Contact[]> {
    // Google: send an empty query first to warm its cache, or the first searches can come back empty.
    if (!this.warmed) {
      await this.api("GET", "people:searchContacts", { query: { query: "", readMask: "names" } });
      this.warmed = true;
    }
    const res = await this.api<{ results?: { person: GooglePerson }[] }>("GET", "people:searchContacts", {
      query: { query, readMask: PERSON_FIELDS, pageSize: String(Math.min(Math.max(limit, 1), 30)) },
    });
    return (res.results ?? []).map((r) => this.toContact(r.person));
  }

  async get(id: string): Promise<Contact> {
    return this.toContact(await this.person(id));
  }

  private person(id: string): Promise<GooglePerson> {
    return this.api<GooglePerson>("GET", resourcePath(id), { query: { personFields: PERSON_FIELDS } });
  }

  async create(input: ContactInput): Promise<Contact> {
    if (!input.name?.trim()) throw new ContactsError("a new contact needs a name");
    const person = await this.api<GooglePerson>("POST", "people:createContact", { query: { personFields: PERSON_FIELDS }, body: toPersonBody(input) });
    return this.toContact(person);
  }

  async update(id: string, change: ContactChange): Promise<Contact> {
    // updateContact needs the current etag; if someone changes the contact in between, read it again once.
    for (let attempt = 0; ; attempt++) {
      const current = await this.person(id);
      const { body, fields } = toUpdateBody(current, change);
      if (!fields.length) return this.toContact(current);
      try {
        const person = await this.api<GooglePerson>("PATCH", `${resourcePath(id)}:updateContact`, {
          query: { updatePersonFields: fields.join(","), personFields: PERSON_FIELDS },
          body: { ...body, etag: current.etag },
        });
        return this.toContact(person);
      } catch (err) {
        if (attempt === 0 && err instanceof PeopleApiError && err.status === 400 && /etag/i.test(err.message)) continue;
        throw err;
      }
    }
  }

  private toContact(p: GooglePerson): Contact {
    const name = p.names?.find((n) => n.metadata?.primary) ?? p.names?.[0];
    const value = <T extends { value?: string; type?: string }>(list: T[] | undefined): ContactValue[] =>
      (list ?? []).filter((x) => x.value?.trim()).map((x) => ({ value: x.value!.trim(), type: x.type || null }));
    return {
      accountId: this.accountId,
      id: p.resourceName,
      name: name?.displayName || [name?.givenName, name?.familyName].filter(Boolean).join(" ") || "(no name)",
      phones: value(p.phoneNumbers),
      emails: value(p.emailAddresses),
      company: p.organizations?.find((o) => o.name)?.name ?? null,
      notes: p.biographies?.find((b) => b.value)?.value ?? null,
    };
  }
}

export class PeopleApiError extends ContactsError {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** Google's error as something Dave can act on: reconnect for a missing scope, turn on the API, or the plain message. */
function peopleError(status: number, err: any, accountId: string): ContactsError {
  const reasons: string[] = [
    ...((err?.details ?? []) as { reason?: string }[]).map((d) => d.reason ?? ""),
    ...((err?.errors ?? []) as { reason?: string }[]).map((e) => e.reason ?? ""),
  ].filter(Boolean);
  const reason = reasons[0] ?? err?.status ?? null;
  const base = `Google Contacts (account ${accountId}) said ${status} ${err?.message ?? ""}`.trim();
  if (status === 401) return new PeopleApiError(status, reason, `${base}. ${REAUTH_HINT}`);
  if (status === 403 && reasons.some((r) => /SCOPE_INSUFFICIENT|insufficientPermissions/i.test(r))) {
    return new PeopleApiError(
      status,
      reason,
      `The Google account "${accountId}" was connected before the app could use contacts. Reconnect it on the Accounts page (Google account → Connect) and allow access to contacts.`,
    );
  }
  if (status === 403 && reasons.some((r) => /SERVICE_DISABLED|accessNotConfigured/i.test(r))) {
    return new PeopleApiError(status, reason, "The People API is turned off for the app's Google Cloud project. Turn it on (APIs & Services → Library → People API), wait a minute and try again.");
  }
  if (status === 404) return new PeopleApiError(status, reason, `No contact with that id on Google account "${accountId}" (it may have been deleted).`);
  return new PeopleApiError(status, reason, base);
}

/** "people/c123" (or just "c123") as an API path. Anything else is refused, so an id can't reach another endpoint. */
function resourcePath(id: string): string {
  const m = /^(?:people\/)?(c\d+|\d+)$/.exec(id.trim());
  if (!m) throw new ContactsError(`"${id}" is not a contact id (expected people/c… from a contact search)`);
  return `people/${m[1]}`;
}

function splitName(name: string): { givenName: string; familyName?: string } {
  const [given, ...rest] = name.trim().split(/\s+/);
  return rest.length ? { givenName: given!, familyName: rest.join(" ") } : { givenName: given! };
}

const values = (list: { value: string; type?: string | null }[]) =>
  list.filter((x) => x.value.trim()).map((x) => ({ value: x.value.trim(), ...(x.type ? { type: x.type } : {}) }));

function toPersonBody(input: ContactInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name?.trim()) body.names = [splitName(input.name)];
  if (input.phones) body.phoneNumbers = values(input.phones);
  if (input.emails) body.emailAddresses = values(input.emails);
  if (input.company !== undefined) body.organizations = input.company?.trim() ? [{ name: input.company.trim() }] : [];
  if (input.notes !== undefined) body.biographies = input.notes?.trim() ? [{ value: input.notes.trim(), contentType: "TEXT_PLAIN" }] : [];
  return body;
}

/** The PATCH body and its updatePersonFields. Adds keep what is there, so only new numbers and addresses are appended. */
function toUpdateBody(current: GooglePerson, change: ContactChange): { body: Record<string, unknown>; fields: string[] } {
  const body = toPersonBody(change);
  const merge = (existing: { value?: string; type?: string }[] | undefined, base: unknown, add: { value: string; type?: string | null }[]) => {
    // The existing entries as plain {value, type}, without Google's read-only metadata.
    const list = (base as { value: string; type?: string }[] | undefined) ?? (existing ?? []).filter((x) => x.value).map((x) => ({ value: x.value!, ...(x.type ? { type: x.type } : {}) }));
    const seen = new Set(list.map((x) => normalise(x.value)));
    return [...list, ...values(add).filter((x) => !seen.has(normalise(x.value)))];
  };
  if (change.addPhones?.length) body.phoneNumbers = merge(current.phoneNumbers, body.phoneNumbers, change.addPhones);
  if (change.addEmails?.length) body.emailAddresses = merge(current.emailAddresses, body.emailAddresses, change.addEmails);
  const FIELD: Record<string, string> = { names: "names", phoneNumbers: "phoneNumbers", emailAddresses: "emailAddresses", organizations: "organizations", biographies: "biographies" };
  return { body, fields: Object.keys(body).map((k) => FIELD[k]!) };
}

/** For comparing numbers and addresses: digits and a leading + for phones, lower case for email. */
function normalise(v: string): string {
  return v.includes("@") ? v.trim().toLowerCase() : v.replace(/[^\d+]/g, "");
}
