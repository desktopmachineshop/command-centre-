import { describe, expect, it } from "vitest";
import {
  ContactsService,
  contactChangeOf,
  contactInputOf,
  DEFAULT_AUTH_SCOPES,
  describeContact,
  GoogleContactsProvider,
  normalisePhone,
  parseCalendarAccounts,
  telHref,
} from "../src";
import { FakeGoogle } from "./fake-google";

const creds = { clientId: "c", clientSecret: "s", refreshToken: "r" };

const steve = {
  resourceName: "people/c1",
  etag: "e-1",
  names: [{ displayName: "Steve Smith", givenName: "Steve", familyName: "Smith", metadata: { primary: true } }],
  phoneNumbers: [{ value: "07700 900123", type: "mobile", metadata: { primary: true } }],
  emailAddresses: [{ value: "steve@example.com", type: "work" }],
  organizations: [{ name: "Smith Motors" }],
};

function people() {
  const fake = new FakeGoogle();
  let etag = "e-1";
  fake
    .route("GET", /\/v1\/people:searchContacts$/, (c) => ({ json: c.url.searchParams.get("query") ? { results: [{ person: steve }] } : {} }))
    .route("GET", /\/v1\/people\/c1$/, () => ({ json: { ...steve, etag } }))
    .route("POST", /\/v1\/people:createContact$/, (c) => ({ json: { resourceName: "people/c2", etag: "n-1", ...c.body } }))
    .route("PATCH", /\/v1\/people\/c1:updateContact$/, (c) => {
      if (c.body.etag !== etag) return { status: 400, json: { error: { code: 400, message: "Request person.etag is different than the current person.etag.", status: "FAILED_PRECONDITION" } } };
      etag = "e-2";
      return { json: { ...steve, ...c.body, etag } };
    });
  return { fake, bump: () => (etag = "e-bumped"), peopleCalls: () => fake.calls.filter((c) => c.url.hostname === "people.googleapis.com") };
}

describe("Google contacts provider", () => {
  it("warms the search cache once, then searches names, numbers and companies", async () => {
    const { fake, peopleCalls } = people();
    const p = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: fake.fetch });
    const found = await p.search("steve", 5);
    await p.search("07700", 5);
    expect(found).toEqual([
      {
        accountId: "google",
        id: "people/c1",
        name: "Steve Smith",
        phones: [{ value: "07700 900123", type: "mobile" }],
        emails: [{ value: "steve@example.com", type: "work" }],
        company: "Smith Motors",
        notes: null,
      },
    ]);
    expect(peopleCalls().map((c) => c.url.searchParams.get("query"))).toEqual(["", "steve", "07700"]);
    expect(peopleCalls()[1]!.url.searchParams.get("readMask")).toBe("names,phoneNumbers,emailAddresses,organizations,biographies");
    expect(describeContact(found[0]!)).toBe("Steve Smith (Smith Motors) · mobile 07700 900123 · steve@example.com {contact: people/c1, account: google}");
  });

  it("creates a contact with a split name and typed values", async () => {
    const { fake, peopleCalls } = people();
    const p = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: fake.fetch });
    const c = await p.create(contactInputOf({ name: "Jo  de Bloggs", phones: ["07700 900456", { value: "0161 496 0000", type: "work" }], emails: ["jo@example.com"], company: "Bloggs Ltd" }));
    expect(peopleCalls()[0]!.body).toEqual({
      names: [{ givenName: "Jo", familyName: "de Bloggs" }],
      phoneNumbers: [{ value: "07700 900456" }, { value: "0161 496 0000", type: "work" }],
      emailAddresses: [{ value: "jo@example.com" }],
      organizations: [{ name: "Bloggs Ltd" }],
    });
    expect(c).toMatchObject({ id: "people/c2", name: "Jo de Bloggs", company: "Bloggs Ltd" });
    await expect(p.create({ name: " " })).rejects.toThrow(/needs a name/);
  });

  it("adds a number without losing the others, with the current etag and only the changed fields", async () => {
    const { fake, peopleCalls } = people();
    const p = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: fake.fetch });
    const c = await p.update("people/c1", contactChangeOf({ id: "people/c1", addPhones: [{ value: "0161 496 0000", type: "work" }, "07700900123"], notes: "MOT due March" }));
    const patch = peopleCalls().find((x) => x.method === "PATCH")!;
    expect(patch.url.searchParams.get("updatePersonFields")).toBe("biographies,phoneNumbers");
    expect(patch.body).toEqual({
      etag: "e-1",
      // The existing mobile is kept (and the same number written differently isn't added twice).
      phoneNumbers: [{ value: "07700 900123", type: "mobile" }, { value: "0161 496 0000", type: "work" }],
      biographies: [{ value: "MOT due March", contentType: "TEXT_PLAIN" }],
    });
    expect(c.phones.map((x) => x.value)).toEqual(["07700 900123", "0161 496 0000"]);
  });

  it("re-reads once when the contact changed in between, and refuses ids that aren't contacts", async () => {
    const { fake, bump, peopleCalls } = people();
    const p = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: fake.fetch });
    // Someone edits it after our read: our first PATCH has a stale etag.
    let first = true;
    const realFetch = fake.fetch;
    const racing: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (first && String(input).includes("/people/c1?")) {
        first = false;
        bump();
      }
      return res;
    };
    const q = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: racing });
    expect((await q.update("c1", { company: "" })).id).toBe("people/c1");
    expect(peopleCalls().filter((x) => x.method === "PATCH").map((x) => x.body)).toEqual([
      { etag: "e-1", organizations: [] },
      { etag: "e-bumped", organizations: [] },
    ]);
    await expect(p.get("../calendar/v3/x")).rejects.toThrow(/not a contact id/);
  });

  it("says to reconnect when the token predates the contacts scope, and to turn the API on", async () => {
    const fake = new FakeGoogle()
      .route("GET", /searchContacts$/, () => ({
        status: 403,
        json: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
      }))
      .route("GET", /people\/c9$/, () => ({ status: 403, json: { error: { code: 403, message: "People API has not been used", details: [{ reason: "SERVICE_DISABLED" }] } } }));
    const p = new GoogleContactsProvider({ accountId: "google", credentials: creds, fetch: fake.fetch });
    await expect(p.search("x", 5)).rejects.toThrow(/Reconnect it on the Accounts page.*allow access to contacts/);
    await expect(p.get("people/c9")).rejects.toThrow(/Turn it on \(APIs & Services → Library → People API\)/);
  });

  it("asks for the contacts scope in the one Google sign-in", () => {
    expect(DEFAULT_AUTH_SCOPES).toContain("https://www.googleapis.com/auth/contacts");
  });
});

describe("contacts service", () => {
  const accounts = parseCalendarAccounts(
    JSON.stringify([
      { id: "home", provider: "google", vertical: "personal", credentials: creds },
      { id: "work", provider: "google", vertical: "dms", credentials: creds },
    ]),
  );
  const fakeProvider = (accountId: string, log: string[]) => ({
    accountId,
    search: async (q: string) => [{ accountId, id: `people/c${accountId.length}`, name: `${q} at ${accountId}`, phones: [], emails: [], company: null, notes: null }],
    get: async (id: string) => ({ accountId, id, name: "x", phones: [], emails: [], company: null, notes: null }),
    create: async () => {
      log.push(`create ${accountId}`);
      return { accountId, id: "people/c5", name: "x", phones: [], emails: [], company: null, notes: null };
    },
    update: async (id: string) => {
      log.push(`update ${accountId} ${id}`);
      return { accountId, id, name: "x", phones: [], emails: [], company: null, notes: null };
    },
  });

  it("lets personal search every account but write only its own", async () => {
    const log: string[] = [];
    const svc = new ContactsService(accounts, { providers: [fakeProvider("home", log), fakeProvider("work", log)] });
    expect((await svc.search("Jo", { vertical: "personal" })).contacts.map((c) => c.accountId)).toEqual(["home", "work"]);
    expect((await svc.search("Jo", { vertical: "dms" })).contacts.map((c) => c.accountId)).toEqual(["work"]);
    await svc.create({ name: "Jo" }, { vertical: "personal" });
    await svc.create({ name: "Jo" }, { vertical: "dms" });
    await expect(svc.update("people/c1", {}, { vertical: "personal", accountId: "work" })).rejects.toThrow(/No Google account "work"/);
    await svc.update("people/c1", {}, { accountId: "work" }); // Dave: any account
    expect(log).toEqual(["create home", "create work", "update work people/c1"]);
  });
});

describe("phone numbers on reminders", () => {
  it("tidies numbers and refuses things that aren't numbers", () => {
    expect(normalisePhone(" 07700  900123 ")).toBe("07700 900123");
    expect(normalisePhone("+44 (0)20 7946-0000")).toBe("+44 (0)20 7946-0000");
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(() => normalisePhone("call Steve")).toThrow(/not a phone number/);
    expect(() => normalisePhone("12")).toThrow();
    // "+44 (0)20…": the (0) is only dialled from inside the UK, so it is dropped after the +44.
    expect(telHref("+44 (0)20 7946-0000")).toBe("tel:+442079460000");
    expect(telHref("07700 900123")).toBe("tel:07700900123");
  });

  it("checks emails on contacts", () => {
    expect(() => contactInputOf({ name: "Jo", emails: ["not-an-email"] })).toThrow(/not an email address/);
    expect(() => contactInputOf({ name: "Jo", phones: ["ring me"] })).toThrow(/not a phone number/);
  });
});
