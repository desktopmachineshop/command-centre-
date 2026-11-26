import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SkillStatus, SkillTreeView } from "../api";
import {
  ancestorsOf,
  branchIds,
  type MapNode,
  matches,
  RING,
  skillMap,
  type TrackSector,
  trailTo,
} from "./skill-map";

/** Room round the outer ring for the labels that point outwards. */
const LABEL_ROOM = { x: 170, y: 170 };
/** How far outside the outer ring the track arcs run. */
const ARC_GAP = 22;
const deg = (rad: number) => (rad * 180) / Math.PI;
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

const STATUSES: { id: SkillStatus; label: string }[] = [
  { id: "done", label: "Done" },
  { id: "taught", label: "Lesson written" },
  { id: "open", label: "Open" },
  { id: "locked", label: "Locked" },
];
const STATUS_WORD: Record<SkillStatus, string> = {
  done: "done",
  taught: "lesson written",
  open: "open, ready to learn",
  locked: "locked",
};

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

/**
 * The skill tree as a radial tree: Dave in the middle, a spoke per track, and each skill out from
 * what it builds on. What's learnt is filled in and its branch lit. Branches fold (tap a track's
 * spoke, or Fold on a skill), the layers shown can be cut back, tracks can be left out, and a
 * search or a status picks skills out: they keep their names and the way back to the middle,
 * and the rest fades. Tapping a skill shows it below (`detail`).
 */
export function SkillMap({
  tree,
  detail,
}: {
  tree: SkillTreeView;
  detail: (skillId: string) => ReactNode;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [hiddenTracks, setHiddenTracks] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [layers, setLayers] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<ReadonlySet<SkillStatus>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const map = useMemo(
    () => skillMap(tree, { folded, hiddenTracks, layers: layers ?? undefined }),
    [tree, folded, hiddenTracks, layers],
  );
  const shownLayers = layers ?? map.depth;
  const tracks = tree.tracks.filter((t) => t.total > 0);
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map]);

  // What the search and the status chips pick out, across the whole tree (folded or not).
  const filtering = query.trim() !== "" || statuses.size > 0;
  const hits = useMemo(() => {
    const out: string[] = [];
    if (!filtering) return out;
    for (const t of tree.tracks) {
      if (hiddenTracks.has(t.track)) continue;
      for (const l of t.levels)
        for (const s of l.skills) {
          if (statuses.size && !statuses.has(s.status)) continue;
          if (query.trim() && !matches(s, l.name, query)) continue;
          out.push(s.id);
        }
    }
    return out;
  }, [tree, hiddenTracks, query, statuses, filtering]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const hiddenHits = hits.filter((id) => !byId.has(id));

  // Lit trails: from each pick-out (and the picked skill) back to the middle.
  const trail = useMemo(() => {
    const out = new Set<string>();
    for (const id of [...hits, ...(picked ? [picked] : [])])
      if (byId.has(id)) for (const t of trailTo(map, id)) out.add(t);
    return out;
  }, [hits, picked, map, byId]);

  const pickedNode = picked ? byId.get(picked) : undefined;
  const unfold = (ids: string[]) =>
    setFolded((f) => new Set([...f].filter((x) => !ids.includes(x))));
  const showAll = (ids: string[]) => {
    unfold(ids.flatMap((id) => ancestorsOf(tree, id)));
    setLayers(null);
  };
  const choose = (n: MapNode) => {
    if (n.kind === "track") return setFolded((f) => toggled(f, n.id));
    if (n.folded) unfold([n.id]);
    setPicked((p) => (p === n.id && !n.folded ? null : n.id));
  };
  const onKey = (e: KeyboardEvent, n: MapNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(n);
    }
  };
  const w = map.size + LABEL_ROOM.x;
  const h = map.size + LABEL_ROOM.y;

  // Names and dots keep their size on screen however small the drawing is: `ink` scales them
  // back up by as much as the drawing is scaled down.
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setDrawn(el.clientWidth));
    ro.observe(el);
    setDrawn(el.clientWidth);
    // Open with "You" in the middle when the map is wider than its frame (a phone).
    const f = frame.current;
    if (f && f.scrollWidth > f.clientWidth)
      f.scrollLeft = (f.scrollWidth - f.clientWidth) / 2;
    return () => ro.disconnect();
  }, []);
  const ink = drawn > 0 ? Math.min(3, Math.max(1, (w * 2) / drawn)) : 1;
  /** Dots grow less than names, so a dense branch stays readable. */
  const dotInk = Math.min(ink, 1.5);

  return (
    <div className="skill-map">
      <div className="skill-map-tools">
        <div className="row map-search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
          />
          {filtering && (
            <span className="small muted" aria-live="polite">
              {hits.length} {hits.length === 1 ? "match" : "matches"}
              {hiddenHits.length > 0 && (
                <>
                  {" "}
                  ({hiddenHits.length} folded){" "}
                  <button
                    className="link small"
                    onClick={() => showAll(hiddenHits)}
                  >
                    Show
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        <div className="row wrap map-chips" role="group" aria-label="Tracks">
          {tracks.map((t) => (
            <button
              key={t.track}
              className={`chip${hiddenTracks.has(t.track) ? "" : " on"}`}
              aria-pressed={!hiddenTracks.has(t.track)}
              onClick={() =>
                setHiddenTracks((h) =>
                  h.size === tracks.length - 1 && !h.has(t.track)
                    ? h
                    : toggled(h, t.track),
                )
              }
            >
              {t.name}{" "}
              <span className="muted">
                {t.taught}/{t.total}
              </span>
            </button>
          ))}
          {hiddenTracks.size > 0 && (
            <button
              className="link small"
              onClick={() => setHiddenTracks(new Set())}
            >
              All tracks
            </button>
          )}
        </div>
        <div
          className="row wrap map-chips"
          role="group"
          aria-label="Pick out by status"
        >
          {STATUSES.map((s) => (
            <button
              key={s.id}
              className={`chip status-chip is-${s.id}${statuses.has(s.id) ? " on" : ""}`}
              aria-pressed={statuses.has(s.id)}
              onClick={() => setStatuses((x) => toggled(x, s.id))}
            >
              <span className="key-dot" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>
        <div className="row wrap map-layers">
          <span className="small muted">Layers</span>
          <div className="row stepper">
            <button
              className="small"
              aria-label="Fewer layers"
              disabled={shownLayers <= 1}
              onClick={() => setLayers(Math.max(1, shownLayers - 1))}
            >
              −
            </button>
            <span className="small" aria-live="polite">
              {shownLayers} of {map.depth}
            </span>
            <button
              className="small"
              aria-label="More layers"
              disabled={shownLayers >= map.depth}
              onClick={() =>
                setLayers(shownLayers + 1 >= map.depth ? null : shownLayers + 1)
              }
            >
              +
            </button>
          </div>
          <button
            className="small"
            onClick={() => setFolded(new Set(branchIds(tree)))}
          >
            Fold all
          </button>
          <button
            className="small"
            disabled={folded.size === 0 && layers === null}
            onClick={() => {
              setFolded(new Set());
              setLayers(null);
            }}
          >
            Unfold all
          </button>
        </div>
      </div>

      <div className="skill-map-frame" ref={frame}>
        <svg
          ref={svg}
          viewBox={`${-w} ${-h} ${w * 2} ${h * 2}`}
          role="group"
          aria-label={`Skill map: ${map.taught} of ${map.total} skills learnt, ${map.done} done`}
          className={filtering ? "is-filtering" : undefined}
        >
          {Array.from({ length: Math.round(map.size / RING) }, (_, i) => (
            <circle key={i} className="ring" r={(i + 1) * RING} />
          ))}
          <g className="links">
            {[
              ...map.links.filter((l) => !l.lit),
              ...map.links.filter((l) => l.lit),
            ].map((l) => (
              <path
                key={l.id}
                d={l.path}
                className={`link${l.lit ? ` is-lit is-${l.status}` : ""}${trail.has(l.id) ? " is-trail" : ""}`}
              />
            ))}
          </g>
          <g className="sectors">
            {map.sectors.map((sec) => (
              <Sector
                key={sec.track}
                sec={sec}
                radius={map.size + ARC_GAP}
                ink={ink}
                dim={
                  filtering &&
                  !map.nodes.some(
                    (n) =>
                      n.track === sec.track &&
                      (hitSet.has(n.id) || trail.has(n.id)),
                  )
                }
              />
            ))}
          </g>
          <g className="centre" transform={`scale(${ink})`}>
            <circle r={34} />
            <text y={-4}>You</text>
            <text y={13} className="sub">
              {map.taught}/{map.total}
            </text>
          </g>
          {map.nodes.map((n) => {
            const on = n.id === picked || n.id === hover;
            const hit = hitSet.has(n.id);
            const dim = filtering && !hit && !trail.has(n.id);
            const learnt =
              n.kind === "skill" &&
              (n.status === "done" || n.status === "taught");
            const name =
              n.kind === "track"
                ? `${n.label}: ${n.taught} of ${n.total} learnt. ${n.folded ? "Unfold" : "Fold"} the track.`
                : `${n.label}, ${STATUS_WORD[n.status]}${n.folded ? `, ${n.hidden} more folded under it` : ""}`;
            return (
              <g
                key={n.id}
                className={`node is-${n.kind === "track" ? "track" : n.status}${on ? " is-on" : ""}${hit ? " is-hit" : ""}${dim ? " is-dim" : ""}${n.folded ? " is-folded" : ""}`}
                transform={`translate(${n.x},${n.y})`}
                role="button"
                tabIndex={0}
                aria-label={name}
                aria-pressed={n.kind === "skill" ? n.id === picked : !n.folded}
                onClick={() => choose(n)}
                onKeyDown={(e) => onKey(e, n)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
              >
                <title>{name}</title>
                <g transform={`scale(${dotInk})`}>
                  <circle className="hit" r={n.kind === "track" ? 16 : 11} />
                  {n.folded && (
                    <circle
                      className="fold-ring"
                      r={n.kind === "track" ? 12 : 9}
                    />
                  )}
                  <circle
                    className="dot"
                    r={n.kind === "track" ? 8 : n.status === "locked" ? 4 : 5.5}
                  />
                  {n.folded && <FoldCount n={n} />}
                </g>
                {n.kind === "skill" &&
                  (on || hit || (!filtering && learnt)) && (
                    <g transform={`scale(${ink})`}>
                      <SkillLabel
                        n={n}
                        strong={on || hit}
                        gap={((n.folded ? 26 : 10) * dotInk) / ink}
                      />
                    </g>
                  )}
              </g>
            );
          })}
        </svg>
      </div>

      {pickedNode && pickedNode.kind === "skill" ? (
        <div className="skill-map-detail">
          <ul className="tree-skills">{detail(pickedNode.id)}</ul>
          <div className="row wrap">
            <span className="small muted">
              {pickedNode.level} ·{" "}
              {tracks.find((t) => t.track === pickedNode.track)?.name}
            </span>
            {pickedNode.descendants > 0 && (
              <button
                className="small"
                onClick={() =>
                  pickedNode.folded
                    ? unfold([pickedNode.id])
                    : setFolded((f) => new Set([...f, pickedNode.id]))
                }
              >
                {pickedNode.folded
                  ? `Unfold its branch (${pickedNode.descendants})`
                  : `Fold its branch (${pickedNode.descendants})`}
              </button>
            )}
            <button className="link small" onClick={() => setPicked(null)}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <p className="small muted">
          Tap a skill to see it, or a track's dot to fold it.
        </p>
      )}
    </div>
  );
}

/** "+n": how many skills a folded node is hiding, set just outside it. */
function FoldCount({ n }: { n: MapNode }) {
  const out = n.kind === "track" ? 20 : 15;
  const x = Math.sin(n.angle) * out;
  const y = -Math.cos(n.angle) * out;
  return (
    <text className="fold-count" x={x} y={y} dy="0.32em" textAnchor="middle">
      +{n.hidden}
    </text>
  );
}

/** A label pointing out along the radius, turned so it never reads upside down. */
function SkillLabel({
  n,
  strong,
  gap,
}: {
  n: Extract<MapNode, { kind: "skill" }>;
  strong: boolean;
  gap: number;
}) {
  const a = deg(n.angle) - 90;
  const left = n.angle > Math.PI;
  // Names run outwards along the radius. A branch's sits just beside its own line, so it doesn't
  // run over the links to its children.
  const out = !n.open;
  return (
    <text
      className={`label${strong ? " is-strong" : ""}`}
      transform={`rotate(${left ? a + 180 : a})`}
      x={left ? -gap : gap}
      dy={out ? "0.32em" : "-0.55em"}
      textAnchor={left ? "end" : "start"}
    >
      {clip(n.label, strong ? 46 : out ? 34 : 26)}
    </text>
  );
}

/** A track's arc round the rim, over the angles its branches span, named along the arc. */
function Sector({
  sec,
  radius,
  ink,
  dim,
}: {
  sec: TrackSector;
  radius: number;
  ink: number;
  dim: boolean;
}) {
  const pt = (a: number, r: number) =>
    `${(r * Math.sin(a)).toFixed(1)},${(-r * Math.cos(a)).toFixed(1)}`;
  const large = sec.end - sec.start > Math.PI ? 1 : 0;
  const mid = (sec.start + sec.end) / 2;
  // Text on the lower half runs anticlockwise (outside the arc) so it reads the right way up.
  const below = mid > Math.PI / 2 && mid < (3 * Math.PI) / 2;
  const tr = below ? radius + 18 * ink : radius + 8 * ink;
  // The name gets at least the arc it needs, even when the track is folded to a sliver.
  const half = Math.max(
    (sec.end - sec.start) / 2,
    ((sec.name.length + 6) * 7.5 * ink) / tr / 2,
  );
  const [from, to] = [mid - half, mid + half];
  const textArc = below
    ? `M${pt(to, tr)}A${tr},${tr} 0 ${half > Math.PI / 2 ? 1 : 0} 0 ${pt(from, tr)}`
    : `M${pt(from, tr)}A${tr},${tr} 0 ${half > Math.PI / 2 ? 1 : 0} 1 ${pt(to, tr)}`;
  const id = `sector-${sec.track}`;
  return (
    <g className={`sector${dim ? " is-dim" : ""}`}>
      <path
        d={`M${pt(sec.start, radius)}A${radius},${radius} 0 ${large} 1 ${pt(sec.end, radius)}`}
      />
      <path id={id} d={textArc} className="text-arc" />
      <text style={{ fontSize: 13 * ink }}>
        <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
          {sec.name}
          <tspan className="sub">
            {" "}
            {sec.taught}/{sec.total}
          </tspan>
        </textPath>
      </text>
    </g>
  );
}
