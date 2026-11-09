import type { Card, CardResult } from "@cc/core";
import { createContext, useContext, useEffect, useState } from "react";

/**
 * Cards (docs/CARDS.md): an agent's reply names records in a ```card block; this asks the
 * server for each one and draws them all the same way, whichever integration they come from.
 */

/** How cards are fetched: the app provides the API call; without it (tests, previews) the references are listed. */
export const CardsContext = createContext<((refs: string[]) => Promise<CardResult[]>) | null>(null);

const safeUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);
const safeImage = (url: string | undefined) => (url && /^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(url) ? url : undefined);

export function CardGrid({ refs }: { refs: string[] }) {
  const load = useContext(CardsContext);
  const [results, setResults] = useState<CardResult[] | null>(null);
  const key = refs.join(",");
  useEffect(() => {
    if (!load || !refs.length) return;
    let live = true;
    load(refs).then(
      (r) => live && setResults(r),
      (err) => live && setResults(refs.map((ref) => ({ ref, error: (err as Error).message || "Could not load" }))),
    );
    return () => {
      live = false;
    };
  }, [load, key]);

  if (!refs.length) return null;
  return (
    <div className={`record-cards${refs.length === 1 ? " single" : ""}`}>
      {refs.map((ref, i) => {
        const r = results?.[i];
        if (r && "card" in r) return <RecordCard key={ref} card={r.card} />;
        return (
          <div key={ref} className={`record-card ${r ? "missing" : "loading"}`} aria-busy={!r && !!load}>
            <div className="record-card-body">
              <code className="record-card-ref">{ref}</code>
              <span className="small muted">{r ? r.error : load ? "Loading…" : "Card"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RecordCard({ card }: { card: Card }) {
  const url = safeUrl(card.url);
  const image = safeImage(card.image);
  const integration = card.kind.split(".")[0]!;
  return (
    <article className={`record-card kind-${card.kind.replace(/\./g, "-")}`} data-kind={card.kind}>
      {image ? <img className="record-card-image" src={image} alt="" loading="lazy" /> : <div className="record-card-image placeholder" aria-hidden="true">{card.title.slice(0, 1).toUpperCase()}</div>}
      <div className="record-card-body">
        <header>
          <h4>{card.title}</h4>
          {card.subtitle && <span className="record-card-subtitle">{card.subtitle}</span>}
        </header>
        {card.badges.length > 0 && (
          <div className="record-card-badges">
            {card.badges.map((b) => (
              <span key={b.text} className={`record-badge tone-${b.tone}`}>
                {b.text}
              </span>
            ))}
          </div>
        )}
        {card.facts.length > 0 && (
          <dl className="record-card-facts">
            {card.facts.map((f) => (
              <div key={f.label} className={f.tone ? `tone-${f.tone}` : undefined}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <footer className="small muted">
          <span>{card.footnote ?? integration}</span>
          {url && (
            <a href={url} target="_blank" rel="noreferrer noopener">
              Open in {integration.charAt(0).toUpperCase() + integration.slice(1)}
            </a>
          )}
        </footer>
      </div>
    </article>
  );
}
