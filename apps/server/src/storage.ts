import { join } from "node:path";
import {
  createGoogleTokenProvider,
  DiskCache,
  type GoogleTokenProvider,
  GoogleDriveBlobStore,
  LocalBlobStore,
  PgBlobIndex,
  Storage,
} from "@cc/storage";
import type { Config } from "./config";
import type { Pool } from "./db/pool";
import type { VideoMediaStore } from "./video";

/**
 * The server's BlobStore: STORAGE_BACKEND=gdrive puts new files in Google Drive
 * (with an LRU cache on DATA_DIR/cache); otherwise everything stays on the volume.
 * Either way, files already on the volume keep being served from it.
 */
export function createStorage(
  config: Config,
  pool: Pool,
  /** `tokens`: Drive's access tokens; default from config.storage.google (app.ts passes one that follows the Accounts page). */
  options: { fetch?: typeof fetch; tokens?: GoogleTokenProvider } = {},
): Storage {
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
    tokens: options.tokens ?? createGoogleTokenProvider({ ...google, fetch: options.fetch }),
    index,
    fetch: options.fetch,
    cache,
    rootFolderName: config.storage.driveFolder,
  });
  return new Storage({ index, local, drive, cache });
}

/**
 * Storage as the video pipeline's media store: workers PUT renders and captures to
 * a one-shot URL on our server, which streams them into the configured backend,
 * and they are then public at /media/<id>. Needs PUBLIC_BASE_URL (workers are on other PCs).
 */
export function videoMediaFromStorage(storage: Storage, baseUrl: string): VideoMediaStore {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async createUpload(name, contentType) {
      const { id, putUrl } = await storage.reserve({ name, contentType, folder: "renders", baseUrl: base });
      return { putUrl, publicUrl: `${base}/media/${id}` };
    },
    async put(name, bytes, contentType) {
      const info = await storage.put(Buffer.from(bytes), { name, contentType, folder: "renders" });
      return `${base}/media/${info.id}`;
    },
  };
}
