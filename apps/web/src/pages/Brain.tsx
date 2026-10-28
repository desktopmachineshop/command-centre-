import { type FormEvent, Fragment, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type BrainNote, type BrainNoteVersion } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { Markdown } from "../markdown";
import { go } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton } from "../ui";

type Old = { version: number; frontmatter: Record<string, unknown>; body: string };

const noteHref = (path: string) => `#/brain/${encodeURIComponent(path)}`;

/** Browse, search, edit and restore notes in the brain (Postgres; agents share the same notes). */
export function Brain({ api, path }: { api: Api; path?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ path: string; title: string; snippet?: string }[] | null>(null);
  const [note, setNote] = useState<BrainNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The editor: a new note (version 0) or the open one. */
  const [draft, setDraft] = useState<{ path: string; raw: string; version: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<BrainNoteVersion[] | null>(null);
  const [old, setOld] = useState<Old | null>(null);

  const load = useCallback(() => {
    setError(null);
    setConflict(false);
    setHistory(null);
    setOld(null);
    if (path) {
      setNote(null);
      api.brainNote(path).then(setNote).catch((e: Error) => setError(e.message));
    } else {
      setNote(null);
      api
        .brainList()
        .then((paths) => setResults(paths.map((p) => ({ path: p, title: p }))))
        .catch((e: Error) => setError(e.message));
    }
  }, [api, path]);

  useEffect(() => {
    setDraft(null);
    load();
  }, [load]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (path) go("brain");
    try {
      setResults(query.trim() ? await api.brainSearch(query) : (await api.brainList()).map((p) => ({ path: p, title: p })));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.brainSave(draft.path.trim(), draft.raw, draft.version);
      setDraft(null);
      if (saved.path === path) load();
      else location.hash = noteHref(saved.path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!note || !confirm(`Delete ${note.path}? Its history is kept, so it can be restored.`)) return;
    try {
      await api.brainDelete(note.path, note.version);
      go("brain");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const showHistory = async () => {
    if (!note) return;
    try {
      setHistory(await api.brainHistory(note.path));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const viewVersion = async (version: number) => {
    if (!note) return;
    try {
      setOld({ version, ...(await api.brainVersion(note.path, version)) });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const restore = async (version: number) => {
    if (!note) return;
    try {
      await api.brainRestore(note.path, version);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const editor = draft && (
    <form className="card note-card brain-editor" onSubmit={save}>
      <label className="field">
        <span>Path</span>
        <input
          value={draft.path}
          onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          readOnly={draft.version > 0}
          placeholder="personal/ideas.md"
          required
          pattern=".+\.md"
          aria-describedby="brain-path-hint"
        />
        <span id="brain-path-hint" className="muted small">
          Folder per area (dms, personal, …), ending in .md
        </span>
      </label>
      <label className="field">
        <span>Note</span>
        <textarea
          value={draft.raw}
          onChange={(e) => setDraft({ ...draft, raw: e.target.value })}
          rows={20}
          spellCheck
          placeholder={"---\ntype: note\n---\n\n# Title\n\nWrite in markdown."}
        />
      </label>
      {conflict && (
        <p className="small">
          Someone (or an agent) saved this note after you opened it.{" "}
          <button type="button" className="link" onClick={() => (setDraft(null), load())}>
            Load the latest
          </button>{" "}
          and make your change again.
        </p>
      )}
      <div className="row wrap">
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="ghost" onClick={() => (setDraft(null), setConflict(false), setError(null))}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <section>
      <PageHead title="Brain" sub="Long-term notes shared with the agents. Edit them here; every save is kept in the note's history.">
        {!draft && (
          <button className="primary" onClick={() => setDraft({ path: "", raw: "", version: 0 })}>
            <Icon name="plus" size={18} /> New note
          </button>
        )}
      </PageHead>
      <form className="search-row" onSubmit={search} role="search">
        <span className="search-input">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" aria-label="Search notes" type="search" />
        </span>
        <button>Search</button>
      </form>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {editor ??
        (note ? (
          <article className="card note-card">
            <p className="muted small note-path">
              <a className="back-link" href="#/brain">
                <Icon name="back" size={16} /> All notes
              </a>
              <code>{note.path}</code>
            </p>
            <p className="muted small note-meta">
              Version {note.version} · {note.updatedBy} · {ago(note.updatedAt)}
            </p>
            <div className="row wrap note-actions">
              <button className="ghost" onClick={() => setDraft({ path: note.path, raw: note.raw ?? note.body, version: note.version })}>
                <Icon name="edit" size={16} /> Edit
              </button>
              <button className="ghost" onClick={history ? () => (setHistory(null), setOld(null)) : showHistory} aria-expanded={!!history}>
                <Icon name="clock" size={16} /> History
              </button>
              <button className="ghost danger" onClick={remove}>
                <Icon name="trash" size={16} /> Delete
              </button>
            </div>
            {history && (
              <div className="note-history">
                <ul className="list">
                  {history.map((h) => (
                    <li key={h.version} className="item">
                      <div className="row wrap">
                        <span className="grow small">
                          <strong>v{h.version}</strong> {h.deleted ? "deleted" : (h.message ?? "saved")} · {h.author} · {ago(h.createdAt)}
                        </span>
                        {!h.deleted && (
                          <button className="link" onClick={() => viewVersion(h.version)}>
                            View
                          </button>
                        )}
                        {!h.deleted && h.version !== note.version && (
                          <button className="link" onClick={() => restore(h.version)}>
                            Restore
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {old && (
                  <div className="note-old">
                    <p className="muted small">Version {old.version}</p>
                    <Markdown className="note-body" text={old.body} />
                  </div>
                )}
              </div>
            )}
            <Frontmatter values={note.frontmatter} />
            <Markdown className="note-body" text={note.body} />
          </article>
        ) : path && !error ? (
          <Skeleton rows={4} />
        ) : !path ? (
          <>
            {!results && !error && <Skeleton rows={3} />}
            {results?.length === 0 && <Empty icon="brain">No notes match.</Empty>}
            <ul className="list">
              {results?.map((r) => (
                <li key={r.path} className="item note-row">
                  <a className="item-link" href={noteHref(r.path)}>
                    <div className="title">
                      <Icon name="brain" size={16} />
                      {r.title}
                    </div>
                    {r.snippet && <div className="muted small">{r.snippet}</div>}
                    {r.title !== r.path && <div className="muted small">{r.path}</div>}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null)}
    </section>
  );
}

function Frontmatter({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([k]) => k !== "updated");
  if (entries.length === 0) return null;
  return (
    <dl className="frontmatter">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
