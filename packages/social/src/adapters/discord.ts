import { z } from "zod";
import { type PlatformAdapter, validateAgainstCapabilities } from "../types";

// Stub: replaced by the real discord adapter.
const notImplemented = () => Promise.reject(new Error("discord adapter is not implemented yet"));

export const discordAdapter: PlatformAdapter = {
  platform: "discord",
  capabilities: { publish: false, reply: false, dm: false, inbound: false, media: [], maxTextLength: 0 },
  credentials: z.record(z.string(), z.string()),
  validate(_account, content) {
    return validateAgainstCapabilities(this.capabilities, content);
  },
  publish: notImplemented,
  reply: notImplemented,
};
