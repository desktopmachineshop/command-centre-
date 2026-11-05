import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The Command Centre's own documentation for the agents, at /mcp/help: the in-app help (the DITA
 * topics in docs/topics, the same ones the app's "?" panel shows) and the setup and design notes
 * (docs/*.md, one topic per "##" section). Read once from DOCS_DIR, searched in memory. Read-only.
 */

export interface HelpTopic {
  /** e.g. "work/approvals", or "setup/run-locally" for a Markdown section. */
  id: string;
  title: string;
  shortdesc: string;
  /** The help map's group ("Work", "System"…), or the Markdown file ("Setup"). */
  group: string;
  /** The app page it describes, as a hash route (e.g. "#/approvals"), when it is one. */
  route: string | null;
  /** In-app help keys (`resourceid appid`), e.g. "approvals.edit". */
  keys: string[];
  /** The topic as plain text with Markdown headings. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

const TOPIC_TAGS = new Set(["topic", "concept", "task", "reference", "glossentry", "troubleshooting"]);
const HEADED_TAGS = new Set(["section", "example", "table", "simpletable"]);
const BLOCK_TAGS = new Set([
  "p", "shortdesc", "note", "ol", "ul", "sl", "dl", "dlentry", "steps", "steps-unordered", "context", "result", "prereq", "postreq",
  "info", "stepresult", "codeblock", "lines", "row", "strow", "sthead", "lq", "draft-comment", "abstract", "body", "conbody", "taskbody", "refbody",
]);
const SKIP_TAGS = new Set(["prolog", "titlealts", "indexterm", "data", "draft-comment", "required-cleanup"]);
const STRONG_TAGS = new Set(["uicontrol", "wintitle", "b"]);
const CODE_TAGS = new Set(["codeph", "userinput", "systemoutput", "filepath", "cmdname", "varname", "apiname"]);

/** A DITA topic file as plain text: headings by nesting, lists, notes, UI names in bold, links named. Pure. */
export function ditaToText(xml: string, fromId = ""): string {
  const dir = fromId.split("/").slice(0, -1).join("/");
  const src = xml.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let depth = 0; // topic nesting
  let headed = 0; // sections inside the current topic
  let skip = 0;
  let pre = 0;
  let fig = 0;
  let xrefHref: string | null = null;
  let xrefText = "";
  const nl = () => out.push("\n");
  const tagRe = /<(\/?)([\w-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    const [, close, rawName, attrs = "", self, text] = m;
    if (text !== undefined) {
      if (skip) continue;
      const t = pre ? decode(text) : decode(text).replace(/\s+/g, " ");
      if (xrefHref !== null) xrefText += t;
      else out.push(t);
      continue;
    }
    const name = rawName!.toLowerCase();
    const attr = (a: string) => new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1] ?? new RegExp(`\\b${a}\\s*=\\s*'([^']*)'`).exec(attrs)?.[1];
    if (name === "title" && fig) {
      // A figure's title repeats its image's description: keep just the description.
      if (!self) skip += close ? -1 : 1;
      continue;
    }
    if (SKIP_TAGS.has(name)) {
      if (!self) skip += close ? -1 : 1;
      continue;
    }
    if (skip) continue;
    if (name === "image") {
      if (!close) {
        const alt = attr("alt");
        if (alt) out.push(`[Image: ${alt}]`);
      }
      continue;
    }
    if (name === "alt") {
      // <alt> inside <image>: shown as the image's description.
      if (!close && !self) out.push("[Image: ");
      else if (close) out.push("]");
      continue;
    }
    if (TOPIC_TAGS.has(name)) {
      if (close) depth--;
      else if (!self) {
        depth++;
        headed = 0;
      }
      continue;
    }
    if (name === "fig") {
      if (!self) fig += close ? -1 : 1;
      nl();
      continue;
    }
    if (HEADED_TAGS.has(name)) {
      if (close) headed = Math.max(0, headed - 1);
      else if (!self) headed++;
      nl();
      continue;
    }
    if (name === "title") {
      if (!close) {
        nl();
        nl();
        out.push(`${"#".repeat(Math.min(6, Math.max(1, depth) + headed))} `);
      } else nl();
      continue;
    }
    if (name === "xref" || name === "link") {
      const href = attr("href");
      if (!close && self) out.push(href ? `(see ${linkTarget(href, dir)})` : "");
      else if (!close) {
        xrefHref = href ?? "";
        xrefText = "";
      } else if (xrefHref !== null) {
        const label = xrefText.trim();
        const target = xrefHref && !/^https?:/.test(xrefHref) ? linkTarget(xrefHref, dir, fromId) : xrefHref;
        out.push(label && target ? `${label} (${/^https?:/.test(target) ? target : `help: ${target}`})` : label || target);
        xrefHref = null;
      }
      continue;
    }
    if (STRONG_TAGS.has(name)) {
      out.push(close || !self ? "**" : "");
      continue;
    }
    if (CODE_TAGS.has(name)) {
      out.push("`");
      continue;
    }
    if (name === "ol" || name === "ul" || name === "steps" || name === "steps-unordered" || name === "sl") {
      if (close) lists.pop();
      else if (!self) lists.push({ ordered: name === "ol" || name === "steps", n: 0 });
      nl();
      continue;
    }
    if (name === "li" || name === "step" || name === "sli") {
      if (!close && !self) {
        const l = lists[lists.length - 1];
        nl();
        out.push(`${"  ".repeat(Math.max(0, lists.length - 1))}${l?.ordered ? `${++l.n}.` : "-"} `);
      }
      continue;
    }
    if (name === "dt") {
      if (!close && !self) {
        nl();
        out.push("- **");
      } else if (close) out.push("**: ");
      continue;
    }
    if (name === "stentry" || name === "entry") {
      if (!close && !self) out.push(" | ");
      continue;
    }
    if (name === "note") {
      if (!close && !self) {
        nl();
        const type = attr("type");
        out.push(`${type && type !== "note" ? type[0]!.toUpperCase() + type.slice(1) : "Note"}: `);
      } else nl();
      continue;
    }
    if (name === "codeblock") {
      nl();
      out.push("```");
      nl();
      pre += close ? -1 : self ? 0 : 1;
      continue;
    }
    if (name === "cmd") continue;
    if (BLOCK_TAGS.has(name)) nl();
  }
  return out
    .join("")
    .split("\n")
    .map((l) => (/^ {2,}(?:-|\d+\.) /.test(l) ? l.trimEnd() : l.trim())) // keep nested-list indents only
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "../work/approvals.dita#approvals/edit" from "business" -> "work/approvals#edit": a topic id under the topics folder. */
function linkTarget(href: string, dir = "", self = ""): string {
  const [path = "", frag = ""] = href.split("#");
  const parts = dir ? dir.split("/") : [];
  for (const p of path.replace(/\.dita$/, "").split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  const id = path ? parts.join("/") : self;
  const section = frag.split("/").pop() ?? "";
  return `${id}${section && section !== id.split("/").pop() ? `#${section}` : ""}`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_()[\]:,.'"?!/&]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);

/** One topic per "##" section of a Markdown file (with the text before the first as its intro). Pure. */
export function markdownTopics(base: string, md: string, group: string): HelpTopic[] {
  const lines = md.split("\n");
  const docTitle = /^#\s+(.+)/.exec(lines.find((l) => /^#\s/.test(l)) ?? "")?.[1]?.trim() ?? group;
  const topics: HelpTopic[] = [];
  let title = docTitle;
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.replace(/^#.*$/gm, "").trim()) {
      const id = title === docTitle ? base : `${base}/${slug(title)}`;
      const para = text.replace(/^#.*$/gm, "").trim().split(/\n\s*\n/)[0] ?? "";
      topics.push({ id, title: title === docTitle ? docTitle : `${docTitle}: ${title}`, shortdesc: para.replace(/\s+/g, " ").slice(0, 200), group, route: null, keys: [], text });
    }
  };
  for (const line of lines) {
    if (/^```/.test(line)) fence = !fence;
    const h2 = !fence && /^##\s+(.+)/.exec(line);
    if (h2) {
      flush();
      title = h2[1]!.trim();
      buf = [line];
    } else buf.push(line);
  }
  flush();
  // Two sections with the same heading: number the later ones.
  const seen = new Map<string, number>();
  for (const t of topics) {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    if (n > 1) t.id = `${t.id}-${n}`;
  }
  return topics;
}

/** help-contexts.yaml's routes, as key -> shortest plain route ("/approvals/**" -> "/approvals"). */
function parseRoutes(yaml: string): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const m of yaml.matchAll(/^\s+(\/[^\s:]*(?::[\w]+[^\s:]*)*)\s*:\s*([\w.-]+)\s*$/gm)) {
    const route = m[1]!.replace(/\/\*\*$/, "") || "/";
    if (route.includes(":")) continue; // "/task/:id" needs an id
    const prev = byKey.get(m[2]!);
    if (!prev || route.length < prev.length) byKey.set(m[2]!, route);
  }
  return byKey;
}

/** The help map's topic order with its group headings: topic id -> group. */
function parseMap(xml: string): { id: string; group: string }[] {
  const order: { id: string; group: string }[] = [];
  let group = "Overview";
  for (const m of xml.matchAll(/<topichead[^>]*navtitle="([^"]*)"|<\/topichead>|<topicref[^>]*href="([^"]+)"/g)) {
    if (m[1] !== undefined) group = m[1];
    else if (m[0] === "</topichead>") group = "Overview";
    else if (m[2]) order.push({ id: linkTarget(m[2].replace(/^(\.\.\/)*topics\//, "")), group });
  }
  return order;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

/** The Markdown notes in docs/: file -> [topic id prefix, group]. */
const MD_FILES: Record<string, [string, string]> = {
  "SETUP.md": ["setup", "Setup"],
  "ARCHITECTURE.md": ["architecture", "Architecture"],
  "ORG.md": ["org-design", "Org chart (design)"],
  "VIDEO.md": ["video", "Video pipeline"],
};
const MD_GROUPS = new Set(Object.values(MD_FILES).map(([, g]) => g));

export class HelpDocs {
  readonly topics: HelpTopic[];
  private readonly byId: Map<string, HelpTopic>;

  constructor(topics: HelpTopic[]) {
    this.topics = topics;
    this.byId = new Map(topics.map((t) => [t.id, t]));
  }

  /** Reads docs/topics (DITA), docs/maps, docs/help-contexts.yaml and docs/*.md. A missing folder gives no topics. */
  static load(dir: string): HelpDocs {
    if (!existsSync(dir)) return new HelpDocs([]);
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    const routes = parseRoutes(read(join(dir, "help-contexts.yaml")));
    const mapFile = existsSync(join(dir, "maps")) ? readdirSync(join(dir, "maps")).find((f) => f.endsWith(".ditamap")) : undefined;
    const order = mapFile ? parseMap(read(join(dir, "maps", mapFile))) : [];
    const topicsDir = join(dir, "topics");
    const dita: HelpTopic[] = [];
    for (const file of existsSync(topicsDir) ? walk(topicsDir).filter((f) => f.endsWith(".dita")).sort() : []) {
      const xml = readFileSync(file, "utf8");
      const id = relative(topicsDir, file).split(sep).join("/").replace(/\.dita$/, "");
      const title = decode(/<title>([\s\S]*?)<\/title>/.exec(xml)?.[1]?.replace(/<[^>]+>/g, "") ?? id).replace(/\s+/g, " ").trim();
      const shortdesc = decode(/<shortdesc>([\s\S]*?)<\/shortdesc>/.exec(xml)?.[1]?.replace(/<[^>]+>/g, "") ?? "").replace(/\s+/g, " ").trim();
      const keys = [...xml.matchAll(/<resourceid[^>]*appid="([^"]+)"/g)].map((m) => m[1]!);
      const route = keys.map((k) => routes.get(k)).find(Boolean) ?? null;
      const group = order.find((o) => o.id === id)?.group ?? "Other";
      dita.push({ id, title, shortdesc, group, route: route ? `#${route}` : null, keys, text: ditaToText(xml, id) });
    }
    // Map order first, then any topic the map doesn't list.
    const rank = (t: HelpTopic) => {
      const i = order.findIndex((o) => o.id === t.id);
      return i < 0 ? order.length : i;
    };
    dita.sort((a, b) => rank(a) - rank(b));
    const md = Object.entries(MD_FILES).flatMap(([file, [base, group]]) => {
      const text = read(join(dir, file));
      return text ? markdownTopics(base, text, group) : [];
    });
    return new HelpDocs([...dita, ...md]);
  }

  get size(): number {
    return this.topics.length;
  }

  /** A topic by id ("work/approvals"), file name ("approvals"), help key ("approvals.edit") or route ("#/approvals"). */
  find(ref: string): HelpTopic | null {
    const raw = ref.trim();
    if (raw.startsWith("#/")) {
      const path = raw.split("?")[0]!;
      const route = path.length > 2 ? path.replace(/\/+$/, "") : path;
      return this.topics.find((t) => t.route === route) ?? this.topics.find((t) => t.route && t.route !== "#/" && route.startsWith(`${t.route}/`)) ?? null;
    }
    const r = raw.replace(/^\/+/, "").split("#")[0]!.replace(/\.dita$/, "").toLowerCase();
    if (!r) return null;
    return (
      this.byId.get(r) ??
      this.topics.find((t) => t.id.split("/").pop() === r) ??
      this.topics.find((t) => t.keys.includes(r)) ??
      this.topics.find((t) => t.keys.includes(r.split(".")[0]!)) ??
      null
    );
  }

  /** Topics ranked for a query: every word counts, titles and summaries most. */
  search(query: string, limit = 8): { topic: HelpTopic; score: number; snippet: string }[] {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [])].filter((w) => w.length > 1);
    if (!words.length) return [];
    const count = (hay: string, w: string) => {
      let n = 0;
      for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + w.length)) n++;
      return n;
    };
    const phrase = query.toLowerCase().trim();
    return this.topics
      .map((topic) => {
        const title = topic.title.toLowerCase();
        const desc = topic.shortdesc.toLowerCase();
        const body = topic.text.toLowerCase();
        let score = 0;
        let matched = 0;
        for (const w of words) {
          const s = count(title, w) * 6 + count(desc, w) * 3 + Math.min(count(body, w), 10);
          if (s) matched++;
          score += s;
        }
        if (!matched) return null;
        score *= matched / words.length; // all the words beat some of them
        if (words.length > 1 && body.includes(phrase)) score += 10;
        if (topic.route) score *= 1.2; // the app's own help before the design notes
        return { topic, score, snippet: snippet(topic.text, words) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** The app's pages for the system prompt: one line each, from the help map. */
  pageGuide(): string {
    const dita = this.topics.filter((t) => !MD_GROUPS.has(t.group));
    if (!dita.length) return "";
    const lines = ["## The app's pages and help topics", "Each line: page (in-app route) — what it is for [help topic id]."];
    let group = "";
    for (const t of dita) {
      if (t.group !== group) {
        group = t.group;
        lines.push(`${group}:`);
      }
      lines.push(`- ${t.title}${t.route ? ` (${t.route})` : ""} — ${t.shortdesc} [${t.id}]`);
    }
    return lines.join("\n");
  }
}

function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 80);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 260).trim()}${start + 260 < flat.length ? "…" : ""}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** /mcp/help: list, search and read the Command Centre's help and setup docs. Read-only. */
export function createHelpMcpServer(docs: HelpDocs): McpServer {
  const server = new McpServer({ name: "help", version: "0.1.0" });
  const empty = "The Command Centre help docs aren't installed on this server (DOCS_DIR). Say so rather than guessing how the app works.";
  server.registerTool(
    "list_help_topics",
    {
      description:
        "List the Command Centre's help topics: the in-app help for each page of the app (with its route) and the setup and design notes. Use it to see what the docs cover; then read_help_topic.",
      inputSchema: { group: z.string().optional().describe('Only this group, e.g. "Work", "System", "Setup"') },
    },
    async ({ group }) => {
      if (!docs.size) return text(empty);
      const list = docs.topics.filter((t) => !group || t.group.toLowerCase() === group.toLowerCase());
      if (!list.length) return text(`No group "${group}". Groups: ${[...new Set(docs.topics.map((t) => t.group))].join(", ")}.`);
      const lines: string[] = [];
      let g = "";
      for (const t of list) {
        if (t.group !== g) lines.push(`${lines.length ? "\n" : ""}${(g = t.group)}:`);
        lines.push(`- ${t.id}: ${t.title}${t.route ? ` (page ${t.route})` : ""}${t.shortdesc ? ` — ${t.shortdesc}` : ""}`);
      }
      return text(lines.join("\n"));
    },
  );
  server.registerTool(
    "search_help",
    {
      description:
        "Search the Command Centre's own documentation (the in-app help and the setup notes) for how the app works, where a setting lives, what a page or button does, how something is set up or connected, and why it behaves the way it does. Returns the best topics with a snippet; read one in full with read_help_topic before explaining steps to Dave.",
      inputSchema: {
        query: z.string().trim().min(2).max(200).describe('Plain words, e.g. "turn on two-factor", "quiet hours", "connect a mailbox", "approve from notification"'),
        limit: z.number().int().min(1).max(20).default(6),
      },
    },
    async ({ query, limit }) => {
      if (!docs.size) return text(empty);
      const hits = docs.search(query, limit);
      if (!hits.length) return text(`Nothing in the help matches "${query}". Try other words, or list_help_topics.`);
      return text(hits.map((h) => `- ${h.topic.id}: ${h.topic.title}${h.topic.route ? ` (page ${h.topic.route})` : ""}\n  ${h.snippet}`).join("\n"));
    },
  );
  server.registerTool(
    "read_help_topic",
    {
      description: 'Read one help topic in full, by its id from search_help or list_help_topics (e.g. "work/approvals", "system/settings", "setup/run-locally"). Long topics come in parts: pass `part` for the next.',
      inputSchema: { id: z.string().min(1), part: z.number().int().min(1).default(1) },
    },
    async ({ id, part }) => {
      if (!docs.size) return text(empty);
      const topic = docs.find(id);
      if (!topic) {
        const near = docs.search(id.replace(/[/#._-]+/g, " "), 5).map((h) => h.topic.id);
        return { ...text(`No help topic "${id}".${near.length ? ` Did you mean: ${near.join(", ")}?` : " Use list_help_topics."}`), isError: true };
      }
      const size = 12_000;
      const parts = Math.max(1, Math.ceil(topic.text.length / size));
      const body = topic.text.slice((part - 1) * size, part * size);
      const head = [`[${topic.id}] ${topic.title}`, topic.route ? `App page: ${topic.route}` : null, parts > 1 ? `Part ${Math.min(part, parts)} of ${parts}` : null].filter(Boolean).join("\n");
      return text(`${head}\n\n${body || "(no more parts)"}`);
    },
  );
  return server;
}
