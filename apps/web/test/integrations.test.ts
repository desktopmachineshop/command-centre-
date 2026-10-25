import { describe, expect, it } from "vitest";
import {
  chosenCalendars,
  daysUntil,
  describeResult,
  type EntryView,
  entryStatus,
  entryTitle,
  type FieldDef,
  initialValues,
  oauthReturn,
  redirectUri,
  slugify,
  suggestId,
  toPatch,
  validate,
} from "../src/integrations";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const entry = (over: Partial<EntryView> = {}): EntryView => ({ kind: "odoo", id: "default", source: "app", data: {}, secrets: {}, meta: {}, ...over });

const odoo: { fields: FieldDef[] } = {
  fields: [
    { key: "url", label: "Odoo URL", type: "url", required: true },
    { key: "db", label: "Database", type: "text", required: true },
    { key: "apiKey", label: "API key", type: "secret", required: true },
    { key: "api", label: "API", type: "select", options: ["jsonrpc", "json2"], default: "jsonrpc" },
  ],
};
const email: { fields: FieldDef[] } = {
  fields: [
    { key: "imapPort", label: "IMAP port", type: "number", default: 993 },
    { key: "imapSecure", label: "IMAP TLS", type: "boolean", default: true },
    { key: "ignoreFrom", label: "Ignore senders", type: "list" },
    { key: "options", label: "Options", type: "json" },
    { key: "token", label: "Token", type: "secret", fromOAuth: true },
  ],
};

describe("entryStatus", () => {
  it("covers not set, error, railway and connected", () => {
    expect(entryStatus(undefined)).toEqual({ tone: "none", label: "Not set" });
    expect(entryStatus(entry({ error: "bad key" }))).toMatchObject({ tone: "bad", label: "Error", detail: "bad key" });
    expect(entryStatus(entry({ source: "railway" }))).toMatchObject({ tone: "info", label: "From Railway" });
    expect(entryStatus(entry())).toMatchObject({ tone: "ok", label: "Connected" });
  });

  it("warns within 14 days of expiry, and flags expired tokens", () => {
    const at = (days: number) => entry({ meta: { expiresAt: new Date(NOW + days * 86_400_000).toISOString() } });
    expect(entryStatus(at(30), undefined, NOW).label).toBe("Connected");
    expect(entryStatus(at(14), undefined, NOW)).toMatchObject({ tone: "warn", label: "Expires in 14 days" });
    expect(entryStatus(at(0.5), undefined, NOW)).toMatchObject({ tone: "warn", label: "Expires in 1 day" });
    expect(entryStatus(at(-1), undefined, NOW)).toMatchObject({ tone: "bad", label: "Expired" });
  });

  it("says an OAuth entry without its token isn't connected", () => {
    const def = { oauth: "instagram", fields: [{ key: "accessToken", label: "t", type: "secret" as const, fromOAuth: true }] };
    expect(entryStatus(entry({ secrets: { accessToken: null } }), def).label).toBe("Not connected");
    expect(entryStatus(entry({ secrets: { accessToken: "••••abcd" } }), def).label).toBe("Connected");
  });

  it("daysUntil ignores missing or bad dates", () => {
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil("nope")).toBeNull();
  });
});

describe("form values", () => {
  it("starts from defaults for a new entry and from data for an existing one", () => {
    expect(initialValues(odoo)).toEqual({ url: "", db: "", apiKey: "", api: "jsonrpc" });
    expect(initialValues(email, entry({ data: { imapPort: 143, imapSecure: false, ignoreFrom: ["a@b.c", "@x.y"], options: '{"a":1}' } }))).toEqual({
      imapPort: "143",
      imapSecure: false,
      ignoreFrom: "a@b.c\n@x.y",
      options: '{\n  "a": 1\n}',
    });
  });

  it("converts to a patch: typed values, blank secrets kept, cleared secrets removed", () => {
    expect(toPatch(odoo, { url: " https://x.odoo.com ", db: "x", apiKey: "", api: "json2" }, { isNew: false })).toEqual({
      data: { url: "https://x.odoo.com", db: "x", api: "json2" },
    });
    expect(toPatch(odoo, { url: "https://x", db: "", apiKey: "k1", api: "" }, { isNew: false, cleared: new Set() })).toEqual({
      data: { url: "https://x", db: null, api: null },
      secrets: { apiKey: "k1" },
    });
    expect(toPatch(odoo, { url: "https://x", db: "", apiKey: "", api: "" }, { isNew: true, cleared: new Set(["apiKey"]) })).toEqual({
      data: { url: "https://x" },
      secrets: { apiKey: null },
    });
    expect(toPatch(email, { imapPort: "993", imapSecure: true, ignoreFrom: "a@b.c\n\n @x.y \n", options: '{ "a": 1 }' }, { isNew: true }).data).toEqual({
      imapPort: 993,
      imapSecure: true,
      ignoreFrom: ["a@b.c", "@x.y"],
      options: '{"a":1}',
    });
  });

  it("validates required fields, keeping a stored secret, and JSON", () => {
    expect(validate(odoo, { url: "x", db: "", apiKey: "", api: "" })).toEqual({
      url: "Odoo URL must start with https://",
      db: "Database is required",
      apiKey: "API key is required",
    });
    const stored = entry({ secrets: { apiKey: "••••1234" } });
    expect(validate(odoo, { url: "https://a", db: "a", apiKey: "", api: "" }, stored)).toEqual({});
    expect(validate(odoo, { url: "https://a", db: "a", apiKey: "", api: "" }, stored, new Set(["apiKey"]))).toHaveProperty("apiKey");
    expect(validate(email, { imapPort: "x", options: "{nope" })).toEqual({ imapPort: "IMAP port must be a number", options: "Options isn't valid JSON" });
  });
});

describe("ids, titles and sign-in", () => {
  it("suggests a free slug from business and platform", () => {
    expect(slugify("DMS Instagram!")).toBe("dms-instagram");
    expect(suggestId("dms", "instagram", [])).toBe("dms-instagram");
    expect(suggestId("dms", "instagram", ["dms-instagram", "dms-instagram-2"])).toBe("dms-instagram-3");
    expect(suggestId(undefined, "email", [])).toBe("email");
  });

  it("titles multi entries by name, handle or address", () => {
    expect(entryTitle({ label: "Odoo", multi: false }, entry())).toBe("Odoo");
    expect(entryTitle({ label: "Instagram", multi: true }, entry({ id: "dms-ig", data: { handle: "@dms" } }))).toBe("@dms");
    expect(entryTitle({ label: "Email", multi: true }, entry({ id: "e1" }))).toBe("e1");
  });

  it("builds redirect addresses and reads the return query", () => {
    expect(redirectUri("https://cc.example.com/", "google")).toBe("https://cc.example.com/oauth/google/callback");
    expect(redirectUri(null, "google")).toBeNull();
    expect(oauthReturn(new URLSearchParams("connected=google&id=me"))).toEqual({ kind: "connected", entryKind: "google", id: "me" });
    expect(oauthReturn(new URLSearchParams("oauthError=denied"))).toEqual({ kind: "error", message: "denied" });
    expect(oauthReturn(new URLSearchParams(""))).toBeNull();
  });

  it("reads chosen calendars, defaulting to primary", () => {
    expect(chosenCalendars(entry({ data: { calendars: '[{"id":"a","name":"A"}]' } }))).toEqual([{ id: "a", name: "A" }]);
    expect(chosenCalendars(entry({ data: { calendars: "bad" } }))).toEqual([{ id: "primary" }]);
  });

  it("describes a save result", () => {
    expect(describeResult({ reloaded: ["odoo"], failed: {} })).toEqual({ ok: true, text: "Saved. Odoo restarted with the new settings." });
    expect(describeResult({ reloaded: [], failed: { email: "IMAP refused" } })).toEqual({ ok: false, text: "Saved, but Email couldn't restart: IMAP refused" });
  });
});
