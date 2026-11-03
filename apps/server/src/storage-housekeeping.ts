import { statfs } from "node:fs/promises";
import type { Storage } from "@cc/storage";

/**
 * Keeping the server's volume usable while files live on it (STORAGE_BACKEND=local, e.g. a
 * Railway Hobby volume of 5 GB, until Google Drive is connected):
 * - uploads that would leave less than `minFreeBytes` free are refused (a full disk breaks
 *   Postgres-adjacent work, logs and every other write, not just the upload);
 * - renders older than `renderRetentionDays` are deleted each night, unless a pending approval
 *   still points at them;
 * - a push goes out once a day while the volume is over `warnAtFraction` full.
 * With Drive as the backend, new files don't land on the volume, so the guard and clean-up
 * leave Drive alone (the cache has its own size limit).
 */
export interface HousekeepingOptions {
  dataDir: string;
  minFreeBytes: number;
  /** 0 keeps renders forever. */
  renderRetentionDays: number;
  warnAtFraction?: number;
}

export interface DiskSpace {
  free: number;
  total: number;
}

export async function diskSpace(dir: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null; // not created yet, or a platform without statfs: don't block on it
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Null when an upload of `bytes` fits on the volume with `minFreeBytes` to spare, else why not.
 * `bytes` 0 (size unknown yet) still refuses once the volume is already below the reserve.
 */
export async function uploadRefusal(storage: Pick<Storage, "kind">, o: HousekeepingOptions, bytes: number, space?: DiskSpace | null): Promise<string | null> {
  if (storage.kind !== "local") return null;
  const disk = space === undefined ? await diskSpace(o.dataDir) : space;
  if (!disk) return null;
  if (disk.free - bytes >= o.minFreeBytes) return null;
  return `Storage is full: ${mb(disk.free)} free on the server, and ${mb(o.minFreeBytes)} is kept free. Old renders are deleted after their retention period; for more room, connect Google Drive.`;
}

/** Deletes local renders older than the retention period that no pending approval refers to. */
export async function cleanOldRenders(
  storage: Pick<Storage, "list" | "delete">,
  pendingPayloads: () => Promise<unknown[]>,
  o: Pick<HousekeepingOptions, "renderRetentionDays">,
  now = new Date(),
): Promise<{ deleted: string[]; freedBytes: number; kept: string[] }> {
  const result = { deleted: [] as string[], freedBytes: 0, kept: [] as string[] };
  if (o.renderRetentionDays <= 0) return result;
  const cutoff = now.getTime() - o.renderRetentionDays * 86_400_000;
  const old = (await storage.list("renders", { limit: 1000 })).filter((f) => f.backend === "local" && f.createdAt.getTime() < cutoff);
  if (!old.length) return result;
  // A video waiting for Dave's approval stays, however old: its proposal plays it from /media/<id>.
  const pending = JSON.stringify(await pendingPayloads());
  for (const f of old) {
    if (pending.includes(f.id)) {
      result.kept.push(f.id);
      continue;
    }
    if (await storage.delete(f.id)) {
      result.deleted.push(f.id);
      result.freedBytes += f.size;
    }
  }
  return result;
}

/** The nightly job: clean old renders, then warn when the volume is still nearly full. */
export async function storageHousekeeping(deps: {
  storage: Pick<Storage, "kind" | "list" | "delete">;
  options: HousekeepingOptions;
  pendingPayloads: () => Promise<unknown[]>;
  notify: (n: { title: string; body: string }) => Promise<unknown>;
  now?: Date;
}): Promise<{ deleted: number; freedBytes: number; usedFraction: number | null }> {
  const { storage, options } = deps;
  const cleaned = await cleanOldRenders(storage, deps.pendingPayloads, options, deps.now);
  if (cleaned.deleted.length) console.log(`[storage] deleted ${cleaned.deleted.length} render(s) older than ${options.renderRetentionDays} days, freeing ${mb(cleaned.freedBytes)}`);
  const disk = storage.kind === "local" ? await diskSpace(options.dataDir) : null;
  const usedFraction = disk && disk.total > 0 ? 1 - disk.free / disk.total : null;
  if (usedFraction !== null && usedFraction >= (options.warnAtFraction ?? 0.8)) {
    await deps.notify({
      title: "Server storage nearly full",
      body: `${Math.round(usedFraction * 100)}% used (${mb(disk!.free)} free). Old renders are cleaned up nightly; for more room, connect Google Drive.`,
    });
  }
  return { deleted: cleaned.deleted.length, freedBytes: cleaned.freedBytes, usedFraction };
}
