import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRANDS, type VideoSpecInput } from "../src/spec";

/**
 * Sample: a 16:9 OpenD feature walkthrough, "Edit a topic in the browser and
 * publish it". Every claim is from the OpenD docs (see `sources`), and the
 * capture runs against a local stand-in page, so it renders with no login,
 * no paid API and no network.
 */
export function sampleSpec(baseUrl: string): VideoSpecInput {
  const app = `${baseUrl.replace(/\/$/, "")}/index.html`;
  return {
    id: "opend-editor-walkthrough",
    title: "OpenD: edit a topic in the browser and publish it",
    product: "opend",
    type: "demo",
    format: "16:9",
    fps: 30,
    brand: BRANDS.opend,
    voice: { provider: "flite" },
    captions: { enabled: true, style: "word" },
    scenes: [
      {
        id: "hook",
        kind: "title",
        heading: "Fix your docs without leaving the browser",
        subheading: "The OpenD web editor",
        narration: "Spotted a mistake in your docs? Fix it right in the browser.",
      },
      {
        id: "open-topic",
        kind: "capture",
        narration: "On the Files page, choose the topic. Files you changed on your branch are marked changed.",
        steps: [
          { action: "goto", url: app },
          { action: "wait", ms: 600 },
          { action: "highlight", selector: "#file-widget", ms: 1200 },
          { action: "click", selector: "#file-widget" },
        ],
      },
      {
        id: "edit",
        kind: "capture",
        narration: "Edit it on the Visual tab. The title, short description and body are editable in place, and block settings decide who sees each block.",
        steps: [
          { action: "goto", url: app },
          { action: "click", selector: "#file-widget" },
          { action: "click", selector: "#shortdesc" },
          { action: "press", key: "End" },
          { action: "type", selector: "#shortdesc", text: " Readers get the right topic for the screen they are on.", delayMs: 35 },
          { action: "zoom", selector: ".settings", scale: 1.5, ms: 1200 },
        ],
      },
      {
        id: "preview",
        kind: "capture",
        narration: "The Preview tab shows your unsaved text. Choose an audience and Show, to see only what those readers see.",
        steps: [
          { action: "goto", url: app },
          { action: "click", selector: "#file-widget" },
          { action: "click", selector: "[data-tab=preview]" },
          { action: "select", selector: "#audience", value: "reader" },
          { action: "click", selector: "#show" },
          { action: "highlight", selector: "#preview-body", ms: 1400 },
        ],
      },
      {
        id: "save-publish",
        kind: "capture",
        narration: "Save commits to your working branch. Then Publish opens one pull request, and merges it when nothing blocks the merge.",
        steps: [
          { action: "goto", url: app },
          { action: "click", selector: "#file-widget" },
          { action: "click", selector: "#save" },
          { action: "highlight", selector: "#saved", ms: 1000 },
          { action: "click", selector: "[data-nav=publish]" },
          { action: "click", selector: "#publish" },
          { action: "highlight", selector: "#published", ms: 1400 },
        ],
      },
      {
        id: "recap",
        kind: "slide",
        heading: "Edit, preview, publish",
        bullets: ["Visual or Source editing", "Preview as different readers", "One pull request per publish"],
        narration: "Edit, preview as your readers, and publish through your normal GitHub review.",
      },
      {
        id: "cta",
        kind: "outro",
        heading: "OpenD",
        cta: "Read the editor guide",
        url: "docs.opend.app",
        narration: "Read the editor guide at docs dot open D dot app.",
      },
    ],
    sources: [
      { tool: "opend.read_topic", ref: "opend:topics/editor/editor-edit", note: "Files page, changed marker, Visual tab, Block settings, Preview tab with Show the page for, Save to working branch" },
      { tool: "opend.read_topic", ref: "opend:topics/editor/editor-publish", note: "Publish opens one pull request; merges at once if nothing blocks; message text" },
    ],
  };
}

export const SAMPLE_SITE_DIR = fileURLToPath(new URL("./opend-editor/", import.meta.url));

/** Serves the stand-in page on 127.0.0.1 (a random port). */
export async function serveSample(dir = SAMPLE_SITE_DIR): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/" && path !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(join(dir, "index.html")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, close: () => new Promise((r) => server.close(() => r())) };
}
