import { z } from "zod";

/**
 * `davinci.render` job payload, shared by the server (which builds it) and the desktop worker
 * (which validates it again before DaVinci Resolve sees anything).
 */

/** A plain file name: no folders, no `..`. */
export const DavinciFileName = z
  .string()
  .regex(/^[\w][\w. -]{0,199}$/, "plain file name only")
  .refine((n) => !n.includes(".."), "plain file name only");

export const DAVINCI_FPS = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"] as const;

/** An output name without extension; Resolve adds the one the preset uses. */
export const DavinciOutputName = z.string().regex(/^[\w][\w -]{0,99}$/, "letters, digits, spaces, - and _ only");

export const DavinciRenderPayload = z
  .object({
    /** Clips, downloaded in order and laid end to end on one timeline. */
    clips: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), name: DavinciFileName })).min(1).max(100),
    /** A render preset that exists in Resolve and is on the worker's `davinciPresets` list. */
    preset: z.string().min(1).max(100),
    outputName: DavinciOutputName,
    fps: z.enum(DAVINCI_FPS).optional(),
    /** Upload the render to Command Centre storage and return its URL (the result's `upload`). */
    upload: z.boolean().default(true),
    uploadFolder: z.enum(["renders", "media", "footage", "assets"]).default("renders"),
  })
  .refine((p) => new Set(p.clips.map((c) => c.name.toLowerCase())).size === p.clips.length, {
    path: ["clips"],
    message: "clip names must be unique",
  });
export type DavinciRenderPayload = z.infer<typeof DavinciRenderPayload>;
export type DavinciRenderPayloadInput = z.input<typeof DavinciRenderPayload>;

/** What a finished `davinci.render` job returns. */
export const DavinciRenderResult = z.object({
  outputPath: z.string(),
  bytes: z.number(),
  url: z.string().nullish(),
});
export type DavinciRenderResult = z.infer<typeof DavinciRenderResult>;
