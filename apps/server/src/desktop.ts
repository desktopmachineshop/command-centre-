import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";

/**
 * Desktop app linking and installer downloads.
 *
 * Linking works like a TV sign-in: the app asks for a link code (no credentials), opens the
 * server's app at `#/devices?link=<code>`, and polls. Dave signs in there as usual and presses
 * "Link this computer". The next poll hands the app its own worker token, which it keeps in its
 * config file. No shared WORKER_TOKEN is needed, and each computer can be unlinked on its own.
 *
 * Automatic linking: the app also gets an `autoKey`, which it puts only in the page it opens in
 * its own window (`&auto=<key>`). Once Dave is signed in there, that page approves by itself, but
 * only when the key matches and the approval comes from the IP address that started the link. A
 * link someone else sends Dave (they'd have their own code and key, on another network) still
 * needs the button. A code stays alive while the app keeps polling, so signing in slowly (or
 * resetting a password first) doesn't expire it.
 */

export interface DesktopDevice {
  id: string;
  name: string;
  userId: string | null;
  nodeId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface InstallerInfo {
  version: string;
  filename: string;
  size: number;
  sha256: string;
  commit: string | null;
  uploadedAt: string;
}

interface LinkRequest {
  code: string;
  pollToken: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  /** Secret the app puts in the page it opens, for approving without the button (see above). */
  autoKey: string;
  /** Client IP that started the link; automatic approval must come from the same one. */
  ip: string | null;
  /** Set when approved; handed to the app on its next poll, then forgotten. */
  token?: string;
  deviceId?: string;
}

export type PollResult = { status: "pending" } | { status: "expired" } | { status: "approved"; token: string; deviceId: string };

/** Link codes: 8 letters/digits without look-alikes (0/O, 1/I/L), shown as ABCD-EFGH. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** A code lasts this long after the app's last poll... */
const LINK_TTL_MS = 10 * 60_000;
/** ...and never longer than this in all. */
const LINK_MAX_MS = 24 * 60 * 60_000;
/** Unauthenticated link requests are held in memory; this caps how many a stranger can make. */
const MAX_PENDING = 50;
const TOKEN_PREFIX = "ccd_";
/** Don't write last_used_at more often than this per device (every reconnect and upload checks the token). */
const TOUCH_EVERY_MS = 5 * 60_000;

/** An IP we can compare: the in-process "unknown" (tests, no socket) never matches. */
const usableIp = (ip: string | null | undefined) => (ip && ip !== "unknown" ? ip : null);
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Row = { id: string; name: string; user_id: string | null; node_id: string | null; created_at: Date; last_used_at: Date | null };
const toDevice = (r: Row): DesktopDevice => ({
  id: r.id,
  name: r.name,
  userId: r.user_id,
  nodeId: r.node_id,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
});

export class DesktopService {
  private readonly links = new Map<string, LinkRequest>();
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private readonly touched = new Map<string, number>();
  private readonly installerDir: string;

  constructor(
    private readonly pool: pg.Pool,
    options: { dataDir: string; now?: () => number },
  ) {
    this.installerDir = join(options.dataDir, "desktop");
    if (options.now) this.now = options.now;
  }

  private now = () => Date.now();

  private sweep() {
    const now = this.now();
    for (const [code, link] of this.links) if (link.expiresAt <= now) this.links.delete(code);
  }

  // --- linking ---

  /** Starts a link for a computer. Unauthenticated: it only reserves a code. */
  startLink(name: string, ip: string | null = null): { code: string; pollToken: string; autoKey: string; expiresAt: string } {
    this.sweep();
    if (this.links.size >= MAX_PENDING) throw new LinkError("Too many computers are waiting to be linked. Try again in a few minutes.", 429);
    let code: string;
    do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (this.links.has(code));
    const createdAt = this.now();
    const link: LinkRequest = {
      code,
      pollToken: randomBytes(32).toString("base64url"),
      autoKey: randomBytes(24).toString("base64url"),
      ip: usableIp(ip),
      name: name.trim().slice(0, 100) || "Computer",
      createdAt,
      expiresAt: createdAt + LINK_TTL_MS,
    };
    this.links.set(code, link);
    return { code: formatCode(code), pollToken: link.pollToken, autoKey: link.autoKey, expiresAt: new Date(link.expiresAt).toISOString() };
  }

  /** What the approval screen shows. Null for an unknown or expired code. */
  linkInfo(code: string): { code: string; name: string; createdAt: string; approved: boolean } | null {
    this.sweep();
    const link = this.links.get(normalizeCode(code));
    return link ? { code: formatCode(link.code), name: link.name, createdAt: new Date(link.createdAt).toISOString(), approved: !!link.token } : null;
  }

  /**
   * Dave approved the link while signed in: creates the device and its token. With `auto`, the
   * page the app opened approved by itself: allowed only for the app's own key from the app's IP.
   */
  async approve(code: string, userId: string | null, auto?: { key: string; ip: string | null }): Promise<DesktopDevice> {
    this.sweep();
    const link = this.links.get(normalizeCode(code));
    if (!link) throw new LinkError("This link code has expired. Start linking again from the desktop app.", 404);
    if (link.token) throw new LinkError("This computer is already linked.", 409);
    if (auto) {
      const sameIp = link.ip !== null && link.ip === usableIp(auto.ip);
      if (!sameIp || !sameSecret(auto.key, link.autoKey)) {
        throw new LinkError("This computer can't be linked automatically from here. Check the code and press Link this computer.", 403);
      }
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const { rows } = await this.pool.query<Row>(
      `insert into desktop_devices (id, name, user_id, token_hash) values ($1, $2, $3, $4)
       returning id, name, user_id, node_id, created_at, last_used_at`,
      [randomUUID(), link.name, userId, hashToken(token)],
    );
    const row = rows[0]!;
    link.token = token;
    link.deviceId = row.id;
    return toDevice(row);
  }

  /** The app polls with the secret it got from startLink. The token is handed over once. */
  poll(pollToken: string): PollResult {
    this.sweep();
    for (const link of this.links.values()) {
      if (link.pollToken !== pollToken) continue;
      if (!link.token) {
        // The app is still waiting: keep its code alive (up to LINK_MAX_MS in all).
        link.expiresAt = Math.min(this.now() + LINK_TTL_MS, link.createdAt + LINK_MAX_MS);
        return { status: "pending" };
      }
      this.links.delete(link.code);
      return { status: "approved", token: link.token, deviceId: link.deviceId! };
    }
    return { status: "expired" };
  }

  // --- devices ---

  /** The device a worker token belongs to, if it is a live (not unlinked) device token. */
  async verify(token: string | undefined | null): Promise<DesktopDevice | null> {
    if (!token?.startsWith(TOKEN_PREFIX)) return null;
    const { rows } = await this.pool.query<Row>(
      "select id, name, user_id, node_id, created_at, last_used_at from desktop_devices where token_hash = $1 and revoked_at is null",
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const now = this.now();
    if (now - (this.touched.get(row.id) ?? 0) > TOUCH_EVERY_MS) {
      this.touched.set(row.id, now);
      await this.pool.query("update desktop_devices set last_used_at = now() where id = $1", [row.id]);
    }
    return toDevice(row);
  }

  /** Records which worker node a device connected as, so the Devices page can pair them. */
  async setNode(deviceId: string, nodeId: string): Promise<void> {
    await this.pool.query("update desktop_devices set node_id = $2, last_used_at = now() where id = $1", [deviceId, nodeId]);
  }

  async list(): Promise<DesktopDevice[]> {
    const { rows } = await this.pool.query<Row>(
      "select id, name, user_id, node_id, created_at, last_used_at from desktop_devices where revoked_at is null order by created_at desc",
    );
    return rows.map(toDevice);
  }

  /** Unlinks a computer: its token stops working and its live connection is closed. */
  async revoke(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("update desktop_devices set revoked_at = now() where id = $1 and revoked_at is null", [id]);
    if (!rowCount) return false;
    for (const listener of this.revokeListeners) listener(id);
    return true;
  }

  onRevoke(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  // --- installer ---

  installer(): InstallerInfo | null {
    const meta = join(this.installerDir, "installer.json");
    if (!existsSync(meta) || !existsSync(join(this.installerDir, "installer.bin"))) return null;
    try {
      return JSON.parse(readFileSync(meta, "utf8")) as InstallerInfo;
    } catch {
      return null;
    }
  }

  /** The installer file to stream, with its details. */
  installerFile(): { info: InstallerInfo; path: string; size: number } | null {
    const info = this.installer();
    if (!info) return null;
    const path = join(this.installerDir, "installer.bin");
    return { info, path, size: statSync(path).size };
  }

  openInstaller(path: string): Readable {
    return createReadStream(path);
  }

  /** Stores a new installer (from the Desktop GitHub workflow), replacing the previous one. */
  async saveInstaller(body: ReadableStream<Uint8Array>, meta: { version: string; filename: string; commit: string | null }, maxBytes: number): Promise<InstallerInfo> {
    mkdirSync(this.installerDir, { recursive: true });
    const partial = join(this.installerDir, `upload-${randomUUID()}.part`);
    const hash = createHash("sha256");
    let size = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new LinkError(`Installer is larger than ${maxBytes} bytes`, 413));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), count, createWriteStream(partial));
      if (size === 0) throw new LinkError("Empty installer", 400);
      const info: InstallerInfo = { ...meta, size, sha256: hash.digest("hex"), uploadedAt: new Date(this.now()).toISOString() };
      renameSync(partial, join(this.installerDir, "installer.bin"));
      writeFileSync(join(this.installerDir, "installer.json"), `${JSON.stringify(info, null, 2)}\n`);
      return info;
    } finally {
      rmSync(partial, { force: true });
    }
  }
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 429,
  ) {
    super(message);
  }
}
