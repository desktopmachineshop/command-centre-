import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isBlobId } from "./types";

export interface CacheStats {
  files: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
}

/**
 * Least-recently-used file cache on the volume (e.g. /data/cache), capped at
 * `maxBytes` (STORAGE_CACHE_MB). Blobs that Meta or YouTube fetch again and again
 * are served from here once warm. Eviction drops the least recently read file;
 * a stream already reading it keeps going (unlink leaves open files readable).
 */
export class DiskCache {
  /** id → size, in least-recently-used-first order (Map keeps insertion order). */
  private readonly entries = new Map<string, number>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private ready: Promise<void> | null = null;

  constructor(
    readonly dir: string,
    readonly maxBytes: number,
    private readonly hooks: { onAdd?: (id: string, path: string) => void; onEvict?: (id: string) => void } = {},
  ) {}

  /** Loads what is already on disk (oldest first by mtime) and trims to the cap. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      const found: { id: string; size: number; at: number }[] = [];
      for (const name of await readdir(this.dir)) {
        const path = join(this.dir, name);
        if (!isBlobId(name)) {
          await rm(path, { force: true }); // a temp file from a crash
          continue;
        }
        const s = await stat(path).catch(() => null);
        if (s?.isFile()) found.push({ id: name, size: s.size, at: s.mtimeMs });
      }
      for (const f of found.sort((a, b) => a.at - b.at)) {
        this.entries.set(f.id, f.size);
        this.bytes += f.size;
      }
      await this.trim();
    })();
    return this.ready;
  }

  pathOf(id: string): string {
    if (!isBlobId(id)) throw new Error(`invalid blob id ${id}`);
    return join(this.dir, id);
  }

  /** The cached file's path, marking it most recently used; null on a miss. */
  async lookup(id: string): Promise<string | null> {
    await this.init();
    const size = this.entries.get(id);
    if (size === undefined) {
      this.misses++;
      return null;
    }
    this.entries.delete(id);
    this.entries.set(id, size);
    this.hits++;
    return this.pathOf(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Whether a file this big is worth caching (at most a quarter of the cache, so one file can't flush it). */
  fits(size: number): boolean {
    return size > 0 && size <= this.maxBytes / 4;
  }

  /** Writes a stream into the cache. Resolves false (and stores nothing) if it is too big or fails. */
  async fill(id: string, source: Readable, expectedSize?: number): Promise<boolean> {
    await this.init();
    if (expectedSize !== undefined && !this.fits(expectedSize)) {
      source.resume();
      return false;
    }
    const tmp = join(this.dir, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await pipeline(source, createWriteStream(tmp));
      const { size } = await stat(tmp);
      if (!this.fits(size) || (expectedSize !== undefined && size !== expectedSize)) {
        await rm(tmp, { force: true });
        return false;
      }
      await this.adoptFile(id, tmp, size);
      return true;
    } catch {
      await rm(tmp, { force: true });
      return false;
    }
  }

  /** Moves an existing file (same filesystem) into the cache. */
  async adopt(id: string, path: string): Promise<boolean> {
    await this.init();
    const s = await stat(path).catch(() => null);
    if (!s?.isFile() || !this.fits(s.size)) return false;
    await this.adoptFile(id, path, s.size);
    return true;
  }

  private async adoptFile(id: string, path: string, size: number) {
    await rename(path, this.pathOf(id));
    const old = this.entries.get(id);
    if (old !== undefined) this.bytes -= old;
    this.entries.delete(id);
    this.entries.set(id, size);
    this.bytes += size;
    this.hooks.onAdd?.(id, this.pathOf(id));
    await this.trim();
  }

  async evict(id: string): Promise<void> {
    await this.init();
    await this.drop(id);
  }

  private async drop(id: string): Promise<void> {
    const size = this.entries.get(id);
    if (size === undefined) return;
    this.entries.delete(id);
    this.bytes -= size;
    await rm(this.pathOf(id), { force: true });
    this.hooks.onEvict?.(id);
  }

  private async trim() {
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      await this.drop(oldest);
    }
  }

  stats(): CacheStats {
    return { files: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes, hits: this.hits, misses: this.misses };
  }

  /** Oldest (least recently used) first. */
  ids(): string[] {
    return [...this.entries.keys()];
  }
}

