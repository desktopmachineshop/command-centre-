import { randomBytes } from "node:crypto";
import type { Pool } from "../db/pool";
import { DEFAULT_PARAMS, hashPassword, MAX_PASSWORD_LENGTH, needsRehash, passwordProblem, type ScryptParams, verifyPassword } from "./password";
import { AccountStore, normaliseEmail, publicUser, type Session, sessionId, type User, type UserRecord } from "./store";
import { IP_POLICY, KeyedMutex, ACCOUNT_POLICY, Throttle } from "./throttle";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from "./totp";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** A session's expiry is slid forward (and the cookie re-sent) at most this often. */
const TOUCH_EVERY_MS = 60_000;
/** Concurrent login attempts allowed from one IP. */
const MAX_INFLIGHT_PER_IP = 4;

export const GENERIC_LOGIN_ERROR = "Incorrect email or password";
export const LOCKED_ERROR = "Too many attempts. Try again later.";

export type LoginResult =
  | { ok: true; token: string; session: Session; user: User }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterMs: number }
  | { ok: false; reason: "totp_required" }
  | { ok: false; reason: "totp_invalid" };

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthOptions {
  /** Lower cost for tests; production uses DEFAULT_PARAMS. */
  scrypt?: ScryptParams;
  now?: () => number;
}

/**
 * Users, password sign-in, sessions and TOTP. The HTTP layer (./http) maps this
 * onto routes and cookies; the CLI (../cli) uses it against DATABASE_URL.
 */
export class AuthService {
  readonly store: AccountStore;
  private readonly params: ScryptParams;
  private readonly now: () => number;
  private readonly ipThrottle: Throttle;
  /** Failures for emails with no account, so a lockout looks the same whether or not the account exists. */
  private readonly unknownThrottle: Throttle;
  private readonly emailMutex = new KeyedMutex();
  private readonly inflight = new Map<string, number>();
  private dummyHash: Promise<string> | null = null;
  private readonly revokeListeners = new Set<(sessionIds: string[]) => void>();

  constructor(pool: Pool, options: AuthOptions = {}) {
    this.store = new AccountStore(pool);
    this.params = options.scrypt ?? DEFAULT_PARAMS;
    this.now = options.now ?? Date.now;
    this.ipThrottle = new Throttle(IP_POLICY, this.now);
    this.unknownThrottle = new Throttle(ACCOUNT_POLICY, this.now);
  }

  /** Hash of a random password, verified against when the email has no account, so timing matches. */
  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(16).toString("hex"), this.params);
    return this.dummyHash;
  }

  /** Precomputes the dummy hash so the first unknown-email login isn't slower than the rest. */
  async warm(): Promise<void> {
    await this.dummy();
  }

  hash(password: string): Promise<string> {
    return hashPassword(password, this.params);
  }

  async setupRequired(): Promise<boolean> {
    return (await this.store.countUsers()) === 0;
  }

  // --- IP throttling (also used by the HTTP layer for a bad admin token on /setup) ---

  ipRetryAfter(ip: string): number {
    return this.ipThrottle.retryAfter(ip);
  }

  ipFailed(ip: string): void {
    this.ipThrottle.fail(ip);
  }

  // --- Users ---

  validateNewUser(input: { email: string; name: string; password: string }): void {
    const email = normaliseEmail(input.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AuthError(400, "Enter a valid email address");
    if (!input.name.trim() || input.name.length > 100) throw new AuthError(400, "Enter a name (up to 100 characters)");
    const problem = passwordProblem(input.password);
    if (problem) throw new AuthError(400, problem);
  }

  /** First-run setup: creates the admin only while no user exists. */
  async setupFirstUser(input: { email: string; name: string; password: string }): Promise<UserRecord> {
    this.validateNewUser(input);
    if (!(await this.setupRequired())) throw new AuthError(409, "Setup is already done. Sign in instead.");
    const user = await this.store.insertFirstUser({ email: input.email, name: input.name, passwordHash: await this.hash(input.password) });
    if (!user) throw new AuthError(409, "Setup is already done. Sign in instead.");
    return user;
  }

  /** Any user, e.g. from the CLI. */
  async createUser(input: { email: string; name: string; password: string }): Promise<UserRecord> {
    this.validateNewUser(input);
    if (await this.store.userByEmail(input.email)) throw new AuthError(409, `A user with email ${normaliseEmail(input.email)} already exists`);
    return this.store.insertUser({ email: input.email, name: input.name, passwordHash: await this.hash(input.password) });
  }

  /** Sets a new password, clears any lockout and signs the user out everywhere. Optionally turns 2FA off. */
  async resetPassword(email: string, password: string, options: { disableTotp?: boolean } = {}): Promise<UserRecord> {
    const problem = passwordProblem(password);
    if (problem) throw new AuthError(400, problem);
    const user = await this.store.userByEmail(email);
    if (!user) throw new AuthError(404, `No user with email ${normaliseEmail(email)}`);
    await this.store.setPasswordHash(user.id, await this.hash(password));
    await this.store.clearLockout(user.id);
    if (options.disableTotp) await this.store.disableTotp(user.id);
    this.emitRevoked(await this.store.deleteSessionsExcept(user.id, null));
    return (await this.store.userById(user.id))!;
  }

  // --- Login ---

  async login(input: { email: string; password: string; totp?: string; ip: string; userAgent: string | null }): Promise<LoginResult> {
    const ipWait = this.ipThrottle.retryAfter(input.ip);
    if (ipWait > 0) return { ok: false, reason: "locked", retryAfterMs: ipWait };
    const active = this.inflight.get(input.ip) ?? 0;
    if (active >= MAX_INFLIGHT_PER_IP) return { ok: false, reason: "locked", retryAfterMs: 1000 };
    this.inflight.set(input.ip, active + 1);
    try {
      const email = normaliseEmail(input.email).slice(0, 254);
      // One attempt per email at a time: a burst of parallel guesses can't race the lockout.
      return await this.emailMutex.run(email, () => this.attempt(email, input));
    } finally {
      const left = (this.inflight.get(input.ip) ?? 1) - 1;
      if (left > 0) this.inflight.set(input.ip, left);
      else this.inflight.delete(input.ip);
    }
  }

  private async attempt(email: string, input: { password: string; totp?: string; ip: string; userAgent: string | null }): Promise<LoginResult> {
    const user = await this.store.userByEmail(email);
    const lockedFor = user
      ? Math.max(0, (user.lockedUntil ? Date.parse(user.lockedUntil) : 0) - Date.now())
      : this.unknownThrottle.retryAfter(email);
    if (lockedFor > 0) return { ok: false, reason: "locked", retryAfterMs: lockedFor };

    const password = input.password.slice(0, MAX_PASSWORD_LENGTH + 1);
    // Always one scrypt, whether or not the account exists.
    const passwordOk = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await this.dummy()), false);
    if (!user || !passwordOk) {
      if (user) await this.store.recordFailure(user.id);
      else this.unknownThrottle.fail(email);
      this.ipThrottle.fail(input.ip);
      return { ok: false, reason: "invalid" };
    }

    let totpStep: number | null = null;
    if (user.totpEnabled && user.totpSecret) {
      const code = input.totp?.trim() ?? "";
      if (!code) return { ok: false, reason: "totp_required" };
      if (/^\d{6}$/.test(code)) totpStep = verifyTotp(user.totpSecret, code, this.now(), user.totpLastStep);
      const ok = totpStep !== null || (!/^\d{6}$/.test(code) && (await this.store.consumeRecoveryCode(user.id, hashRecoveryCode(code))));
      if (!ok) {
        await this.store.recordFailure(user.id);
        this.ipThrottle.fail(input.ip);
        return { ok: false, reason: "totp_invalid" };
      }
    }

    await this.store.recordLogin(user.id, totpStep);
    if (needsRehash(user.passwordHash, this.params)) await this.store.setPasswordHash(user.id, await this.hash(password));
    const { token, session } = await this.createSession(user.id, input.ip, input.userAgent);
    return { ok: true, token, session, user: publicUser({ ...user, lastLoginAt: session.createdAt }) };
  }

  async createSession(userId: string, ip: string | null, userAgent: string | null): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString("base64url");
    const session = await this.store.createSession({ id: sessionId(token), userId, ttlMs: SESSION_TTL_MS, ip, userAgent });
    return { token, session };
  }

  /**
   * Resolves a cookie token to its session and user. Slides the 30-day expiry forward
   * (at most once a minute); `refreshed` tells the caller to re-send the cookie.
   */
  async authenticate(token: string, ip: string | null = null): Promise<{ user: UserRecord; session: Session; refreshed: boolean } | null> {
    if (!token || token.length > 128) return null;
    const found = await this.store.sessionWithUser(sessionId(token));
    if (!found) return null;
    if (Date.now() - Date.parse(found.session.lastSeenAt) < TOUCH_EVERY_MS) return { ...found, refreshed: false };
    const session = await this.store.touchSession(found.session.id, SESSION_TTL_MS, ip);
    return session ? { user: found.user, session, refreshed: true } : null;
  }

  async logout(id: string): Promise<void> {
    if (await this.store.deleteSession(id)) this.emitRevoked([id]);
  }

  async revokeSession(userId: string, id: string): Promise<boolean> {
    const ok = await this.store.deleteSession(id, userId);
    if (ok) this.emitRevoked([id]);
    return ok;
  }

  async revokeOtherSessions(userId: string, keep: string | null): Promise<number> {
    const ids = await this.store.deleteSessionsExcept(userId, keep);
    this.emitRevoked(ids);
    return ids.length;
  }

  /** Change password: needs the current one, and signs out every other session. */
  async changePassword(user: UserRecord, current: string, next: string, keepSessionId: string, ip: string): Promise<number> {
    if (this.ipThrottle.retryAfter(ip) > 0) throw new AuthError(429, LOCKED_ERROR);
    if (!(await verifyPassword(current, user.passwordHash))) {
      this.ipThrottle.fail(ip);
      throw new AuthError(400, "Current password is incorrect");
    }
    const problem = passwordProblem(next);
    if (problem) throw new AuthError(400, problem);
    await this.store.setPasswordHash(user.id, await this.hash(next));
    return this.revokeOtherSessions(user.id, keepSessionId);
  }

  // --- TOTP ---

  async beginTotp(user: UserRecord): Promise<{ secret: string; otpauthUrl: string }> {
    if (user.totpEnabled) throw new AuthError(409, "Two-factor authentication is already on");
    const secret = generateTotpSecret();
    await this.store.setPendingTotp(user.id, secret);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async enableTotp(user: UserRecord, code: string): Promise<{ recoveryCodes: string[] }> {
    if (user.totpEnabled) throw new AuthError(409, "Two-factor authentication is already on");
    if (!user.totpSecret) throw new AuthError(400, "Start two-factor setup first");
    const step = verifyTotp(user.totpSecret, code.trim(), this.now());
    if (step === null) throw new AuthError(400, "That code didn't match. Check the time on your phone and try again.");
    const recoveryCodes = generateRecoveryCodes();
    await this.store.enableTotp(user.id, step, recoveryCodes.map(hashRecoveryCode));
    return { recoveryCodes };
  }

  async disableTotp(user: UserRecord, password: string, ip: string): Promise<void> {
    if (this.ipThrottle.retryAfter(ip) > 0) throw new AuthError(429, LOCKED_ERROR);
    if (!(await verifyPassword(password, user.passwordHash))) {
      this.ipThrottle.fail(ip);
      throw new AuthError(400, "Password is incorrect");
    }
    await this.store.disableTotp(user.id);
  }

  // --- Revocation events (open WebSockets close when their session goes) ---

  onRevoke(listener: (sessionIds: string[]) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private emitRevoked(ids: string[]) {
    if (!ids.length) return;
    for (const l of this.revokeListeners) {
      try {
        l(ids);
      } catch (err) {
        console.error("[auth] revoke listener", err);
      }
    }
  }
}
