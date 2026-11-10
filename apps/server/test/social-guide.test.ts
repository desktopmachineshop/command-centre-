import { describe, expect, it } from "vitest";
import { socialAccountsGuide } from "../src/social-guide";

const account = (id: string, platform: string, vertical: string, extra: Record<string, unknown> = {}) =>
  ({ id, platform, vertical, inbound: true, credentials: { token: "secret-token" }, options: {}, ...extra }) as never;

describe("socialAccountsGuide", () => {
  const accounts = [
    account("dms-instagram", "instagram", "dms", { handle: "@desktopmachineshop" }),
    account("openv-reddit", "reddit", "openv", { handle: "u/openv_dave", credentials: { sessionCookie: "reddit_session=abc" } }),
    account("openv-x", "x", "openv"),
  ];

  it("names the business's own accounts by id, never their credentials", () => {
    const guide = socialAccountsGuide(accounts, "openv", false);
    expect(guide).toContain("## Social accounts");
    expect(guide).toContain("- `openv-reddit`: reddit u/openv_dave (Dave's own login: paced, a few posts a day)");
    expect(guide).toContain("- `openv-x`: x");
    expect(guide).not.toContain("dms-instagram");
    expect(guide).not.toMatch(/secret-token|reddit_session/);
  });

  it("gives the assistant every business's accounts, this business's first", () => {
    const lines = socialAccountsGuide(accounts, "openv", true).split("\n").slice(2);
    expect(lines).toEqual([
      "- `openv-reddit`: reddit u/openv_dave (business openv; Dave's own login: paced, a few posts a day)",
      "- `openv-x`: x (business openv)",
      "- `dms-instagram`: instagram @desktopmachineshop (business dms)",
    ]);
  });

  it("is empty when the business has none", () => {
    expect(socialAccountsGuide(accounts, "personal", false)).toBe("");
  });

  it("offers a shared account to each business it posts for", () => {
    const shared = [...accounts, account("dave-x", "x", "personal", { alsoVerticals: ["dms", "openv"] })];
    expect(socialAccountsGuide(shared, "dms", false)).toContain("- `dave-x`: x (shared from personal)");
    expect(socialAccountsGuide(shared, "3dpandme", false)).toBe("");
    expect(socialAccountsGuide(shared, "personal", true)).toContain("- `dave-x`: x (business personal, dms, openv)");
  });
});
