import { type FormEvent, useEffect, useState } from "react";
import type { Api } from "../api";
import { go } from "../router";

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
      <h2>Brain</h2>
      <form className="row" onSubmit={search}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" className="grow" />
        <button>Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      {note ? (
        <article className="card">
          <p className="muted small">
            <a onClick={() => go("brain")}>← all notes</a> · {note.path}
          </p>
          {Object.keys(note.frontmatter).length > 0 && <pre className="small">{JSON.stringify(note.frontmatter, null, 2)}</pre>}
          <div className="prewrap">{note.body}</div>
        </article>
      ) : (
        <ul className="list">
          {results?.map((r) => (
            <li key={r.path} className="item" onClick={() => go(`brain/${encodeURIComponent(r.path)}`)}>
              <div className="title">{r.title}</div>
              {r.snippet && <div className="muted small">{r.snippet}</div>}
              {r.title !== r.path && <div className="muted small">{r.path}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
