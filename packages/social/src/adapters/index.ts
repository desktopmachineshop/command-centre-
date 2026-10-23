import type { Platform, PlatformAdapter } from "../types";
import { discordAdapter } from "./discord";
import { instagramAdapter } from "./instagram";
import { redditAdapter } from "./reddit";
import { threadsAdapter } from "./threads";
import { xAdapter } from "./x";

/** One adapter per platform. Each lives in its own file and is developed independently. */
export const adapters: Record<Platform, PlatformAdapter> = {
  discord: discordAdapter,
  instagram: instagramAdapter,
  threads: threadsAdapter,
  x: xAdapter,
  reddit: redditAdapter,
};
