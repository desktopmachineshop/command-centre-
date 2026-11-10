import type { Proposal } from "@cc/core";
import { useEffect, useState } from "react";
import type { Api, MediaRef, PostContent, SocialAccount } from "./api";

export const PLATFORM_LABELS: Record<string, string> = {
  discord: "Discord",
  instagram: "Instagram",
  threads: "Threads",
  x: "X",
  reddit: "Reddit",
  "reddit-session": "Reddit (own login)",
  youtube: "YouTube",
};
export const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p;

/** Characters as the server counts them (code points, not UTF-16 units). */
export const charCount = (text: string) => [...text].length;

export const handleLabel = (a: Pick<SocialAccount, "handle" | "id">) =>
  a.handle ? (a.handle.startsWith("@") ? a.handle : `@${a.handle}`) : a.id;

const cache = new WeakMap<Api, Promise<SocialAccount[]>>();

/** The configured social accounts, loaded once per connection. Empty when the server has none. */
export function useSocialAccounts(api: Api): SocialAccount[] {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  useEffect(() => {
    let p = cache.get(api);
    if (!p) {
      p = api.socialAccounts().catch(() => []);
      cache.set(api, p);
    }
    let live = true;
    p.then((a) => live && setAccounts(a));
    return () => {
      live = false;
    };
  }, [api]);
  return accounts;
}

/** "12 / 280", flagged when over the platform's limit. */
export function CharCount({ text, limit }: { text: string; limit?: number }) {
  const n = charCount(text);
  return (
    <span className={`small ${limit && n > limit ? "error" : "muted"}`}>
      {n}
      {limit ? ` / ${limit}` : ""}
    </span>
  );
}

export function MediaThumbs({ media, onRemove }: { media?: MediaRef[]; onRemove?: (i: number) => void }) {
  if (!media?.length) return null;
  return (
    <div className="thumbs">
      {media.map((m, i) => (
        <span key={`${m.url}-${i}`} className="thumb">
          {m.type === "video" ? (
            <video src={m.url} muted playsInline preload="metadata" />
          ) : (
            <img src={m.url} alt={m.alt ?? ""} loading="lazy" />
          )}
          {onRemove && (
            <button type="button" className="thumb-x" aria-label="Remove" onClick={() => onRemove(i)}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** "Private", "Public" or "Private until <time>": what a YouTube upload will be once approved. */
function youtubeVisibility(options: Record<string, unknown> | undefined): string {
  const privacy = typeof options?.privacyStatus === "string" ? options.privacyStatus : "private";
  const at = typeof options?.publishAt === "string" ? options.publishAt : "";
  const label = privacy.charAt(0).toUpperCase() + privacy.slice(1);
  return at ? `${label}, YouTube publishes it at ${new Date(at).toLocaleString()}` : `${label} on YouTube`;
}

/** One platform's post: account, text with its count, media, and where it goes. */
export function PostPreview({
  accountId,
  content,
  accounts,
  extra,
}: {
  accountId: string;
  content: Partial<PostContent> & { text?: string };
  accounts: SocialAccount[];
  extra?: string;
}) {
  const account = accounts.find((a) => a.id === accountId);
  const platform = account?.platform ?? "";
  const text = content.text ?? "";
  const yt = platform === "youtube" ? youtubeVisibility(content.options) : null;
  return (
    <div className={`social-post p-${platform || "unknown"}`}>
      <div className="row between small">
        <strong>
          {platform ? platformLabel(platform) : accountId} <span className="muted">{account ? handleLabel(account) : ""}</span>
        </strong>
        <CharCount text={text} limit={account?.capabilities?.maxTextLength} />
      </div>
      {content.title && <div className="title">{content.title}</div>}
      <div className="prewrap">{text || <span className="muted">(no text)</span>}</div>
      <MediaThumbs media={content.media} />
      {yt && <div className="muted small">{yt}</div>}
      {(content.link || content.target || extra) && (
        <div className="muted small">
          {content.target && <span>→ {platform === "reddit" ? `r/${content.target.replace(/^r\//, "")}` : content.target} </span>}
          {content.link && (
            <a href={content.link} target="_blank" rel="noreferrer">
              {content.link}
            </a>
          )}
          {extra && <span> {extra}</span>}
        </div>
      )}
      {!account && <div className="error small">Unknown account "{accountId}"</div>}
    </div>
  );
}

type AnyPayload = Record<string, any>;

/** The readable body of a social.* proposal, shown above its raw details. */
export function SocialProposalBody({ proposal, accounts }: { proposal: Proposal; accounts: SocialAccount[] }) {
  const p = proposal.payload as AnyPayload;
  switch (proposal.actionType) {
    case "social.campaign":
      return (
        <div className="social-posts">
          <div className="muted small">
            {p.posts?.length ?? 0} post{p.posts?.length === 1 ? "" : "s"} ·{" "}
            {p.publishAt ? `scheduled for ${new Date(p.publishAt).toLocaleString()}` : "publishes when approved"}
          </div>
          {(p.posts as { accountId: string; content: PostContent }[] | undefined)?.map((post, i) => (
            <PostPreview key={i} accountId={post.accountId} content={post.content ?? {}} accounts={accounts} />
          ))}
        </div>
      );
    case "social.post":
      return <PostPreview accountId={p.accountId} content={p.content ?? {}} accounts={accounts} />;
    case "social.reply": {
      const t = p.target ?? {};
      return (
        <PostPreview
          accountId={p.accountId}
          content={{ text: p.text }}
          accounts={accounts}
          extra={`↩ reply to ${t.kind ?? "item"} ${t.id ?? ""}`.trim()}
        />
      );
    }
    case "social.dm":
      return <PostPreview accountId={p.accountId} content={{ text: p.text }} accounts={accounts} extra={`✉ DM to user ${p.userId}`} />;
    default:
      return null;
  }
}
