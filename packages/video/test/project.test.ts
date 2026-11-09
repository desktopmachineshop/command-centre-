import { describe, expect, it } from "vitest";
import { applyPatch, assetKeys, canonical, captureKey, composeKey, describeChanges, hashOf, parseSpec, PatchError, pinCaptureViewports, planRevision, type RevisionPlan, type VideoSpec, voiceKey } from "../src";
import { minimalSpec } from "./helpers";

const base = parseSpec(
  minimalSpec({
    voice: { provider: "elevenlabs", voiceId: "rachel" },
    scenes: [
      { id: "hook", kind: "title", heading: "Docs that ship", narration: "Ship docs faster." },
      { id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://docs.opend.app/" }, { action: "click", selector: "#edit" }], narration: "Here is the editor." },
      { id: "save", kind: "capture", steps: [{ action: "goto", url: "https://docs.opend.app/" }, { action: "highlight", selector: "#save" }], narration: "Save and it is live." },
      { id: "shot", kind: "image", url: "https://example.com/a.png", alt: "diagram" },
      { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it", narration: "Try OpenD." },
    ],
  }),
);

/** The pool and rendered key a project has after `spec` was fully produced. */
function produced(spec: VideoSpec) {
  const plan = planRevision({ spec, pool: [] });
  return { pool: Object.values(plan.assets).flatMap((k) => [k.voice, k.capture].filter((x): x is string => !!x)), renderedComposeKey: plan.composeKey };
}
const revise = (patch: Parameters<typeof applyPatch>[1], from = base): RevisionPlan => planRevision({ spec: applyPatch(from, patch), ...produced(from) });
const work = (p: RevisionPlan) => ({ voice: p.voice.make, capture: p.capture.make, compose: p.compose });

describe("asset keys", () => {
  it("hashes canonically: key order and undefined don't matter", () => {
    expect(canonical({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(hashOf("x")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keys a narration by its text and voice only", () => {
    const [hook, demo] = base.scenes;
    expect(voiceKey(base, hook!)).toBe(voiceKey(base, { narration: "  Ship docs faster. " }));
    expect(voiceKey(base, hook!)).not.toBe(voiceKey(base, demo!));
    expect(voiceKey(base, { narration: undefined })).toBeNull();
    expect(voiceKey({ voice: { ...base.voice, speed: 1.1 } }, hook!)).not.toBe(voiceKey(base, hook!));
    expect(voiceKey({ voice: { ...base.voice, voiceId: "adam" } }, hook!)).not.toBe(voiceKey(base, hook!));
    expect(voiceKey(base, hook!, "eleven_flash")).not.toBe(voiceKey(base, hook!));
  });

  it("keys a recording by its steps, viewport, cursor and profile; the accent colour only when something is highlighted", () => {
    const demo = base.scenes[1] as Extract<VideoSpec["scenes"][number], { kind: "capture" }>;
    const save = base.scenes[2] as typeof demo;
    const key = captureKey(base, demo);
    expect(captureKey(base, { ...demo, narration: "Different words", id: "other", fit: "cover", clip: { startSec: 1 } })).toBe(key);
    expect(captureKey(base, { ...demo, steps: [...demo.steps, { action: "wait", ms: 500 }] })).not.toBe(key);
    expect(captureKey(base, { ...demo, cursor: false })).not.toBe(key);
    expect(captureKey(base, { ...demo, authProfile: "opend-demo" })).not.toBe(key);
    expect(captureKey({ ...base, format: "16:9" }, demo)).not.toBe(key);
    expect(captureKey({ ...base, format: "16:9" }, { ...demo, viewport: { width: 540, height: 960 } })).toBe(captureKey(base, { ...demo, viewport: { width: 540, height: 960 } }));
    const recoloured = { ...base, brand: { ...base.brand, colours: { ...base.brand.colours, accent: "#00ff00" } } };
    expect(captureKey(recoloured, demo)).toBe(key);
    expect(captureKey(recoloured, save)).not.toBe(captureKey(base, save));
  });

  it("keys the composition by everything drawn or heard, not by the title or sources", () => {
    const keys = assetKeys(base);
    const key = composeKey(base, keys);
    expect(composeKey({ ...base, title: "Renamed", sources: [{ tool: "t", ref: "r" }] }, keys)).toBe(key);
    expect(composeKey({ ...base, format: "16:9" }, keys)).not.toBe(key);
    expect(composeKey(base, keys, { encoder: "gpu" })).not.toBe(key);
    expect(composeKey(base, { ...keys, hook: { voice: "other" } })).not.toBe(key);
  });
});

describe("planRevision: what needs regenerating", () => {
  it("makes everything for a new project, once per distinct asset", () => {
    const plan = planRevision({ spec: base, pool: [] });
    expect(plan.voice).toEqual({ reuse: [], make: ["hook", "demo", "save", "cta"], ephemeral: [] });
    expect(plan.capture).toEqual({ reuse: [], make: ["demo", "save"] });
    expect(plan.compose).toBe(true);
    expect(plan.summary).toBe("Re-renders with new voice for hook, demo, save, cta; re-records demo, save.");

    const twin = applyPatch(base, { scenes: [{ op: "add", scene: { ...base.scenes[1], id: "demo-again" } }] });
    const twice = planRevision({ spec: twin, pool: [] });
    expect(twice.voice.make).toEqual(["hook", "demo", "save", "cta"]);
    expect(twice.voice.reuse).toEqual(["demo-again"]);
    expect(twice.capture).toEqual({ make: ["demo", "save"], reuse: ["demo-again"] });
  });

  it("does nothing when nothing drawn or heard changed", () => {
    const same = planRevision({ spec: base, ...produced(base) });
    expect(work(same)).toEqual({ voice: [], capture: [], compose: false });
    expect(same.summary).toBe("Nothing to render: this version is already rendered.");
    expect(work(revise({ set: { title: "A better title", sources: [{ tool: "opend.read_topic", ref: "edit" }] } }))).toEqual({ voice: [], capture: [], compose: false });
    // video.rerender: the same spec, rendered again.
    expect(work(planRevision({ spec: base, ...produced(base), force: true }))).toEqual({ voice: [], capture: [], compose: true });
    expect(work(planRevision({ spec: base, ...produced(base), output: { encoder: "cpu", preset: "slow" } }))).toEqual({ voice: [], capture: [], compose: true });
  });

  it("re-voices only the scene whose narration changed", () => {
    const plan = revise({ scenes: [{ op: "update", id: "hook", set: { narration: "Docs, shipped." } }] });
    expect(work(plan)).toEqual({ voice: ["hook"], capture: [], compose: true });
    expect(plan.voice.reuse).toEqual(["demo", "save", "cta"]);
    expect(plan.capture.reuse).toEqual(["demo", "save"]);
    expect(plan.summary).toBe("Re-renders with new voice for hook; re-uses 3 of 4 narrations and 2 of 2 recordings.");
  });

  it("re-records only the capture scene whose steps changed", () => {
    const demo = base.scenes[1] as Extract<VideoSpec["scenes"][number], { kind: "capture" }>;
    const plan = revise({ scenes: [{ op: "update", id: "demo", set: { steps: [...demo.steps, { action: "wait", ms: 800 }] } }] });
    expect(work(plan)).toEqual({ voice: [], capture: ["demo"], compose: true });
    expect(plan.capture.reuse).toEqual(["save"]);
    expect(work(revise({ scenes: [{ op: "update", id: "demo", set: { authProfile: "opend-demo" } }] }))).toEqual({ voice: [], capture: ["demo"], compose: true });
  });

  it("only re-composes for text, captions, typography, order, trims, timing, music, brand colours and removed scenes", () => {
    const composeOnly = { voice: [], capture: [], compose: true };
    const edits: Parameters<typeof applyPatch>[1][] = [
      { scenes: [{ op: "update", id: "hook", set: { heading: "Ship docs in minutes", subheading: "No build step" } }] },
      { scenes: [{ op: "update", id: "cta", set: { cta: "Start free", url: "opend.app" } }] },
      { set: { captions: { style: "plain", maxChars: 24, background: "box" } } },
      { set: { captions: { enabled: false } } },
      { set: { brand: { fonts: { heading: "Poppins" }, colours: { primary: "#112233" } } } },
      { set: { music: { url: "https://example.com/track.mp3", volumeDb: -22 } } },
      { set: { transition: { style: "cut" } } },
      { set: { fps: 25 } },
      { order: ["hook", "save", "demo", "shot", "cta"] },
      { scenes: [{ op: "move", id: "shot", after: "hook" }] },
      { scenes: [{ op: "update", id: "demo", set: { clip: { startSec: 1, endSec: 4 }, fit: "cover" } }] },
      { scenes: [{ op: "update", id: "demo", set: { minDurationSec: 6, leadInSec: 0.1, tailSec: 1 } }] },
      { scenes: [{ op: "remove", id: "shot" }] },
      { scenes: [{ op: "remove", id: "save" }] },
      { scenes: [{ op: "add", scene: { id: "why", kind: "slide", heading: "Why", bullets: ["Fast", "Reviewed"] }, after: "hook" }] },
      { scenes: [{ op: "add", scene: { id: "pic", kind: "image", url: "https://example.com/b.png", alt: "b" }, before: "cta" }] },
      { scenes: [{ op: "update", id: "shot", set: { url: "https://example.com/new.png", kenBurns: false } }] },
    ];
    for (const patch of edits) expect(work(revise(patch)), JSON.stringify(patch)).toEqual(composeOnly);
    expect(revise(edits[0]!).summary).toBe("Re-renders only, re-using 4 of 4 narrations and 2 of 2 recordings: no new voice or recording.");
  });

  it("re-voices everything when the voice changes, and re-records what a new accent colour is drawn into", () => {
    expect(work(revise({ set: { voice: { voiceId: "adam" } } }))).toEqual({ voice: ["hook", "demo", "save", "cta"], capture: [], compose: true });
    expect(work(revise({ set: { voice: { speed: 1.1 } } })).voice).toHaveLength(4);
    // Only "save" highlights an element, in the accent colour.
    expect(work(revise({ set: { brand: { colours: { accent: "#ff00aa" } } } }))).toEqual({ voice: [], capture: ["save"], compose: true });
  });

  it("re-records for a new format unless the old recordings are kept", () => {
    const wide = applyPatch(base, { set: { format: "16:9" } });
    expect(work(planRevision({ spec: wide, ...produced(base) }))).toEqual({ voice: [], capture: ["demo", "save"], compose: true });
    const pinned = pinCaptureViewports(base, wide);
    expect(pinned.scenes[1]).toMatchObject({ viewport: { width: 540, height: 960 } });
    expect(work(planRevision({ spec: pinned, ...produced(base) }))).toEqual({ voice: [], capture: [], compose: true });
    expect(pinCaptureViewports(base, base)).toBe(base);
  });

  it("finds an earlier revision's assets again: going back costs nothing", () => {
    const first = produced(base);
    const edited = applyPatch(base, { scenes: [{ op: "update", id: "hook", set: { narration: "Docs, shipped." } }] });
    const second = planRevision({ spec: edited, ...first });
    const pool = [...first.pool, second.assets.hook!.voice!];
    // Back to the first wording: its narration is still in the pool.
    expect(work(planRevision({ spec: base, pool, renderedComposeKey: second.composeKey }))).toEqual({ voice: [], capture: [], compose: true });
    // A renamed scene keeps its narration and recording.
    const renamed = applyPatch(base, { scenes: [{ op: "remove", id: "demo" }, { op: "add", scene: { ...base.scenes[1], id: "editor" }, after: "hook" }] });
    expect(work(planRevision({ spec: renamed, ...first }))).toEqual({ voice: [], capture: [], compose: true });
  });

  it("never stores the silent voice: the worker makes it for free each time", () => {
    const silent = applyPatch(base, { set: { voice: { provider: "silent", voiceId: null } } });
    const plan = planRevision({ spec: silent, pool: [] });
    expect(plan.voice).toEqual({ reuse: [], make: [], ephemeral: ["hook", "demo", "save", "cta"] });
    expect(plan.capture.make).toEqual(["demo", "save"]);
  });
});

describe("applyPatch", () => {
  it("merges top-level settings one level deep and removes with null", () => {
    const next = applyPatch(base, { set: { format: "1:1", brand: { colours: { accent: "#ff0000" } }, voice: { speed: 1.1 }, music: { url: "https://example.com/m.mp3" } } });
    expect(next).toMatchObject({ format: "1:1", brand: { name: "OpenD", colours: { accent: "#ff0000", primary: base.brand.colours.primary } }, voice: { provider: "elevenlabs", voiceId: "rachel", speed: 1.1 }, music: { volumeDb: -20 } });
    expect(applyPatch(next, { set: { music: null } }).music).toBeUndefined();
    expect(base.format).toBe("9:16"); // the base is not touched
  });

  it("updates, adds, removes, moves and reorders scenes", () => {
    const next = applyPatch(base, {
      scenes: [
        { op: "update", id: "hook", set: { narration: null, heading: "New" } },
        { op: "remove", id: "shot" },
        { op: "add", scene: { id: "intro", kind: "title", heading: "Intro" }, at: "start" },
        { op: "move", id: "save", before: "demo" },
      ],
    });
    expect(next.scenes.map((s) => s.id)).toEqual(["intro", "hook", "save", "demo", "cta"]);
    expect(next.scenes[1]).toMatchObject({ heading: "New" });
    expect(next.scenes[1]!.narration).toBeUndefined();
    expect(next.scenes[0]).toMatchObject({ leadInSec: 0.3 }); // defaults filled like any spec
    expect(applyPatch(base, { order: ["cta", "shot", "save", "demo", "hook"] }).scenes.map((s) => s.id)).toEqual(["cta", "shot", "save", "demo", "hook"]);
  });

  it("refuses edits it can't apply, and results that aren't a valid spec", () => {
    expect(() => applyPatch(base, { scenes: [{ op: "update", id: "nope", set: {} }] })).toThrow(/no scene "nope" \(scenes: hook, demo, save, shot, cta\)/);
    expect(() => applyPatch(base, { scenes: [{ op: "update", id: "hook", set: { kind: "slide" } }] })).toThrow(PatchError);
    expect(() => applyPatch(base, { scenes: [{ op: "update", id: "hook", set: { id: "x" } }] })).toThrow(/id can't be changed/);
    expect(() => applyPatch(base, { scenes: [{ op: "add", scene: { ...base.scenes[0] } }] })).toThrow(/already a scene "hook"/);
    expect(() => applyPatch(base, { scenes: [{ op: "move", id: "hook", after: "cta", at: "end" }] })).toThrow(/one of after, before or at/);
    expect(() => applyPatch(base, { order: ["hook", "demo"] })).toThrow(/every scene exactly once/);
    expect(() => applyPatch(base, { set: { scenes: [] } })).toThrow(/use the scenes operations/);
    expect(() => applyPatch(base, { set: { product: "openv" } })).toThrow(/can't be changed/);
    expect(() => applyPatch(base, { set: { format: "4:3" } })).toThrow();
    expect(() => applyPatch(base, { scenes: [{ op: "update", id: "hook", set: { heading: "two\nlines" } }] })).toThrow();
    expect(() => applyPatch(base, { scenes: [{ op: "remove", id: "hook" }, { op: "remove", id: "demo" }, { op: "remove", id: "save" }, { op: "remove", id: "shot" }, { op: "remove", id: "cta" }] })).toThrow();
    expect(() => applyPatch(base, { nope: 1 } as never)).toThrow();
  });

  it("describes what changed for the history", () => {
    const next = applyPatch(base, {
      set: { format: "16:9", captions: { style: "plain" } },
      scenes: [{ op: "update", id: "hook", set: { narration: "Docs, shipped." } }, { op: "remove", id: "shot" }, { op: "add", scene: { id: "why", kind: "slide", heading: "Why" }, after: "hook" }, { op: "move", id: "save", before: "demo" }],
    });
    expect(describeChanges(base, next)).toEqual(["format: 9:16 → 16:9", "captions changed", "removed scene shot", "hook: narration", "added slide scene why", "scene order"]);
    expect(describeChanges(base, base)).toEqual([]);
  });
});
