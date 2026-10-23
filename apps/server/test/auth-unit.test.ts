import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, hashPassword, needsRehash, passwordProblem, verifyPassword } from "../src/accounts/password";
import { ACCOUNT_POLICY, backoffMs, KeyedMutex, Throttle } from "../src/accounts/throttle";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  otpauthUrl,
  verifyTotp,
} from "../src/accounts/totp";
import { cliDatabaseUrl } from "../src/cli";

describe("password hashing", () => {
  it("hashes with scrypt, encodes its parameters and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    const params = { ln: 10, r: 8, p: 1 };
    const [a, b] = await Promise.all([hashPassword("same password", params), hashPassword("same password", params)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("normalises Unicode so the same password typed on another keyboard matches", async () => {
    const hash = await hashPassword("café-password", { ln: 10, r: 8, p: 1 });
    expect(await verifyPassword("café-password", hash)).toBe(true);
  });

  it("flags weaker parameters for rehash and never matches malformed or absurd hashes", async () => {
    const weak = await hashPassword("pw-0123456789", { ln: 10, r: 8, p: 1 });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword("pw-0123456789"))).toBe(false);
    expect(needsRehash(weak, { ln: 10, r: 8, p: 1 })).toBe(false);
    expect(await verifyPassword("x", "plain-text")).toBe(false);
    expect(await verifyPassword("x", "$scrypt$ln=40,r=8,p=1$AAAA$AAAA")).toBe(false);
    expect(DEFAULT_PARAMS.ln).toBeGreaterThanOrEqual(15);
  });

  it("checks length", () => {
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem("x".repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem("long enough password")).toBeNull();
  });
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B: 8-digit codes for SHA1, SHA256 and SHA512 seeds.
  const seeds = {
    sha1: Buffer.from("12345678901234567890"),
    sha256: Buffer.from("12345678901234567890123456789012"),
    sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
  };
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  it.each(vectors)("t=%i", (t, sha1, sha256, sha512) => {
    const counter = Math.floor(t / 30);
    expect(hotp(seeds.sha1, counter, 8, "sha1")).toBe(sha1);
    expect(hotp(seeds.sha256, counter, 8, "sha256")).toBe(sha256);
    expect(hotp(seeds.sha512, counter, 8, "sha512")).toBe(sha512);
  });

  it("round-trips base32", () => {
    expect(base32Encode(seeds.sha1)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(seeds.sha1);
  });

  it("accepts a code within one step either side, and refuses a replay", () => {
    const secret = base32Encode(seeds.sha1);
    // The 6-digit code at t=59 is the last six digits of the 8-digit vector.
    expect(verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(verifyTotp(secret, "287082", 89_000)).toBe(1); // one step later
    expect(verifyTotp(secret, "287082", 0)).toBe(1); // one step earlier
    expect(verifyTotp(secret, "287082", 119_000)).toBeNull(); // two steps later
    expect(verifyTotp(secret, "287082", 59_000, 1)).toBeNull(); // already used
    expect(verifyTotp(secret, "28708", 59_000)).toBeNull();
    expect(verifyTotp(secret, "abcdef", 59_000)).toBeNull();
  });

  it("builds an otpauth URL authenticator apps understand", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "dave@example.com"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/Command Centre:dave@example.com");
    expect(url.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(url.searchParams.get("issuer")).toBe("Command Centre");
  });

  it("makes distinct recovery codes and hashes them format-insensitively", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0]!)).toBe(hashRecoveryCode(codes[0]!.toUpperCase().replace(/-/g, " ")));
  });
});

describe("throttling", () => {
  it("backs off exponentially after the free attempts, up to a cap", () => {
    const p = { free: 3, baseMs: 1000, maxMs: 10_000 };
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, p))).toEqual([0, 0, 1000, 2000, 4000, 8000, 10_000]);
    expect(backoffMs(4, ACCOUNT_POLICY)).toBe(0);
    expect(backoffMs(5, ACCOUNT_POLICY)).toBe(15_000);
  });

  it("blocks a key until its back-off passes, and forgets old failures", () => {
    let now = 0;
    const t = new Throttle({ free: 2, baseMs: 1000, maxMs: 60_000 }, () => now, 10_000);
    t.fail("ip");
    expect(t.retryAfter("ip")).toBe(0);
    t.fail("ip");
    expect(t.retryAfter("ip")).toBe(1000);
    now = 1000;
    expect(t.retryAfter("ip")).toBe(0);
    t.fail("ip");
    expect(t.retryAfter("ip")).toBe(2000);
    now = 20_000;
    t.fail("ip"); // the earlier failures expired, so this is the first again
    expect(t.retryAfter("ip")).toBe(0);
    expect(t.retryAfter("other")).toBe(0);
  });

  it("serialises work per key", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const step = (name: string, ms: number) => async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
    };
    await Promise.all([m.run("a", step("a1", 20)), m.run("a", step("a2", 1)), m.run("b", step("b1", 1))]);
    expect(order.indexOf("a1-")).toBeLessThan(order.indexOf("a2+"));
    expect(order.indexOf("b1+")).toBeLessThan(order.indexOf("a1-"));
  });
});

describe("cli database url", () => {
  it("prefers Railway's public URL, since railway run executes outside the private network", () => {
    expect(cliDatabaseUrl({ DATABASE_URL: "postgres://internal", DATABASE_PUBLIC_URL: "postgres://public" })).toBe("postgres://public");
    expect(cliDatabaseUrl({ DATABASE_URL: "postgres://internal" })).toBe("postgres://internal");
    expect(cliDatabaseUrl({ CC_DATABASE_URL: "postgres://explicit", DATABASE_PUBLIC_URL: "postgres://public" })).toBe("postgres://explicit");
  });
});
