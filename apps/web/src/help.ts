/**
 * Context-sensitive help from the OpenD docs site (the DITA sources are in docs/ at the
 * repo root; routes map to topics in docs/help-contexts.yaml).
 *
 * - The server says where the docs are (GET /api/help/config). With an embed secret set
 *   there, the OpenD widget is loaded from the docs site and the "?" button (or F1) opens
 *   its side panel, signed in as the current user (GET /api/help/token).
 * - Without one, or when the docs site can't be reached, "?" opens the help page itself in a
 *   new tab (help-topics.json, generated from docs/ by scripts/help-topics.ts). That works on
 *   a private docs site too: it signs the reader in, then shows the page.
 *
 * Markup: `data-help-key="approvals.revise"` on a field, button or group, and
 * `data-help-pane="org.edit"` on a tab, pane or dialog. The widget watches focus and
 * clicks itself; the new-tab fallback reads the focused element's nearest key. Keys are
 * dot-separated and fall back to their parents, so a key without its own topic opens
 * the page's help. Every key used here must exist in docs/ (a topic's resourceid).
 */
import { useCallback, useEffect, useState } from "react";
import type { Connection } from "./api";
import TOPICS from "./help-topics.json";

export interface HelpConfig {
  docsUrl: string;
  app: string;
  /** The server can sign embed tokens, so the in-app panel is available. */
  embed: boolean;
}

interface OpenDHelpApi {
  init(options: {
    docsUrl: string;
    app: string;
    getToken?: () => Promise<string>;
    zIndex?: number;
    onNavigate?: (topic: { topicId: string; title: string }) => void;
  }): void;
  setContext(context: { key?: string; path?: string }): void;
  open(context?: { key?: string; path?: string }): void;
  close(): void;
  toggle(context?: { key?: string; path?: string }): void;
  isOpen(): boolean;
}

declare global {
  interface Window {
    OpenDHelp?: OpenDHelpApi;
  }
}

/** The app path the docs' help-contexts.yaml routes match: the hash route without "#" or query. */
export function helpPath(hash: string = location.hash): string {
  const route = hash.replace(/^#\/?/, "").split("?")[0] || "inbox";
  return `/${route}`;
}

/** The nearest `data-help-key`, else `data-help-pane`, around an element. */
export function helpSignals(el: Element | null): { focus?: string; pane?: string } {
  const key = el?.closest("[data-help-key]")?.getAttribute("data-help-key") ?? undefined;
  const pane = el?.closest("[data-help-pane]")?.getAttribute("data-help-pane") ?? undefined;
  return { ...(key ? { focus: key } : {}), ...(pane ? { pane } : {}) };
}

/** Hash routes whose help key isn't the route's own name (see docs/help-contexts.yaml). */
const ROUTE_KEYS: Record<string, string> = { "": "inbox", task: "inbox.task", briefing: "notifications.briefing" };

/** The help key of the page at an app path, e.g. "/task/123" → "inbox.task". */
export function viewKey(path: string): string {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return ROUTE_KEYS[page] ?? page;
}

/**
 * The docs page for the first signal that has help (focus, then pane, then the view), each
 * falling back to its parents (approvals.revise → approvals), else the docs' front page.
 */
export function topicUrl(docsUrl: string, path: string, signals: { focus?: string; pane?: string } = {}, topics: Record<string, string> = TOPICS): string {
  for (const key of [signals.focus, signals.pane, viewKey(path)]) {
    const parts = key ? key.split(".") : [];
    for (let n = parts.length; n > 0; n--) {
      const hit = topics[parts.slice(0, n).join(".")];
      if (hit) return `${docsUrl}/${hit}`;
    }
  }
  return `${docsUrl}/`;
}

let widget: Promise<OpenDHelpApi | null> | null = null;

/** Loads /embed/opend-help.js from the docs site once; null when it can't be loaded. */
function loadWidget(cfg: HelpConfig, conn: Connection): Promise<OpenDHelpApi | null> {
  widget ??= new Promise<OpenDHelpApi | null>((resolve) => {
    if (window.OpenDHelp) return resolve(window.OpenDHelp);
    const script = document.createElement("script");
    script.src = `${cfg.docsUrl}/embed/opend-help.js`;
    script.async = true;
    script.onload = () => resolve(window.OpenDHelp ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  }).then((api) => {
    if (!api) {
      widget = null; // try again next time the shell mounts
      return null;
    }
    api.init({
      docsUrl: cfg.docsUrl,
      app: cfg.app,
      // Above the app's dialogs and sheets, below nothing that matters.
      zIndex: 1000,
      getToken: async () => {
        const res = await fetch(`${conn.baseUrl}/api/help/token`, {
          credentials: "include",
          headers: { ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}), "x-cc-request": "1" },
        });
        if (!res.ok) throw new Error(`help token: ${res.status}`);
        return res.text();
      },
    });
    return api;
  });
  return widget ?? Promise.resolve(null);
}

export interface Help {
  /** Opens (or closes) help for what the user is on now. */
  toggle: () => void;
  /** The panel is embedded; false means "?" opens a new tab. */
  embedded: boolean;
}

/**
 * Loads the help config and widget for the signed-in shell, keeps the widget's view in
 * step with the hash route, and binds F1. `route` is anything that changes on navigation.
 */
export function useHelp(conn: Connection, route: string): Help {
  const [cfg, setCfg] = useState<HelpConfig | null>(null);
  const [api, setApi] = useState<OpenDHelpApi | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${conn.baseUrl}/api/help/config`, {
      credentials: "include",
      headers: { ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}), "x-cc-request": "1" },
    })
      .then((r) => (r.ok ? (r.json() as Promise<HelpConfig>) : null))
      .then(async (c) => {
        if (!live || !c) return;
        setCfg(c);
        // The panel signs in as a user: with an admin-token connection there is no user to sign in as.
        if (c.embed && !conn.token) {
          const loaded = await loadWidget(c, conn);
          if (live) setApi(loaded);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conn]);

  // A new view: tell the widget, which also moves an open panel to the new page's help.
  useEffect(() => {
    api?.setContext({ path: helpPath() });
  }, [api, route]);

  const toggle = useCallback(() => {
    if (api) return api.toggle();
    const docsUrl = cfg?.docsUrl ?? "https://command-centre.opend.app";
    window.open(topicUrl(docsUrl, helpPath(), helpSignals(document.activeElement)), "_blank", "noopener");
  }, [api, cfg]);

  // F1 opens help for the focused field, wherever focus is (the widget then reads it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F1") return;
      e.preventDefault();
      if (api && !api.isOpen()) api.open();
      else toggle();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [api, toggle]);

  return { toggle, embedded: Boolean(api) };
}
