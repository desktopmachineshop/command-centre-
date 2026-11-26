import type { SkillStatus, SkillTreeView, SkillView } from "../api";

/**
 * The skill tree as a radial tree: Dave in the middle, a spoke per track, and each skill one step
 * further out than the skill it builds on (its first prerequisite in the same track; the track
 * itself when it has none). Leaves get equal slices of the circle and each parent sits in the
 * middle of its children, so a track's branches fan out from its spoke. A folded branch, or one
 * past the layers shown, takes the room of one leaf. Pure.
 */

interface Base {
  id: string;
  label: string;
  track: string;
  /** The node it hangs off: null for a track's spoke. */
  parent: string | null;
  /** Ring: 1 for the track spokes, then one more per step out. */
  depth: number;
  /** Skills under it, shown or not. */
  descendants: number;
  /** Skills under it hidden by a fold or the layer limit. */
  hidden: number;
  folded: boolean;
  /** Whether its children are drawn (it has some and they aren't folded away). */
  open: boolean;
  x: number;
  y: number;
  angle: number;
  radius: number;
}
export type MapNode =
  | (Base & { kind: "track"; done: number; taught: number; total: number })
  | (Base & {
      kind: "skill";
      level: string;
      skill: SkillView;
      status: SkillStatus;
    });

export interface MapLink {
  /** The outer end's id: one link per node shown. */
  id: string;
  path: string;
  /** Whether the outer end is learnt (a lesson on it written or done; a track with any). */
  lit: boolean;
  status: SkillStatus | "track";
}

export interface TrackSector {
  track: string;
  name: string;
  /** Angles (radians clockwise from the top) the track's branches span. */
  start: number;
  end: number;
  taught: number;
  total: number;
}

export interface SkillMap {
  nodes: MapNode[];
  sectors: TrackSector[];
  links: MapLink[];
  /** The outermost ring shown: the drawing spans -size..size, before labels. */
  size: number;
  /** The deepest ring in the whole tree, folded or not. */
  depth: number;
  done: number;
  taught: number;
  total: number;
}

export interface MapOptions {
  /** Ids of nodes (track spokes are `track:<id>`) whose branches are folded away. */
  folded?: ReadonlySet<string>;
  /** Tracks left out. */
  hiddenTracks?: ReadonlySet<string>;
  /** The outermost ring to show (1: just the tracks); more is folded. */
  layers?: number;
}

/** The radius of each ring: the track spokes, then each step out. */
export const RING = 80;
/** Empty space kept between tracks, as a share of a leaf's slice. */
const TRACK_GAP = 1;

interface Branch {
  id: string;
  parent: string | null;
  children: Branch[];
  depth: number;
  angle: number;
  descendants: number;
  node: NodeData;
}

type Own = "id" | "label" | "track";
type NodeData =
  | (Pick<Base, Own> & {
      kind: "track";
      done: number;
      taught: number;
      total: number;
    })
  | (Pick<Base, Own> & {
      kind: "skill";
      level: string;
      skill: SkillView;
      status: SkillStatus;
    });

const polar = (angle: number, radius: number): [number, number] => [
  radius * Math.sin(angle),
  -radius * Math.cos(angle),
];
const round = (n: number) => Math.round(n * 10) / 10;

/** A curve from the inner end to the outer one that leaves and arrives along the radius. */
function radialLink(
  a: { angle: number; radius: number },
  b: { angle: number; radius: number },
): string {
  const mid = (a.radius + b.radius) / 2;
  const [x0, y0] = polar(a.angle, a.radius);
  const [x1, y1] = polar(a.angle, mid);
  const [x2, y2] = polar(b.angle, mid);
  const [x3, y3] = polar(b.angle, b.radius);
  return `M${round(x0)},${round(y0)}C${round(x1)},${round(y1)} ${round(x2)},${round(y2)} ${round(x3)},${round(y3)}`;
}

/** Each track's spoke and the skills under it, as branches. */
function grow(
  tree: SkillTreeView,
  hiddenTracks: ReadonlySet<string>,
): Branch[] {
  const roots: Branch[] = [];
  for (const t of tree.tracks) {
    if (t.total === 0 || hiddenTracks.has(t.track)) continue;
    const hubId = `track:${t.track}`;
    const hub: Branch = {
      id: hubId,
      parent: null,
      children: [],
      depth: 1,
      angle: 0,
      descendants: 0,
      node: {
        kind: "track",
        id: hubId,
        label: t.name,
        track: t.track,
        done: t.done,
        taught: t.taught,
        total: t.total,
      },
    };
    roots.push(hub);
    const skills = t.levels.flatMap((l) =>
      l.skills.map((s) => ({ s, level: l.name })),
    );
    const inTrack = new Map(skills.map(({ s }) => [s.id, s]));
    // A skill hangs off its first prerequisite in this track, unless that would loop back to it.
    const parentOf = new Map<string, string | null>();
    const resolve = (id: string, path: Set<string>): void => {
      if (parentOf.has(id)) return;
      const need =
        inTrack.get(id)!.needs.find((n) => inTrack.has(n) && !path.has(n)) ??
        null;
      parentOf.set(id, null); // provisional, so a loop back here stops
      if (need) resolve(need, new Set([...path, id]));
      // The prerequisite must not hang (however far in) off this skill.
      let up = need;
      while (up && up !== id) up = parentOf.get(up) ?? null;
      parentOf.set(id, up === id ? null : need);
    };
    for (const { s } of skills) resolve(s.id, new Set([s.id]));
    const branches = new Map<string, Branch>(
      skills.map(({ s, level }) => [
        s.id,
        {
          id: s.id,
          parent: null,
          children: [],
          depth: 0,
          angle: 0,
          descendants: 0,
          node: {
            kind: "skill",
            id: s.id,
            label: s.title,
            track: t.track,
            level,
            skill: s,
            status: s.status,
          },
        },
      ]),
    );
    for (const { s } of skills) {
      const p = parentOf.get(s.id);
      const b = branches.get(s.id)!;
      b.parent = p ?? hubId;
      (p ? branches.get(p)! : hub).children.push(b);
    }
  }
  const settle = (b: Branch, depth: number): number => {
    b.depth = depth;
    b.descendants = b.children.reduce(
      (n, c) => n + 1 + settle(c, depth + 1),
      0,
    );
    return b.descendants;
  };
  for (const r of roots) settle(r, 1);
  return roots;
}

export function skillMap(tree: SkillTreeView, opts: MapOptions = {}): SkillMap {
  const folded = opts.folded ?? new Set<string>();
  const roots = grow(tree, opts.hiddenTracks ?? new Set());
  const deepest = (b: Branch): number =>
    Math.max(b.depth, ...b.children.map(deepest));
  const depth = Math.max(1, ...roots.map(deepest));
  const layers = Math.max(1, Math.min(opts.layers ?? depth, depth));
  /** Whether a branch's children are shown. */
  const open = (b: Branch) =>
    b.children.length > 0 && !folded.has(b.id) && b.depth < layers;

  // Leaves in order round the circle, with a gap between tracks.
  const leaves = (b: Branch): number =>
    open(b) ? b.children.reduce((n, c) => n + leaves(c), 0) : 1;
  const slots =
    roots.reduce((n, r) => n + leaves(r), 0) + TRACK_GAP * roots.length;
  const slice = (2 * Math.PI) / Math.max(1, slots);
  let cursor = (TRACK_GAP / 2) * slice;
  const place = (b: Branch): number => {
    if (!open(b)) {
      b.angle = cursor + slice / 2;
      cursor += slice;
    } else {
      const angles = b.children.map(place);
      b.angle = (angles[0]! + angles.at(-1)!) / 2;
    }
    return b.angle;
  };
  for (const r of roots) {
    place(r);
    cursor += TRACK_GAP * slice;
  }

  const nodes: MapNode[] = [];
  const links: MapLink[] = [];
  let shown = 1;
  const emit = (b: Branch, from: { angle: number; radius: number }) => {
    const radius = b.depth * RING;
    shown = Math.max(shown, b.depth);
    const [x, y] = polar(b.angle, radius);
    const isOpen = open(b);
    nodes.push({
      ...b.node,
      parent: b.parent,
      depth: b.depth,
      descendants: b.descendants,
      hidden: isOpen ? 0 : b.descendants,
      open: isOpen,
      folded: !isOpen && b.descendants > 0,
      x: round(x),
      y: round(y),
      angle: b.angle,
      radius,
    } as MapNode);
    const n = b.node;
    const lit =
      n.kind === "track"
        ? n.taught > 0
        : n.status === "done" || n.status === "taught";
    links.push({
      id: b.id,
      path:
        from.radius === 0
          ? `M0,0L${round(x)},${round(y)}`
          : radialLink(from, { angle: b.angle, radius }),
      lit,
      status: n.kind === "track" ? "track" : n.status,
    });
    if (isOpen) for (const c of b.children) emit(c, { angle: b.angle, radius });
  };
  for (const r of roots) emit(r, { angle: 0, radius: 0 });

  const tracks = tree.tracks.filter(
    (t) => t.total > 0 && !opts.hiddenTracks?.has(t.track),
  );
  const sectors: TrackSector[] = roots.map((r) => {
    const angles = nodes
      .filter((n) => n.track === r.node.track)
      .map((n) => n.angle);
    const lo = Math.min(...angles) - slice * 0.4;
    const hi = Math.max(...angles) + slice * 0.4;
    const n = r.node as Extract<NodeData, { kind: "track" }>;
    return {
      track: n.track,
      name: n.label,
      start: lo,
      end: hi,
      taught: n.taught,
      total: n.total,
    };
  });
  return {
    nodes,
    sectors,
    links,
    size: shown * RING,
    depth,
    done: tracks.reduce((n, t) => n + t.done, 0),
    taught: tracks.reduce((n, t) => n + t.taught, 0),
    total: tracks.reduce((n, t) => n + t.total, 0),
  };
}

/** The ids of a node and every node between it and the middle. */
export function trailTo(map: Pick<SkillMap, "nodes">, id: string): Set<string> {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  let at: string | null | undefined = id;
  while (at && byId.has(at) && !out.has(at)) {
    out.add(at);
    at = byId.get(at)!.parent;
  }
  return out;
}

/** Every branch id with children (spokes and skills), for "fold all". */
export function branchIds(tree: SkillTreeView): string[] {
  const out: string[] = [];
  const walk = (b: Branch) => {
    if (b.children.length) out.push(b.id);
    for (const c of b.children) walk(c);
  };
  for (const r of grow(tree, new Set())) walk(r);
  return out;
}

/** The branch a hidden skill sits under: the ids to unfold so it shows. */
export function ancestorsOf(tree: SkillTreeView, id: string): string[] {
  const parent = new Map<string, string | null>();
  const walk = (b: Branch) => {
    parent.set(b.id, b.parent);
    for (const c of b.children) walk(c);
  };
  for (const r of grow(tree, new Set())) walk(r);
  const out: string[] = [];
  let at = parent.get(id) ?? null;
  while (at) {
    out.push(at);
    at = parent.get(at) ?? null;
  }
  return out;
}

/** Whether a skill matches a search: words in its title, why, id or level, in any order. */
export function matches(
  skill: Pick<SkillView, "id" | "title" | "why">,
  level: string,
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = `${skill.title} ${skill.why} ${skill.id} ${level}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
