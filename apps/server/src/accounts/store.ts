import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "../db/pool";
import { ACCOUNT_POLICY } from "./throttle";

/** Roles a user can have. Only admin today; a VA role would be added here and checked per route. */
export type Role = "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  totpEnabled: boolean;
}

/** The full row, for the auth service only (never sent to a client). */
export interface UserRecord extends User {
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: string | null;
  totpSecret: string | null;
  totpLastStep: number | null;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

type Row = Record<string, any>;
const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  createdAt: iso(r.created_at)!,
  lastLoginAt: iso(r.last_login_at),
  totpEnabled: r.totp_enabled_at != null,
  passwordHash: r.password_hash,
  failedAttempts: r.failed_attempts,
  lockedUntil: iso(r.locked_until),
  totpSecret: r.totp_secret,
  totpLastStep: r.totp_last_step == null ? null : Number(r.totp_last_step),
});

const toSession = (r: Row): Session => ({
  id: r.id,
  userId: r.user_id,
  createdAt: iso(r.created_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
  expiresAt: iso(r.expires_at)!,
  userAgent: r.user_agent,
  ip: r.ip,
});

/** What a client may see of a user. */
export function publicUser(u: UserRecord | User): User {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, totpEnabled: u.totpEnabled };
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Session ids are the sha256 of the cookie token, so a database leak doesn't hand out live sessions. */
export const sessionId = (token: string) => createHash("sha256").update(token).digest("hex");

export class AccountStore {
  constructor(readonly pool: Pool) {}

  async countUsers(): Promise<number> {
    const { rows } = await this.pool.query("select count(*)::int as n from users");
    return rows[0].n;
  }

  async listUsers(): Promise<UserRecord[]> {
    return (await this.pool.query("select * from users order by created_at")).rows.map(toUser);
  }

  async userByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query("select * from users where email = $1", [normaliseEmail(email)]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async userById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query("select * from users where id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async insertUser(u: { email: string; name: string; passwordHash: string; role?: Role }): Promise<UserRecord> {
    const { rows } = await this.pool.query(
      "insert into users (id, email, name, password_hash, role) values ($1, $2, $3, $4, $5) returning *",
      [randomUUID(), normaliseEmail(u.email), u.name.trim(), u.passwordHash, u.role ?? "admin"],
    );
    return toUser(rows[0]);
  }

  /**
   * Creates the first user only if there is none, under a transaction-scoped lock so
   * two racing setup requests can't both win. Returns null when a user already exists.
   */
  async insertFirstUser(u: { email: string; name: string; passwordHash: string }): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(727275)");
      const { rows: existing } = await client.query("select 1 from users limit 1");
      if (existing.length) {
        await client.query("rollback");
        return null;
      }
      const { rows } = await client.query(
        "insert into users (id, email, name, password_hash, role) values ($1, $2, $3, $4, 'admin') returning *",
        [randomUUID(), normaliseEmail(u.email), u.name.trim(), u.passwordHash],
      );
      await client.query("commit");
      return toUser(rows[0]);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query("update users set password_hash = $2 where id = $1", [userId, passwordHash]);
  }

  /** Counts a failed sign-in and, past the free attempts, locks the account with exponential back-off. */
  async recordFailure(userId: string): Promise<void> {
    const p = ACCOUNT_POLICY;
    await this.pool.query(
      `update users set
         failed_attempts = failed_attempts + 1,
         locked_until = case when failed_attempts + 1 >= $2
           then now() + make_interval(secs => least($4::double precision, $3::double precision * power(2, least(30, failed_attempts + 1 - $2))) / 1000)
           else locked_until end
       where id = $1`,
      [userId, p.free, p.baseMs, p.maxMs],
    );
  }

  async recordLogin(userId: string, totpStep: number | null): Promise<void> {
    await this.pool.query(
      "update users set failed_attempts = 0, locked_until = null, last_login_at = now(), totp_last_step = coalesce($2, totp_last_step) where id = $1",
      [userId, totpStep],
    );
  }

  async clearLockout(userId: string): Promise<void> {
    await this.pool.query("update users set failed_attempts = 0, locked_until = null where id = $1", [userId]);
  }

  // --- TOTP ---

  async setPendingTotp(userId: string, secret: string): Promise<void> {
    await this.pool.query("update users set totp_secret = $2, totp_enabled_at = null, totp_last_step = null where id = $1", [userId, secret]);
  }

  async enableTotp(userId: string, step: number, recoveryCodeHashes: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update users set totp_enabled_at = now(), totp_last_step = $2 where id = $1", [userId, step]);
      await client.query("delete from user_recovery_codes where user_id = $1", [userId]);
      for (const hash of recoveryCodeHashes) {
        await client.query("insert into user_recovery_codes (user_id, code_hash) values ($1, $2)", [userId, hash]);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async disableTotp(userId: string): Promise<void> {
    await this.pool.query("update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1", [userId]);
    await this.pool.query("delete from user_recovery_codes where user_id = $1", [userId]);
  }

  /** Marks a recovery code used. True only the first time it is used. */
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "update user_recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null",
      [userId, codeHash],
    );
    return rowCount === 1;
  }

  async recoveryCodesLeft(userId: string): Promise<number> {
    const { rows } = await this.pool.query("select count(*)::int as n from user_recovery_codes where user_id = $1 and used_at is null", [userId]);
    return rows[0].n;
  }

  // --- Sessions ---

  async createSession(s: { id: string; userId: string; ttlMs: number; userAgent: string | null; ip: string | null }): Promise<Session> {
    // Opportunistic clean-up of long-dead sessions.
    await this.pool.query("delete from sessions where expires_at < now()");
    const { rows } = await this.pool.query(
      `insert into sessions (id, user_id, expires_at, user_agent, ip)
       values ($1, $2, now() + make_interval(secs => $3::double precision / 1000), $4, $5) returning *`,
      [s.id, s.userId, s.ttlMs, s.userAgent?.slice(0, 300) ?? null, s.ip],
    );
    return toSession(rows[0]);
  }

  /** The live (unexpired) session and its user. */
  async sessionWithUser(id: string): Promise<{ session: Session; user: UserRecord } | null> {
    const { rows } = await this.pool.query(
      `select s.id as s_id, s.user_id as s_user_id, s.created_at as s_created_at, s.last_seen_at as s_last_seen_at,
              s.expires_at as s_expires_at, s.user_agent as s_user_agent, s.ip as s_ip, u.*
       from sessions s join users u on u.id = s.user_id
       where s.id = $1 and s.expires_at > now()`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    const session = toSession({
      id: r.s_id, user_id: r.s_user_id, created_at: r.s_created_at, last_seen_at: r.s_last_seen_at,
      expires_at: r.s_expires_at, user_agent: r.s_user_agent, ip: r.s_ip,
    });
    return { session, user: toUser(r) };
  }

  /** Slides the expiry forward. Returns the new expiry. */
  async touchSession(id: string, ttlMs: number, ip: string | null): Promise<Session | null> {
    const { rows } = await this.pool.query(
      `update sessions set last_seen_at = now(), expires_at = now() + make_interval(secs => $2::double precision / 1000),
         ip = coalesce($3, ip)
       where id = $1 and expires_at > now() returning *`,
      [id, ttlMs, ip],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listSessions(userId: string): Promise<Session[]> {
    const { rows } = await this.pool.query(
      "select * from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc",
      [userId],
    );
    return rows.map(toSession);
  }

  async deleteSession(id: string, userId?: string): Promise<boolean> {
    const { rowCount } = userId
      ? await this.pool.query("delete from sessions where id = $1 and user_id = $2", [id, userId])
      : await this.pool.query("delete from sessions where id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Deletes every session of the user except `keep`. Returns the deleted ids. */
  async deleteSessionsExcept(userId: string, keep: string | null): Promise<string[]> {
    const { rows } = await this.pool.query(
      "delete from sessions where user_id = $1 and ($2::text is null or id <> $2) returning id",
      [userId, keep],
    );
    return rows.map((r) => r.id);
  }
}
