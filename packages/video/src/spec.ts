import { z } from "zod";

/**
 * VideoSpec: everything needed to produce one video, written by the
 * agent following skills/video-reel and checked here before any
 * job runs. Timing is not written by hand: each scene lasts as long as its
 * narration (plus lead-in and tail), see `planTimeline`.
 */

export const Format = z.enum(["9:16", "16:9", "1:1"]);
export type Format = z.infer<typeof Format>;

/** Output frame size per format. */
export const FRAME: Record<Format, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

/** Browser viewport for screen captures per format, before scaling into the frame. */
export const CAPTURE_VIEWPORT: Record<Format, { width: number; height: number }> = {
  "9:16": { width: 540, height: 960 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 900, height: 900 },
};

const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
/** Font family names, resolved by fontconfig on the render machine (or files in a `fonts/` folder). */
const FontFamily = z.string().regex(/^[\w .-]{1,64}$/, "a plain font family name");
const HttpUrl = z.url({ protocol: /^https?$/ });
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes");
/** On-screen text: no control characters (ASS/SRT would treat newlines as markup). */
const ScreenText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((t) => !/[\0-\x1f\x7f]/.test(t), "no control characters or newlines");

export const Brand = z.object({
  name: z.string().min(1).max(40),
  logoUrl: HttpUrl.optional(),
  colours: z.object({
    primary: Colour,
    background: Colour,
    text: Colour,
    accent: Colour,
  }),
  fonts: z.object({ heading: FontFamily, body: FontFamily }),
});
export type Brand = z.infer<typeof Brand>;

/**
 * Default brand kits, one per brand that makes videos. The colours and fonts
 * are placeholders until Dave confirms the real ones (see docs/VIDEO.md, open
 * questions). Each brand's guidelines, with this same kit, are in
 * skills/video-reel/brands/<brand>.md (a test keeps the two in step).
 */
export const BRANDS = {
  opend: {
    name: "OpenD",
    colours: { primary: "#1f6feb", background: "#0d1b2a", text: "#ffffff", accent: "#ffb703" },
    fonts: { heading: "Inter", body: "Inter" },
  },
  openv: {
    name: "OpenV",
    colours: { primary: "#7c3aed", background: "#1a1033", text: "#ffffff", accent: "#22d3ee" },
    fonts: { heading: "Inter", body: "Inter" },
  },
  dms: {
    name: "Desktop Machine Shop",
    colours: { primary: "#d9822b", background: "#1c1f24", text: "#ffffff", accent: "#f2c14e" },
    fonts: { heading: "Inter", body: "Inter" },
  },
  "3dpandme": {
    name: "3dpandme",
    colours: { primary: "#cf4f8f", background: "#1b1420", text: "#ffffff", accent: "#7ee0c3" },
    fonts: { heading: "Inter", body: "Inter" },
  },
} satisfies Record<string, Brand>;

/** Brands (= vertical ids) a video can be made for. */
export const PRODUCTS = ["openv", "opend", "dms", "3dpandme"] as const;

const Selector = z.string().min(1).max(500);
const Ms = (max: number) => z.number().int().min(0).max(max);

/** One scripted browser action in a screen capture. Playwright locators, never page JavaScript. */
export const Step = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: HttpUrl }),
  z.object({ action: z.literal("click"), selector: Selector }),
  z.object({ action: z.literal("hover"), selector: Selector }),
  z.object({ action: z.literal("type"), selector: Selector, text: z.string().max(500), delayMs: Ms(500).default(55) }),
  z.object({ action: z.literal("press"), key: z.string().regex(/^[\w+]{1,30}$/) }),
  /** Picks an option in a <select> by its value. */
  z.object({ action: z.literal("select"), selector: Selector, value: z.string().max(200) }),
  z.object({ action: z.literal("scroll"), selector: Selector.optional(), y: z.number().int().min(0).max(100_000).optional() }),
  z.object({ action: z.literal("wait"), ms: Ms(15_000) }),
  /** Outlines an element (in the brand accent colour) for `ms`. */
  z.object({ action: z.literal("highlight"), selector: Selector, ms: Ms(10_000).default(1200) }),
  /** Zooms the page towards an element, holds for `ms`, then zooms back out. */
  z.object({ action: z.literal("zoom"), selector: Selector, scale: z.number().min(1.1).max(3).default(1.6), ms: Ms(10_000).default(1500) }),
]);
export type Step = z.infer<typeof Step>;

const SceneBase = {
  id: Id,
  /** What the voice says during this scene. Captions are generated from it. */
  narration: z.string().min(1).max(1200).optional(),
  /** Floor for the scene length; the narration usually decides it. */
  minDurationSec: z.number().min(0.5).max(120).optional(),
  /** Silence before the narration starts in this scene. */
  leadInSec: z.number().min(0).max(5).default(0.3),
  /** Silence after the narration ends, before the next scene. */
  tailSec: z.number().min(0).max(5).default(0.4),
};

export const TitleScene = z.object({ ...SceneBase, kind: z.literal("title"), heading: ScreenText(80), subheading: ScreenText(120).optional() });
export const CaptureScene = z.object({
  ...SceneBase,
  kind: z.literal("capture"),
  /** Steps run in order; the first must be a goto. Recording is trimmed to start once it has loaded. */
  steps: z.array(Step).min(1).max(60),
  viewport: z.object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(320).max(2560) }).optional(),
  /** "contain" letterboxes in the brand background; "cover" fills the frame and crops. */
  fit: z.enum(["contain", "cover"]).default("contain"),
  /** Name of a signed-in browser profile configured on the worker (worker.json `captureProfiles`). */
  authProfile: z.string().regex(/^[\w-]{1,40}$/).optional(),
  /** Show a pointer that glides to each element before it is clicked. */
  cursor: z.boolean().default(true),
});
export const SlideScene = z.object({
  ...SceneBase,
  kind: z.literal("slide"),
  heading: ScreenText(80).optional(),
  bullets: z.array(ScreenText(90)).max(6).default([]),
});
export const ImageScene = z.object({ ...SceneBase, kind: z.literal("image"), url: HttpUrl, alt: z.string().max(200), kenBurns: z.boolean().default(true) });
export const OutroScene = z.object({ ...SceneBase, kind: z.literal("outro"), heading: ScreenText(80), cta: ScreenText(80), url: ScreenText(80).optional() });

export const Scene = z.discriminatedUnion("kind", [TitleScene, CaptureScene, SlideScene, ImageScene, OutroScene]);
export type Scene = z.infer<typeof Scene>;
export type SceneInput = z.input<typeof Scene>;
export type CaptureScene = z.infer<typeof CaptureScene>;

export const VoiceConfig = z.object({
  /** TTS provider id: "silent" and "flite" run on the worker; "local" is the server's own voices (the ones chat speaks with, voiceId e.g. "piper:cori"); "elevenlabs" and "openai" need keys on the server. */
  provider: z.string().regex(/^[a-z0-9-]{1,32}$/).default("silent"),
  voiceId: z.string().max(100).optional(),
  /** 0.7–1.3; providers that support it apply it. */
  speed: z.number().min(0.7).max(1.3).default(1),
});

export const CaptionConfig = z.object({
  enabled: z.boolean().default(true),
  /** "word" highlights the word being spoken (the short-form look); "plain" shows the line. */
  style: z.enum(["word", "plain"]).default("word"),
  /** Characters per caption line; defaults by format (narrow for 9:16). */
  maxChars: z.number().int().min(10).max(80).optional(),
});

/** Where a claim in the script came from, so the reviewer can check it (an MCP tool call). */
export const Source = z.object({ tool: z.string().max(80), ref: z.string().max(300), note: z.string().max(300).optional() });

export const VideoSpec = z
  .object({
    version: z.literal(1).default(1),
    id: Id,
    title: z.string().min(1).max(120),
    /** The brand, which is also the vertical the finished video is proposed in. */
    product: z.enum(PRODUCTS),
    /** demo, walkthrough, announcement, short (social clip) or explainer (long-form YouTube). */
    type: z.enum(["demo", "walkthrough", "announcement", "short", "explainer"]),
    format: Format,
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
    brand: Brand,
    voice: VoiceConfig.default({ provider: "silent", speed: 1 }),
    captions: CaptionConfig.default({ enabled: true, style: "word" }),
    music: z.object({ url: HttpUrl, volumeDb: z.number().min(-40).max(0).default(-20), credit: z.string().max(200).optional() }).optional(),
    scenes: z.array(Scene).min(1).max(40),
    sources: z.array(Source).max(50).default([]),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: `duplicate scene id "${scene.id}"` });
      seen.add(scene.id);
      if (scene.kind === "capture" && scene.steps[0]?.action !== "goto") {
        ctx.addIssue({ code: "custom", path: ["scenes", i, "steps", 0], message: "a capture scene must start with a goto step" });
      }
    });
  });
export type VideoSpec = z.infer<typeof VideoSpec>;
export type VideoSpecInput = z.input<typeof VideoSpec>;

/** Length targets per video type, in seconds: [min, max]. */
export const LENGTH_TARGETS: Record<VideoSpec["type"], [number, number]> = {
  short: [20, 60],
  announcement: [20, 90],
  demo: [30, 180],
  walkthrough: [60, 300],
  explainer: [180, 720],
};

/** Words per second of ordinary narration, for estimates before any audio exists. */
export const WORDS_PER_SECOND = 2.6;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Non-fatal checks the reviewer and the agent should see: length against the
 * type's target, a slow hook in short-form, a missing CTA, unsourced specs.
 */
export function lintSpec(spec: VideoSpec): string[] {
  const warnings: string[] = [];
  const estimate = spec.scenes.reduce((sum, s) => {
    const voice = s.narration ? countWords(s.narration) / WORDS_PER_SECOND : 0;
    return sum + Math.max(s.minDurationSec ?? 0, s.leadInSec + voice + s.tailSec);
  }, 0);
  const [min, max] = LENGTH_TARGETS[spec.type];
  if (estimate < min) warnings.push(`estimated ${estimate.toFixed(0)}s is under the ${min}s target for a ${spec.type}`);
  if (estimate > max) warnings.push(`estimated ${estimate.toFixed(0)}s is over the ${max}s target for a ${spec.type}`);
  if (spec.type === "short" && spec.format !== "9:16") warnings.push("shorts should be 9:16");
  if (spec.type === "explainer" && spec.format !== "16:9") warnings.push("explainers should be 16:9");
  const first = spec.scenes[0];
  if (spec.type === "short" && first?.narration && countWords(first.narration) / WORDS_PER_SECOND > 3) {
    warnings.push("the hook (first scene) takes over 3s to say; shorts lose viewers in the first seconds");
  }
  if (spec.scenes.at(-1)?.kind !== "outro") warnings.push("no outro/CTA scene at the end");
  if (spec.sources.length === 0) warnings.push("no sources: list the MCP lookups that verify each feature shown");
  return warnings;
}

export function parseSpec(input: unknown): VideoSpec {
  return VideoSpec.parse(input);
}
