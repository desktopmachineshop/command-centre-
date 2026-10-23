import { describe, expect, it } from "vitest";
import { parseSocialAccounts, publicAccount } from "../src";
import { fakeAdapter } from "./fakes";

const adapters = { instagram: fakeAdapter("instagram"), x: fakeAdapter("x") };
const ig = { id: "3dp-instagram", platform: "instagram", vertical: "3dpandme", handle: "3dpandme", credentials: { token: "ig-secret-token" } };

describe("parseSocialAccounts", () => {
  it("is empty when unset or blank", () => {
    expect(parseSocialAccounts(undefined, { adapters })).toEqual([]);
    expect(parseSocialAccounts("  ", { adapters })).toEqual([]);
  });

  it("parses accounts with defaults", () => {
    const [a] = parseSocialAccounts(JSON.stringify([ig]), { adapters });
    expect(a).toMatchObject({ id: "3dp-instagram", inbound: true, options: {}, credentials: { token: "ig-secret-token" } });
  });

  it("rejects duplicate ids", () => {
    expect(() => parseSocialAccounts(JSON.stringify([ig, { ...ig, platform: "x" }]), { adapters })).toThrow(/account ids must be unique/);
  });

  it("names the account and field of a bad shape", () => {
    expect(() => parseSocialAccounts(JSON.stringify([ig, { ...ig, id: "x-acct", platform: "myspace" }]), { adapters })).toThrow(
      /account 2 \("x-acct"\)\.platform/,
    );
  });

  it("checks credentials with the adapter's schema, without echoing secrets", () => {
    const bad = { ...ig, credentials: { token: "short", other: "x" } };
    let message = "";
    try {
      parseSocialAccounts(JSON.stringify([bad]), { adapters });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/account "3dp-instagram" \(instagram\) credentials\.token: token must be at least 8 characters/);
    expect(message).not.toContain("short");
  });

  it("never echoes the JSON in a syntax error", () => {
    let message = "";
    try {
      parseSocialAccounts('[{"id":"a","credentials":{"token":"super-secret-value"}', { adapters });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^SOCIAL_ACCOUNTS is not valid JSON/);
    expect(message).not.toContain("super-secret");
  });

  it("scrubs secrets a custom message quotes", () => {
    const leaky = { ...fakeAdapter("x"), credentials: fakeAdapter("x").credentials.refine((c) => c.token !== "leaky-secret-123", { message: "bad token leaky-secret-123" }) };
    expect(() =>
      parseSocialAccounts(JSON.stringify([{ ...ig, platform: "x", credentials: { token: "leaky-secret-123" } }]), { adapters: { x: leaky } }),
    ).toThrow("credentials: bad token ***");
  });

  it("can skip the credential check (the server checks against its own adapters)", () => {
    expect(parseSocialAccounts(JSON.stringify([{ ...ig, credentials: {} }]), { checkCredentials: false })).toHaveLength(1);
  });

  it("errors when no adapter exists for the platform", () => {
    expect(() => parseSocialAccounts(JSON.stringify([{ ...ig, platform: "reddit" }]), { adapters })).toThrow(/no adapter for platform "reddit"/);
  });

  it("publicAccount hides credentials and options", () => {
    const [a] = parseSocialAccounts(JSON.stringify([{ ...ig, options: { webhook: "secret" } }]), { adapters });
    const view = publicAccount(a!, adapters);
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(view).toMatchObject({ id: "3dp-instagram", platform: "instagram", handle: "3dpandme", capabilities: { maxTextLength: 280 } });
  });
});
