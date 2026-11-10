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
import type { MediaTags, VideoMediaStore } from "./video";

/** A production's tags as storage stores them; a spec product that isn't a vertical id stays shared. */
const verticalTags = (t?: MediaTags) => (t ? { vertical: /^[a-z0-9][a-z0-9-]{0,39}$/.test(t.vertical) ? t.vertical : null, work: t.work, wip: t.wip } : {});

/**
 * The server's BlobStore: STORAGE_BACKEND=gdrive puts new files in Google Drive
 * (with an LRU cache on DATA_DIR/cache); otherwise everything stays on the volume.
 * Either way, files already on the volume keep being served from it.
 */
export function createStorage(
  config: Config,
  pool: Pool,
  /**
   * `tokens`: Drive's access tokens; default from config.storage.google (app.ts passes one that follows the Accounts page).
   * `verticalName`: a vertical's display name, for its Drive folder.
   */
  options: { fetch?: typeof fetch; tokens?: GoogleTokenProvider; verticalName?: (id: string) => string } = {},
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
    verticalFolderName: options.verticalName,
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
    async createUpload(name, contentType, tags) {
      const { id, putUrl } = await storage.reserve({ name, contentType, folder: "renders", baseUrl: base, ...verticalTags(tags) });
      return { putUrl, publicUrl: `${base}/media/${id}` };
    },
    async put(name, bytes, contentType, tags) {
      const info = await storage.put(Buffer.from(bytes), { name, contentType, folder: "renders", ...verticalTags(tags) });
      return `${base}/media/${info.id}`;
    },
    async remove(url) {
      // Only our own files: a spec's music or image URL elsewhere is not ours to delete.
      if (!url.startsWith(`${base}/media/`)) return false;
      return storage.delete(decodeURIComponent(url.slice(`${base}/media/`.length)));
    },
  };
}
