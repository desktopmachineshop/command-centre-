import { type FormEvent, useState } from "react";
import type { Api, MediaRef, PostContent, ScheduledPost, SocialAccount } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { CharCount, charCount, handleLabel, MediaThumbs, platformLabel } from "../social";
import { Icon } from "../icons";
import { Empty, ErrorBanner, PageHead, Skeleton, Status, VTag } from "../ui";

/** Accounts, the composer, scheduled posts, and recent social activity. */
export function Social({ api, feed }: { api: Api; feed: LiveFeed }) {
  const accounts = useLoad(api.socialAccounts, feed, () => false);
  return (
    <section>
      <PageHead title="Social" sub="Write once, post to several accounts. Nothing goes out until you approve it." />
      {accounts.error && <ErrorBanner>{accounts.error}</ErrorBanner>}
      {!accounts.data && !accounts.error && <Skeleton rows={2} />}
      {accounts.data?.length === 0 && (
        <Empty icon="social">
          No social accounts yet. <a href="#/accounts">Connect Instagram, Threads, X, Reddit, YouTube or Discord</a> in Accounts.
        </Empty>
      )}
      {accounts.data && accounts.data.length > 0 && (
        <div className="social-grid">
          <Composer api={api} accounts={accounts.data} />
          <div>
            <Scheduled api={api} feed={feed} accounts={accounts.data} />
            <Recent api={api} feed={feed} />
            <Accounts accounts={accounts.data} />
          </div>
        </div>
      )}
    </section>
  );
}

function Accounts({ accounts }: { accounts: SocialAccount[] }) {
  return (
    <>
      <div className="section-title">
        <h3>Accounts</h3>
        <a href="#/accounts" className="small">
          Manage
        </a>
      </div>
      <ul className="list">
        {accounts.map((a) => {
          const caps = a.capabilities;
          const can = caps ? (["publish", "reply", "dm"] as const).filter((k) => caps[k]) : [];
          return (
            <li key={a.id} className="card account">
              <div className="row between">
                <strong>
                  {platformLabel(a.platform)} <span className="muted">{handleLabel(a)}</span>
                </strong>
                <VTag id={a.vertical} />
              </div>
              <div className="row wrap small muted caps">
                <code>{a.id}</code>
                {can.map((k) => (
                  <span key={k}>{k}</span>
                ))}
                <span>{a.inbound && a.inboundSupported ? "watching" : "not watching"}</span>
                {caps && <span>{caps.maxTextLength.toLocaleString()} chars</span>}
                {caps?.media.length ? <span>{caps.media.join(" + ")}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Override = { text?: string; target?: string };

const isVideoUrl = (url: string) => /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url);

/** Problems the server would reject, shown before sending. */
function problemsFor(a: SocialAccount, c: PostContent): string[] {
  const caps = a.capabilities;
  if (!caps) return ["no adapter"];
  const out: string[] = [];
  if (!c.text.trim() && !c.media?.length) out.push("needs text or media");
  if (charCount(c.text) > caps.maxTextLength) out.push(`over ${caps.maxTextLength} characters`);
  for (const t of new Set((c.media ?? []).map((m) => m.type))) if (!caps.media.includes(t)) out.push(`no ${t} support`);
  if (caps.requiresMedia && !c.media?.length) out.push("needs an image or video");
  if (caps.requiresTitle && !c.title?.trim()) out.push("needs a title");
  if (caps.requiresTarget && !c.target?.trim()) out.push(a.platform === "reddit" ? "needs a subreddit" : "needs a target");
  return out;
}

/** Writes one campaign (same news, several accounts) and sends it to Approvals as a social.campaign. */
function Composer({ api, accounts }: { api: Api; accounts: SocialAccount[] }) {
  const publishable = accounts.filter((a) => a.capabilities?.publish);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [when, setWhen] = useState("");
  const [media, setMedia] = useState<MediaRef[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const vertical = accounts.find((a) => a.id === selected[0])?.vertical;
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const setOverride = (id: string, patch: Override) => setOverrides((o) => ({ ...o, [id]: { ...o[id], ...patch } }));

  const contentFor = (a: SocialAccount): PostContent => {
    const o = overrides[a.id] ?? {};
    return {
      text: o.text ?? text,
      ...(media.length ? { media } : {}),
      ...(link.trim() ? { link: link.trim() } : {}),
      ...(a.capabilities?.requiresTitle && title.trim() ? { title: title.trim() } : {}),
      ...(o.target?.trim() ? { target: o.target.trim() } : {}),
    };
  };
  const chosen = selected.map((id) => accounts.find((a) => a.id === id)!).filter(Boolean);
  const problems = Object.fromEntries(chosen.map((a) => [a.id, problemsFor(a, contentFor(a))]));
  const ready = title.trim() && chosen.length > 0 && chosen.every((a) => problems[a.id]!.length === 0) && uploading === 0;

  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      setUploading((n) => n + 1);
      try {
        const m = await api.uploadMedia(file, vertical);
        setMedia((list) => [...list, { url: m.url, type: m.type }]);
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const proposal = await api.compose({
        title: title.trim(),
        posts: chosen.map((a) => ({ accountId: a.id, content: contentFor(a) })),
        ...(when ? { publishAt: new Date(when).toISOString() } : {}),
      });
      setSent(proposal.summary);
      setTitle("");
      setText("");
      setLink("");
      setWhen("");
      setMedia([]);
      setOverrides({});
      setSelected([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card composer-card" data-help-pane="social.composer" onSubmit={submit}>
      <div className="card-head">
        <Icon name="plus" />
        <h3>New post</h3>
      </div>
      <label className="field">
        <span className="small muted">Title (for Approvals, and the Reddit and YouTube title)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New video: ER11 collet guide" />
      </label>
      <label className="field">
        <span className="row between small muted">
          <span>Text</span>
          <CharCount text={text} />
        </span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What's new?" />
      </label>
      <label className="field">
        <span className="small muted">Link (optional)</span>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/…" inputMode="url" />
      </label>

      <div className="field">
        <span className="small muted">Media {uploading > 0 && `(uploading ${uploading}…)`}</span>
        <MediaThumbs media={media} onRemove={(i) => setMedia((list) => list.filter((_, j) => j !== i))} />
        <div className="row wrap">
          <input type="file" accept="image/*,video/*" multiple onChange={(e) => void upload(e.target.files).then(() => (e.target.value = ""))} />
        </div>
        <div className="row">
          <input className="grow" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="or paste a public image/video URL" inputMode="url" />
          <button
            type="button"
            disabled={!/^https?:\/\//.test(mediaUrl.trim())}
            onClick={() => {
              const url = mediaUrl.trim();
              setMedia((list) => [...list, { url, type: isVideoUrl(url) ? "video" : "image" }]);
              setMediaUrl("");
            }}
          >
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <span className="small muted">Post to{vertical ? ` (${vertical} accounts)` : ""}</span>
        <div className="chips">
          {publishable.map((a) => (
            <label key={a.id} className={`chip ${selected.includes(a.id) ? "on" : ""} ${vertical && a.vertical !== vertical ? "off" : ""}`}>
              <input
                type="checkbox"
                checked={selected.includes(a.id)}
                disabled={Boolean(vertical && a.vertical !== vertical)}
                onChange={() => toggle(a.id)}
              />
              {platformLabel(a.platform)} {handleLabel(a)}
            </label>
          ))}
        </div>
      </div>

      {chosen.map((a) => {
        const c = contentFor(a);
        const o = overrides[a.id] ?? {};
        return (
          <div key={a.id} className={`social-post p-${a.platform}`}>
            <div className="row between small">
              <strong>
                {platformLabel(a.platform)} <span className="muted">{handleLabel(a)}</span>
              </strong>
              <CharCount text={c.text} limit={a.capabilities?.maxTextLength} />
            </div>
            {a.capabilities?.requiresTarget && (
              <input
                value={o.target ?? ""}
                onChange={(e) => setOverride(a.id, { target: e.target.value })}
                placeholder={a.platform === "reddit" ? "Subreddit, e.g. hobbycnc" : "Channel id"}
              />
            )}
            <details>
              <summary className="small muted">{o.text !== undefined ? "Custom text" : "Customise text"}</summary>
              <textarea
                value={o.text ?? text}
                onChange={(e) => setOverride(a.id, { text: e.target.value })}
                rows={3}
                placeholder={`Text for ${platformLabel(a.platform)}`}
              />
              {o.text !== undefined && (
                <button type="button" className="small" onClick={() => setOverride(a.id, { text: undefined })}>
                  Use the shared text
                </button>
              )}
            </details>
            {problems[a.id]!.length > 0 && <div className="error small">{problems[a.id]!.join(" · ")}</div>}
          </div>
        );
      })}

      <label className="field">
        <span className="small muted">Publish at (optional; empty = as soon as you approve)</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {sent && (
        <p className="small status done note">
          Sent to <a href="#/approvals">Approvals</a>: {sent}
        </p>
      )}
      <div className="composer-foot">
        <span className="muted small">Nothing is posted until you approve it.</span>
        <button className="primary" disabled={!ready || busy}>
          Send for approval
        </button>
      </div>
    </form>
  );
}

function Scheduled({ api, feed, accounts }: { api: Api; feed: LiveFeed; accounts: SocialAccount[] }) {
  const { data, error, reload } = useLoad(api.socialScheduled, feed, (m) => m.type === "proposal.updated");
  const [busy, setBusy] = useState<string | null>(null);
  const cancel = async (p: ScheduledPost) => {
    if (!confirm(`Cancel the ${platformLabel(p.platform)} post "${p.title}"?`)) return;
    setBusy(p.id);
    try {
      await api.cancelScheduled(p.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  };
  if (!data?.length && !error) return null;
  return (
    <>
      <div className="section-title">
        <h3>Scheduled</h3>
        <button type="button" className="ghost small" onClick={() => void reload()}>
          <Icon name="refresh" size={14} />
          Refresh
        </button>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <ul className="list">
        {data?.map((p) => {
          const a = accounts.find((x) => x.id === p.accountId);
          return (
            <li key={p.id} className="card">
              <div className="row between small">
                <span>
                  <strong>{platformLabel(p.platform)}</strong> <span className="muted">{a ? handleLabel(a) : p.accountId}</span>
                </span>
                <Status value={p.status === "published" ? "done" : p.status === "cancelled" ? "rejected" : p.status === "scheduled" ? "pending" : p.status} label={p.status} />
              </div>
              <div className="title">{p.title}</div>
              <div className="small prewrap clip">{p.content.text}</div>
              <MediaThumbs media={p.content.media} />
              <div className="row between small">
                <span className="muted">
                  <Icon name="clock" size={14} /> {new Date(p.publishAt).toLocaleString()}
                </span>
                {p.status === "scheduled" && (
                  <button className="danger-text small" disabled={busy === p.id} onClick={() => void cancel(p)}>
                    Cancel
                  </button>
                )}
                {p.result?.url && (
                  <a href={p.result.url} target="_blank" rel="noreferrer">
                    view post
                  </a>
                )}
              </div>
              {p.result && !p.result.ok && <div className="error small">{p.result.error}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Recent({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { data, error } = useLoad(
    api.socialEvents,
    feed,
    (m) => (m.type === "event.created" && m.event.source === "social") || m.type === "task.updated",
  );
  return (
    <>
      <div className="section-title">
        <h3>Recent</h3>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {data?.length === 0 && <Empty icon="chat">No comments, mentions or messages yet.</Empty>}
      <ul className="list">
        {data?.map((e) => (
          <li key={e.id} className={`item ${e.taskId ? "" : "static"}`}>
            <a className="item-link" href={e.taskId ? `#/task/${e.taskId}` : undefined}>
              <div className="item-top">
                {e.vertical ? <VTag id={e.vertical} /> : <span />}
                {e.taskStatus && <Status value={e.taskStatus} />}
              </div>
              <div className="title">{e.title}</div>
              <div className="muted small">{ago(e.receivedAt)}</div>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
