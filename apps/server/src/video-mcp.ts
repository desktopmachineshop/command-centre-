import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lintSpec } from "@cc/video";
import { z } from "zod";
import type { VideoProject, VideoProjectStore, VideoRevision } from "./video-projects";

/**
 * READ-ONLY tools over the video projects, at /mcp/video: what was produced, each project's
 * spec (the thing video.revise edits), which assets are stored, what was rendered and how it
 * got there. "Make the hook shorter on last week's OpenD reel" starts here: find the project,
 * read its spec, propose a video.revise.
 */

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const brief = (r: VideoRevision) => ({
  revision: r.revision,
  based_on: r.basedOn,
  status: r.status,
  created: r.createdAt,
  changes: r.changes,
  plan: r.plan,
  ...(r.error ? { error: r.error } : {}),
  ...(r.outputs.video ? { video: r.outputs.video.url ?? r.outputs.video.path, seconds: Math.round(r.outputs.video.durationSec), size: `${r.outputs.video.width}x${r.outputs.video.height}` } : {}),
});

/** A scene as an editor thinks of it: what it shows and says, and whether its assets are stored. */
function scenesOf(project: VideoProject, r: VideoRevision) {
  return r.spec.scenes.map((s, i) => {
    const keys = r.assets[s.id] ?? {};
    const slot = r.outputs.timeline?.scenes[i];
    return {
      id: s.id,
      kind: s.kind,
      ...("heading" in s && s.heading ? { heading: s.heading } : {}),
      ...(s.narration ? { narration: s.narration } : {}),
      ...(slot ? { start: slot.start, seconds: slot.duration } : {}),
      ...(keys.voice ? { voice: project.pool[keys.voice] ? "stored" : r.spec.voice.provider === "silent" ? "silent (made at render)" : "not stored" } : {}),
      ...(keys.capture ? { recording: project.pool[keys.capture] ? "stored" : "not stored" } : {}),
    };
  });
}

export function createVideoMcpServer(store: VideoProjectStore, onlyVertical: string | null = null): McpServer {
  const server = new McpServer({ name: "video", version: "0.1.0" });

  server.registerTool(
    "list_video_projects",
    {
      description:
        "The video projects (every produced video is one), newest change first: id, title, business, latest revision and its status, length and URL. Use it to find the video someone means (\"last week's OpenD reel\") before get_video_project. Read-only.",
      inputSchema: {
        vertical: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional().describe("only this business, e.g. opend"),
        query: z.string().min(1).optional().describe("words from the title"),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ vertical, query, include_archived, limit }) => {
      const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const projects = (await store.list({ vertical: onlyVertical ?? vertical, includeArchived: include_archived, limit: 200 })).filter((p) => words.every((w) => `${p.title} ${p.specId}`.toLowerCase().includes(w)));
      const out = [];
      for (const p of projects.slice(0, limit)) {
        const latest = await store.revision(p.id, p.current);
        out.push({ id: p.id, title: p.title, vertical: p.vertical, status: p.status, created: p.createdAt, updated: p.updatedAt, revisions: p.current, ...(latest ? { latest: brief(latest), format: latest.spec.format, type: latest.spec.type } : {}) });
      }
      return ok(out);
    },
  );

  server.registerTool(
    "get_video_project",
    {
      description:
        "One video project: its spec (the editable source of truth: edit it with a video.revise patch, never by producing the video again), each scene with what it says and whether its narration and recording are stored (stored ones are re-used), the rendered outputs, any editable-timeline exports, quality warnings, and the revision history. revision picks an earlier one (to compare, or to roll back to with video.revise fromRevision). Read-only.",
      inputSchema: { projectId: z.uuid(), revision: z.number().int().positive().optional() },
    },
    async ({ projectId, revision }) => {
      const project = await store.get(projectId);
      if (!project || (onlyVertical && project.vertical !== onlyVertical)) return fail(`There is no video project ${projectId} (list_video_projects shows them)`);
      const revisions = await store.revisions(projectId);
      const r = revisions.find((x) => x.revision === (revision ?? project.current));
      if (!r) return fail(`"${project.title}" has no revision ${revision ?? project.current} (it has 1 to ${project.current})`);
      return ok({
        id: project.id,
        title: project.title,
        vertical: project.vertical,
        status: project.status,
        ...(project.status === "archived" ? { note: "Archived: its recordings and narration were deleted, so it can't be revised; the spec below can be produced again." } : {}),
        revision: r.revision,
        latest_revision: project.current,
        spec: r.spec,
        scenes: scenesOf(project, r),
        outputs: {
          ...(r.outputs.video ? { video: r.outputs.video } : {}),
          ...(r.outputs.captionsUrl ? { captions: r.outputs.captionsUrl } : {}),
          exports: (r.outputs.exports ?? []).map((e) => ({ format: e.format, at: e.at, timeline: e.url, files: e.files, ...(e.captionsUrl ? { captions: e.captionsUrl } : {}) })),
        },
        warnings: lintSpec(r.spec),
        history: revisions.map(brief),
      });
    },
  );

  return server;
}
