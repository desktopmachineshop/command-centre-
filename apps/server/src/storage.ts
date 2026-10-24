import { join } from "node:path";
import {
  createGoogleTokenProvider,
  DiskCache,
  GoogleDriveBlobStore,
  LocalBlobStore,
  PgBlobIndex,
  Storage,
} from "@cc/storage";
import type { Config } from "./config";
import type { Pool } from "./db/pool";

/**
 * The server's BlobStore: STORAGE_BACKEND=gdrive puts new files in Google Drive
 * (with an LRU cache on DATA_DIR/cache); otherwise everything stays on the volume.
 * Either way, files already on the volume keep being served from it.
 */
export function createStorage(config: Config, pool: Pool, options: { fetch?: typeof fetch } = {}): Storage {
  const index = new PgBlobIndex(pool);
  const local = new LocalBlobStore({ dataDir: config.dataDir, index });
  const { google } = config.storage;
  if (!google) return new Storage({ index, local });
  const cache =
    config.storage.cacheBytes > 0
      ? new DiskCache(join(config.dataDir, "cache"), config.storage.cacheBytes, {
          onAdd: (id, path) => void index.update(id, { localPath: path }).catch(() => {}),
          onEvict: (id) => void index.update(id, { localPath: null }).catch(() => {}),
        })
      : undefined;
  const drive = new GoogleDriveBlobStore({
    tokens: createGoogleTokenProvider({ ...google, fetch: options.fetch }),
    index,
    fetch: options.fetch,
    cache,
    rootFolderName: config.storage.driveFolder,
  });
  return new Storage({ index, local, drive, cache });
}
