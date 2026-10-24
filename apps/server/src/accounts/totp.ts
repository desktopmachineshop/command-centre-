import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps), as authenticator apps expect. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded (the RFC 4226 recommended length). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226) for one counter value. `algorithm` is exposed for the RFC 6238 test vectors. */
export function hotp(key: Buffer, counter: number, digits = DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Checks a code within ±1 step of now. Returns the matched step (so the caller can
 * refuse a replay of the same or an earlier step), or null.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, afterStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1].filter((s) => s >= 0)) {
    // Compare every window (no early exit) in constant time.
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code));
    if (ok && (afterStep === null || step > afterStep) && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(secret: string, account: string, issuer = "Command Centre"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

// --- Recovery codes: one-time, high-entropy, so a fast hash is enough to store them. ---

/** Ten codes like `k7m2-x9qp-4hdt`, shown once when 2FA is enabled. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}
