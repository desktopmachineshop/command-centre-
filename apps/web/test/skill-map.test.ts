import { describe, expect, it } from "vitest";
import type { SkillStatus, SkillTreeView, SkillView } from "../src/api";
import {
  ancestorsOf,
  branchIds,
  matches,
  RING,
  skillMap,
  trailTo,
} from "../src/learning/skill-map";

const skill = (
  id: string,
  status: SkillStatus,
  needs: string[] = [],
): SkillView => ({
  id,
  title: id.toUpperCase(),
  why: `why ${id}`,
  needs,
  status,
  lessons: [],
  waitsOn: [],
});

const TREE: SkillTreeView = {
  path: "learning/skill-tree.md",
  tracks: [
    {
      track: "ai",
      name: "AI",
      done: 1,
      taught: 2,
      total: 5,
      levels: [
        {
          name: "Foundations",
          skills: [
            skill("ai.llm", "done"),
            skill("ai.emb", "taught", ["ai.llm"]),
            skill("ai.prompt", "open", ["ai.llm"]),
          ],
        },
        {
          name: "Practitioner",
          skills: [
            skill("ai.rag", "locked", ["ai.emb", "ai.prompt"]),
            skill("ai.ml", "open"),
          ],
        },
      ],
    },
    {
      track: "rob",
      name: "Robotics",
      done: 0,
      taught: 0,
      total: 2,
      levels: [
        {
          name: "Foundations",
          skills: [
            skill("rob.a", "open", ["rob.b"]),
            skill("rob.b", "locked", ["rob.a"]),
          ],
        },
      ],
    },
    { track: "empty", name: "Empty", done: 0, taught: 0, total: 0, levels: [] },
  ],
};

const node = (m: ReturnType<typeof skillMap>, id: string) =>
  m.nodes.find((n) => n.id === id)!;

describe("skillMap", () => {
  it("puts each skill one ring out from what it builds on, under its track's spoke", () => {
    const m = skillMap(TREE);
    expect(m.nodes.map((n) => n.id).sort()).toEqual([
      "ai.emb",
      "ai.llm",
      "ai.ml",
      "ai.prompt",
      "ai.rag",
      "rob.a",
      "rob.b",
      "track:ai",
      "track:rob",
    ]);
    expect(node(m, "track:ai").radius).toBe(RING);
    expect(node(m, "ai.llm")).toMatchObject({
      parent: "track:ai",
      depth: 2,
      descendants: 3,
    });
    expect(node(m, "ai.rag")).toMatchObject({ parent: "ai.emb", depth: 4 });
    expect(node(m, "ai.ml")).toMatchObject({ parent: "track:ai", depth: 2 });
    expect(m).toMatchObject({
      depth: 4,
      size: 4 * RING,
      done: 1,
      taught: 2,
      total: 7,
    });
  });

  it("breaks a loop of prerequisites instead of hanging", () => {
    const m = skillMap(TREE);
    const parents = [node(m, "rob.a").parent, node(m, "rob.b").parent];
    expect(parents).toContain("track:rob");
    expect(m.links).toHaveLength(m.nodes.length);
  });

  it("sits a parent between its children, and keeps tracks apart", () => {
    const m = skillMap(TREE);
    const kids = [node(m, "ai.emb").angle, node(m, "ai.prompt").angle];
    expect(node(m, "ai.llm").angle).toBeCloseTo((kids[0]! + kids[1]!) / 2);
    const ai = m.nodes.filter((n) => n.track === "ai").map((n) => n.angle);
    const rob = m.nodes.filter((n) => n.track === "rob").map((n) => n.angle);
    expect(Math.max(...ai)).toBeLessThan(Math.min(...rob));
  });

  it("lights the branches that are learnt", () => {
    const m = skillMap(TREE);
    const lit = (id: string) => m.links.find((l) => l.id === id)!.lit;
    expect([
      lit("ai.llm"),
      lit("ai.emb"),
      lit("ai.prompt"),
      lit("track:ai"),
      lit("track:rob"),
    ]).toEqual([true, true, false, true, false]);
  });

  it("folds a branch into its node, counting what it hides", () => {
    const m = skillMap(TREE, { folded: new Set(["ai.llm"]) });
    expect(m.nodes.some((n) => n.id === "ai.emb" || n.id === "ai.rag")).toBe(
      false,
    );
    expect(node(m, "ai.llm")).toMatchObject({ folded: true, hidden: 3 });
    expect(
      skillMap(TREE, { folded: new Set(["track:ai"]) })
        .nodes.filter((n) => n.track === "ai")
        .map((n) => n.id),
    ).toEqual(["track:ai"]);
  });

  it("shows only as many layers as asked", () => {
    const m = skillMap(TREE, { layers: 2 });
    expect(Math.max(...m.nodes.map((n) => n.depth))).toBe(2);
    expect(m.size).toBe(2 * RING);
    expect(m.depth).toBe(4);
    expect(node(m, "ai.llm")).toMatchObject({ folded: true, hidden: 3 });
  });

  it("leaves out hidden tracks and empty ones", () => {
    const m = skillMap(TREE, { hiddenTracks: new Set(["rob"]) });
    expect(m.nodes.every((n) => n.track === "ai")).toBe(true);
    expect(m.total).toBe(5);
  });
});

describe("finding your way round the map", () => {
  it("walks from a skill back to the middle", () => {
    expect([...trailTo(skillMap(TREE), "ai.rag")]).toEqual([
      "ai.rag",
      "ai.emb",
      "ai.llm",
      "track:ai",
    ]);
  });

  it("knows what to unfold to show a skill, and every branch to fold", () => {
    expect(ancestorsOf(TREE, "ai.rag")).toEqual([
      "ai.emb",
      "ai.llm",
      "track:ai",
    ]);
    expect(branchIds(TREE).sort()).toEqual(
      [
        "ai.emb",
        "ai.llm",
        "track:ai",
        "track:rob",
        ...(skillMap(TREE).nodes.some((n) => n.parent === "rob.a")
          ? ["rob.a"]
          : ["rob.b"]),
      ].sort(),
    );
  });

  it("matches a search on any of a skill's words, in any order", () => {
    const s = {
      id: "ai.rag",
      title: "Retrieval-augmented generation",
      why: "chunking and reranking",
    };
    expect(matches(s, "Practitioner", "rerank retrieval")).toBe(true);
    expect(matches(s, "Practitioner", "practitioner")).toBe(true);
    expect(matches(s, "Practitioner", "robots")).toBe(false);
    expect(matches(s, "Practitioner", "  ")).toBe(false);
  });
});
