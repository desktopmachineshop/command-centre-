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
  /**
   * Use only part of the recording: seconds from its (already trimmed) start. An edit, not a
   * re-recording: the same recording is cut differently when the video is composed.
   */
  clip: z.object({ startSec: z.number().min(0).max(600).default(0), endSec: z.number().min(0.5).max(600).optional() }).optional(),
});
export const SlideScene = z.object({
  ...SceneBase,
  kind: z.literal("slide"),
  heading: ScreenText(80).optional(),
  bullets: z.array(ScreenText(90)).max(6).default([]),
});
export const ImageScene = z.object({ ...SceneBase, kind: z.literal("image"), url: HttpUrl, alt: z.string().max(200), kenBurns: z.boolean().default(true) });
/** The brand's logo alone on its background: an intro sting before the first scene (or a breather between parts). Needs brand.logoUrl. */
export const LogoScene = z.object({ ...SceneBase, kind: z.literal("logo") });
export const OutroScene = z.object({ ...SceneBase, kind: z.literal("outro"), heading: ScreenText(80), cta: ScreenText(80), url: ScreenText(80).optional() });

export const Scene = z.discriminatedUnion("kind", [TitleScene, CaptureScene, SlideScene, ImageScene, OutroScene, LogoScene]);
export type Scene = z.infer<typeof Scene>;
export type SceneInput = z.input<typeof Scene>;
export type CaptureScene = z.infer<typeof CaptureScene>;

export const VoiceConfig = z.object({
  /**
   * TTS provider id. "auto" (the default) is resolved by the server to the most natural voice it
   * has: "elevenlabs" or "openai" when their key is set, else "local" (the server's own voices, the
   * ones chat speaks with, voiceId e.g. "piper:cori"), else "flite" (robotic, drafts only).
   * "silent" and "flite" run on the worker.
   */
  provider: z.string().regex(/^[a-z0-9-]{1,32}$/).default("auto"),
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
  /** "outline": text with a dark stroke and shadow. "box": on a dark rounded-looking box, for busy footage. */
  background: z.enum(["outline", "box"]).default("outline"),
});

/** How one scene gives way to the next: a hard cut, or a short dip through the brand background. */
export const TransitionConfig = z.object({
  style: z.enum(["cut", "fade"]).default("fade"),
  durationSec: z.number().min(0.05).max(1).default(0.2),
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
    voice: VoiceConfig.default({ provider: "auto", speed: 1 }),
    captions: CaptionConfig.default({ enabled: true, style: "word", background: "outline" }),
    transition: TransitionConfig.default({ style: "fade", durationSec: 0.2 }),
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
  warnings.push(...lintQuality(spec));
  return warnings;
}

/** Voices that sound synthetic or say nothing: fine for a draft, not for a video that gets posted. */
export const DRAFT_VOICES = new Set(["flite", "silent"]);

/**
 * The cheap tells of an amateur video, caught before anything is rendered: a robot voice, no
 * logo, walls of text, scenes that sit still too long, captions off on a short, loud music.
 */
export function lintQuality(spec: VideoSpec): string[] {
  const w: string[] = [];
  const narrated = spec.scenes.some((s) => s.narration);
  if (narrated && spec.voice.provider === "flite") w.push("the flite voice is robotic: fine for a draft, but use a natural voice (elevenlabs, openai or the server's local voices) for anything that gets posted");
  if (narrated && spec.voice.provider === "silent") w.push("voice is silent: the video will have captions but nobody speaking");
  if (!narrated) w.push("no narration in any scene");
  if (!spec.brand.logoUrl) w.push("no brand logo (brand.logoUrl): the title and end cards will be text only");
  if (!spec.captions.enabled && (spec.type === "short" || spec.format !== "16:9")) w.push("captions are off: most short-form video is watched muted");
  const narrow = spec.format !== "16:9";
  const outro = spec.scenes.at(-1);
  if (outro?.kind === "outro" && (outro.minDurationSec ?? 99) < 3) w.push("the end card is held under 3s: too short to read the call to action");
  spec.scenes.forEach((s, i) => {
    const words = s.narration ? countWords(s.narration) : 0;
    const seconds = words / WORDS_PER_SECOND;
    const limit = spec.type === "short" ? 9 : 20;
    if ((s.kind === "title" || s.kind === "slide" || s.kind === "image" || s.kind === "outro") && seconds > limit) {
      w.push(`scene "${s.id}" holds one ${s.kind === "image" ? "still" : "card"} for about ${seconds.toFixed(0)}s of narration: split it or show the product`);
    }
    if ((s.kind === "title" || s.kind === "outro") && s.heading.length > (narrow ? 36 : 60)) w.push(`scene "${s.id}": the heading is long for a ${spec.format} card (${s.heading.length} characters); keep it to a few words`);
    if (s.kind === "slide" && s.bullets.length > (narrow ? 3 : 5)) w.push(`scene "${s.id}": ${s.bullets.length} bullets is a wall of text on ${spec.format}`);
    if (s.kind === "slide" && s.bullets.some((b) => b.length > (narrow ? 36 : 70))) w.push(`scene "${s.id}": a bullet is too long to read at a glance`);
    if (s.kind === "capture" && !s.narration && i > 0) w.push(`scene "${s.id}" is a silent screen recording: say what the viewer is looking at`);
    if (s.kind === "logo" && !spec.brand.logoUrl) w.push(`scene "${s.id}" is a logo card, but the brand kit has no logoUrl: it would be an empty card`);
    if (s.kind === "logo" && (s.minDurationSec ?? 0) > 3) w.push(`scene "${s.id}": a logo sting over 3s is a long wait before anything happens`);
    if (s.kind === "image" && !s.kenBurns && (s.minDurationSec ?? seconds) > 4) w.push(`scene "${s.id}": a still held this long without movement looks frozen (kenBurns)`);
  });
  const perLine = { "9:16": 18, "1:1": 26, "16:9": 42 }[spec.format];
  if (spec.captions.enabled && (spec.captions.maxChars ?? 0) > perLine * 2) w.push(`captions.maxChars ${spec.captions.maxChars} will run over two lines on ${spec.format}; keep it to ${perLine * 2} or leave it out`);
  if (spec.music && spec.music.volumeDb > -14) w.push(`music at ${spec.music.volumeDb} dB will fight the voice; -18 to -24 dB sits under it`);
  if (spec.music && !spec.music.credit) w.push("music has no credit/licence note: keep where the track came from");
  if (spec.type !== "short" && spec.scenes.length >= 3 && spec.scenes.every((s) => s.kind !== "capture" && s.kind !== "image")) w.push("no screen recording or image in any scene: the video is only text cards");
  return w.filter(Boolean);
}

export function parseSpec(input: unknown): VideoSpec {
  return VideoSpec.parse(input);
}
