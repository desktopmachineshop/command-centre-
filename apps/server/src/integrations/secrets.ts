import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Encrypts integration secrets at rest (AES-256-GCM). The key is CREDENTIALS_KEY (64 hex chars)
 * or, without it, a key generated once into DATA_DIR/credentials.key on the volume. The database
 * alone (a backup, a leaked dump) can't decrypt anything.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromKey(hex: string): SecretBox {
    const key = Buffer.from(hex.trim(), "hex");
    if (key.length !== 32) throw new Error("CREDENTIALS_KEY must be 64 hex characters (32 bytes)");
    return new SecretBox(key);
  }

  /** CREDENTIALS_KEY if given, else the key file, created on first use. */
  static async load(options: { key?: string; keyFile: string }): Promise<SecretBox> {
    if (options.key) return SecretBox.fromKey(options.key);
    try {
      return SecretBox.fromKey(await readFile(options.keyFile, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const hex = randomBytes(32).toString("hex");
    await mkdir(dirname(options.keyFile), { recursive: true });
    // wx: never overwrite a key another process just wrote.
    await writeFile(options.keyFile, `${hex}\n`, { flag: "wx", mode: 0o600 }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    await chmod(options.keyFile, 0o600).catch(() => {});
    return SecretBox.fromKey(await readFile(options.keyFile, "utf8"));
  }

  /** `bind` (e.g. "odoo/default") is authenticated with the blob, so it can't be copied onto another entry. */
  seal(values: Record<string, string>, bind = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(bind, "utf8"));
    const ct = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    return ["v2", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  /** Throws SecretsUnreadable when the blob was sealed with another key, for another entry, or was tampered with. */
  open(blob: string, bind = ""): Record<string, string> {
    const [version, iv, tag, ct] = blob.split(":");
    if ((version !== "v1" && version !== "v2") || !iv || !tag || ct === undefined) throw new SecretsUnreadable();
    const tagBytes = Buffer.from(tag, "base64");
    if (tagBytes.length !== 16) throw new SecretsUnreadable();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"), { authTagLength: 16 });
      // v1 (the first deploy) had no binding.
      if (version === "v2") decipher.setAAD(Buffer.from(bind, "utf8"));
      decipher.setAuthTag(tagBytes);
      const json = Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
      return JSON.parse(json) as Record<string, string>;
    } catch {
      throw new SecretsUnreadable();
    }
  }
}

export class SecretsUnreadable extends Error {
  constructor() {
    super("stored secrets can't be decrypted (the credentials key changed?); enter them again");
  }
}

/** What the browser sees instead of a secret. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}
