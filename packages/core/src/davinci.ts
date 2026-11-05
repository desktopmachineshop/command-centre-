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

/**
 * A Resolve project or timeline name: plain text, so it can't be mistaken for a path. Resolve
 * looks projects up in the current folder of its project manager.
 */
export const DavinciProjectName = z
  .string()
  .regex(/^[\w][\w .,'&()+-]{0,99}$/, "letters, digits, spaces and .,'&()+- only")
  .refine((n) => !n.includes(".."), "no ..");

/** `render`: build the timeline and render it. `draft`: build it and stop, for Dave to edit and render. */
export const DavinciMode = z.enum(["render", "draft"]);

export const DavinciRenderPayload = z
  .object({
    /** Clips, downloaded in order and added end to end to the timeline. May be empty to re-render an existing project. */
    clips: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), name: DavinciFileName })).max(100),
    mode: DavinciMode.default("render"),
    /**
     * The project to work in. If one with this name exists, it is opened and the clips are added
     * to it; otherwise it is created. Without a name, the job uses a throwaway project.
     */
    project: DavinciProjectName.optional(),
    /** Timeline the clips go on (created if the project has none by this name). */
    timeline: DavinciProjectName.default("Main"),
    /**
     * Keep the project afterwards (left open in Resolve). A draft, or a project that already
     * existed, is always kept; only a project this job created is ever deleted.
     */
    keepProject: z.boolean().default(false),
    /** A render preset that exists in Resolve and is on the worker's `davinciPresets` list. Ignored for drafts. */
    preset: z.string().min(1).max(100),
    outputName: DavinciOutputName,
    /** Only applied to a project the job creates (Resolve fixes the frame rate once media is in). */
    fps: z.enum(DAVINCI_FPS).optional(),
    /** Upload the render to Command Centre storage and return its URL (the result's `upload`). */
    upload: z.boolean().default(true),
    uploadFolder: z.enum(["renders", "media", "footage", "assets"]).default("renders"),
  })
  .refine((p) => new Set(p.clips.map((c) => c.name.toLowerCase())).size === p.clips.length, {
    path: ["clips"],
    message: "clip names must be unique",
  })
  .refine((p) => p.clips.length > 0 || p.project, { path: ["clips"], message: "add clips, or name an existing project to re-render" })
  .refine((p) => p.mode === "render" || p.clips.length > 0, { path: ["clips"], message: "a draft needs clips" })
  .refine((p) => !p.keepProject || p.project, { path: ["project"], message: "keepProject needs a project name" })
  .refine((p) => p.mode === "render" || p.project, { path: ["project"], message: "a draft needs a project name" });
export type DavinciRenderPayload = z.infer<typeof DavinciRenderPayload>;
export type DavinciRenderPayloadInput = z.input<typeof DavinciRenderPayload>;

/** What a finished `davinci.render` job returns. A draft has no file (outputPath null). */
export const DavinciRenderResult = z.object({
  mode: DavinciMode.default("render"),
  /** The project, when it was kept (open in Resolve on that PC). */
  project: z.string().nullish(),
  timeline: z.string().nullish(),
  /** Whether the job opened a project that already existed. */
  existing: z.boolean().default(false),
  outputPath: z.string().nullable(),
  bytes: z.number().default(0),
  url: z.string().nullish(),
});
export type DavinciRenderResult = z.infer<typeof DavinciRenderResult>;
