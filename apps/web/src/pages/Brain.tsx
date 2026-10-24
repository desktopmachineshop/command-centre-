import { type FormEvent, Fragment, useEffect, useState } from "react";
import type { Api } from "../api";
import { Icon } from "../icons";
import { go } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton } from "../ui";

/** Browse and search the markdown brain. Editing happens in Obsidian (git) or via agents. */
export function Brain({ api, path }: { api: Api; path?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ path: string; title: string; snippet?: string }[] | null>(null);
  const [note, setNote] = useState<{ path: string; frontmatter: Record<string, unknown>; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (path) {
      api.brainNote(path).then(setNote).catch((e: Error) => setError(e.message));
    } else {
      setNote(null);
      api
        .brainList()
        .then((paths) => setResults(paths.map((p) => ({ path: p, title: p }))))
        .catch((e: Error) => setError(e.message));
    }
  }, [api, path]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (path) go("brain");
    try {
      setResults(query.trim() ? await api.brainSearch(query) : (await api.brainList()).map((p) => ({ path: p, title: p })));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <PageHead title="Brain" sub="The markdown brain. Edit in Obsidian (git) or ask an agent." />
      <form className="search-row" onSubmit={search} role="search">
        <span className="search-input">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" aria-label="Search notes" type="search" />
        </span>
        <button>Search</button>
      </form>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {note ? (
        <article className="card note-card">
          <p className="muted small note-path">
            <a className="back-link" href="#/brain">
              <Icon name="back" size={16} /> All notes
            </a>
            <code>{note.path}</code>
          </p>
          {Object.keys(note.frontmatter).length > 0 && (
            <dl className="frontmatter">
              {Object.entries(note.frontmatter).map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          <div className="note-body">{note.body}</div>
        </article>
      ) : (
        <>
          {!results && !error && <Skeleton rows={3} />}
          {results?.length === 0 && <Empty icon="brain">No notes match.</Empty>}
          <ul className="list">
            {results?.map((r) => (
              <li key={r.path} className="item note-row">
                <a className="item-link" href={`#/brain/${encodeURIComponent(r.path)}`}>
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
      )}
    </section>
  );
}
