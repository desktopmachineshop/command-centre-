import { z } from "zod";
import {
  type AdapterCapabilities,
  type InboundItem,
  type Platform,
  type PlatformAdapter,
  type PostContent,
  type ReplyTarget,
  type SocialAccount,
  SocialAccount as SocialAccountSchema,
  type SocialAccountInput,
  validateAgainstCapabilities,
} from "../src";

export interface FakeAdapter extends PlatformAdapter {
  published: { account: string; content: PostContent }[];
  replies: { account: string; target: ReplyTarget; text: string }[];
  dms: { account: string; userId: string; text: string }[];
  /** Make the next publish calls throw. */
  failPublish: boolean;
}

/** An in-memory adapter: records every call, and needs credentials { token }. */
export function fakeAdapter(platform: Platform, caps: Partial<AdapterCapabilities> = {}, extra: Partial<PlatformAdapter> = {}): FakeAdapter {
  let n = 0;
  const adapter: FakeAdapter = {
    platform,
    capabilities: { publish: true, reply: true, dm: true, inbound: true, media: ["image", "video"], maxTextLength: 280, ...caps },
    credentials: z.object({ token: z.string().min(8, "token must be at least 8 characters") }),
    published: [],
    replies: [],
    dms: [],
    failPublish: false,
    validate(_account, content) {
      return validateAgainstCapabilities(this.capabilities, content);
    },
    async publish(account, content) {
      if (adapter.failPublish) throw new Error(`${platform} is down`);
      adapter.published.push({ account: account.id, content });
      const id = `${platform}-post-${++n}`;
      return { id, url: `https://${platform}.example/${id}` };
    },
    async reply(account, target, text) {
      adapter.replies.push({ account: account.id, target, text });
      return { id: `${platform}-reply-${++n}` };
    },
    async sendDm(account, userId, text) {
      adapter.dms.push({ account: account.id, userId, text });
      return { id: `${platform}-dm-${++n}` };
    },
    ...extra,
  };
  return adapter;
}

export function account(input: Partial<SocialAccountInput> & { id: string; platform: Platform }): SocialAccount {
  return SocialAccountSchema.parse({ vertical: "3dpandme", credentials: { token: "secret-token-1" }, ...input });
}

export function item(id: string, overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id,
    kind: "comment",
    author: { id: "u1", name: "Jane", handle: "jane" },
    text: `Comment ${id}`,
    createdAt: "2026-10-23T10:00:00.000Z",
    replyTarget: { platform: "instagram", kind: "comment", id },
    ...overrides,
  };
}
