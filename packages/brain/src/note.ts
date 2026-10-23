import { parse, stringify } from "yaml";

export type Frontmatter = Record<string, unknown>;

export interface Note {
  /** Path relative to the brain root, always ending in `.md`. */
  path: string;
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(path: string, raw: string): Note {
  const match = FENCE.exec(raw);
  if (!match) return { path, frontmatter: {}, body: raw };
  let frontmatter: Frontmatter = {};
  try {
    const parsed = parse(match[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Frontmatter;
  } catch {
    // Malformed frontmatter: keep the whole file as body rather than losing it.
    return { path, frontmatter: {}, body: raw };
  }
  // serializeNote puts one blank line after the fence; drop it so bodies round-trip.
  return { path, frontmatter, body: raw.slice(match[0].length).replace(/^\r?\n/, "") };
}

export function serializeNote(note: Pick<Note, "frontmatter" | "body">): string {
  const body = note.body.endsWith("\n") ? note.body : `${note.body}\n`;
  if (Object.keys(note.frontmatter).length === 0) return body;
  return `---\n${stringify(note.frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/** First markdown heading, else the file name. */
export function noteTitle(note: Note): string {
  if (typeof note.frontmatter.title === "string") return note.frontmatter.title;
  const heading = /^#\s+(.+)$/m.exec(note.body);
  if (heading?.[1]) return heading[1].trim();
  return note.path.split("/").pop()!.replace(/\.md$/, "");
}
