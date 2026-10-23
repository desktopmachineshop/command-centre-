import { randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with node:crypto scrypt.
 *
 * Encoded as `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt b64>$<hash b64>`, so the cost
 * can be raised later: `needsRehash` spots an old hash and the login path rewrites it.
 */
export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  ln: number;
  r: number;
  p: number;
}

/** N = 2^15, r = 8: 32 MiB and roughly 50-100 ms per hash on a server core. */
export const DEFAULT_PARAMS: ScryptParams = { ln: 15, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
/** Longer inputs are refused before hashing, so a huge body can't be used to burn CPU. */
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_PASSWORD_LENGTH = 10;

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.ln;
  const options: ScryptOptions = { N, r: params.r, p: params.p, maxmem: 128 * N * params.r * 2 + 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEY_LEN, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, params);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function decode(encoded: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(encoded);
  if (!m) return null;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Refuse absurd parameters from a tampered row rather than allocating gigabytes.
  if (params.ln < 1 || params.ln > 22 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) return null;
  return { params, salt: Buffer.from(m[4]!, "base64"), key: Buffer.from(m[5]!, "base64") };
}

/** Constant-time check. A malformed hash never matches. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const d = decode(encoded);
  if (!d || password.length > MAX_PASSWORD_LENGTH) return false;
  const key = await scrypt(password, d.salt, d.params);
  return key.length === d.key.length && timingSafeEqual(key, d.key);
}

/** True when the hash was made with weaker parameters than `params`. */
export function needsRehash(encoded: string, params: ScryptParams = DEFAULT_PARAMS): boolean {
  const d = decode(encoded);
  return !d || d.params.ln < params.ln || d.params.r < params.r || d.params.p < params.p;
}

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}
