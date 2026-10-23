import type { Event, Job, OrgTree, Proposal, Task, VerticalManifest, WorkerNode, AgentMessage, AgentRun } from "@cc/core";

/** Connection settings. The desktop app can point at a remote server; the PWA defaults to its own origin. */
export interface Connection {
  baseUrl: string;
  token: string;
}

const KEY = "cc.connection";

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Connection) : null;
  } catch {
    return null;
  }
}

export function saveConnection(conn: Connection | null): void {
  try {
    if (conn) localStorage.setItem(KEY, JSON.stringify(conn));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode): the session still works until reload.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TaskDetail = {
  task: Task;
  event: Event | null;
  runs: (AgentRun & { messages: AgentMessage[] })[];
  proposals: Proposal[];
};

export type Stats = {
  day: string;
  costTodayUsd: number;
  costTodayByVertical: Record<string, number>;
  budgets: { globalUsd: number | null; verticals: Record<string, number> };
  pendingApprovals: number;
};

export type DigestCounts = { done: number; failed: number; deferred: number; autoActions: number; pendingApprovals: number; jobs: number };

/** One vertical's deterministic daily digest (GET /api/digest). */
export type Digest = {
  vertical: string;
  name: string;
  date: string;
  costUsd: number;
  budgetUsd: number | null;
  counts: DigestCounts;
  headline: string;
  markdown: string;
};

export type DigestDay = {
  date: string;
  timezone: string;
  totals: DigestCounts & { costUsd: number; budgetUsd: number | null };
  digests: Digest[];
};

/** A configured social account as GET /api/social/accounts shows it (never credentials). */
export type SocialAccount = {
  id: string;
  platform: string;
  vertical: string;
  handle: string | null;
  displayName: string | null;
  inbound: boolean;
  inboundSupported: boolean;
  capabilities: {
    publish: boolean;
    reply: boolean;
    dm: boolean;
    inbound: boolean;
    media: ("image" | "video")[];
    maxTextLength: number;
    requiresMedia?: boolean;
    requiresTitle?: boolean;
    requiresTarget?: boolean;
  } | null;
};

export type MediaRef = { url: string; type: "image" | "video"; alt?: string };

export type PostContent = { text: string; media?: MediaRef[]; link?: string; title?: string; target?: string };

export type ScheduledPost = {
  id: string;
  campaignId: string;
  title: string;
  accountId: string;
  platform: string;
  vertical: string;
  content: PostContent;
  publishAt: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  result: { ok: boolean; id?: string; url?: string | null; error?: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialEvent = Event & { taskId: string | null; taskStatus: string | null };

export type Campaign = { title: string; posts: { accountId: string; content: PostContent }[]; publishAt?: string };

export function createApi(conn: Connection) {
  const base = conn.baseUrl.replace(/\/$/, "");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json", ...init.headers },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
    return body as T;
  };
  const post = <T>(path: string, json?: unknown) =>
    call<T>(path, { method: "POST", body: json === undefined ? undefined : JSON.stringify(json) });

  return {
    wsUrl: `${base.replace(/^http/, "ws") || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`}/ws`,
    token: conn.token,
    verticals: () => call<VerticalManifest[]>("/verticals"),
    chat: (text: string, vertical?: string) => post<{ event: Event; task: Task }>("/chat", { text, vertical }),
    tasks: (status?: string, filter: { vertical?: string; role?: string } = {}) => {
      const q = new URLSearchParams(Object.entries({ status, ...filter }).filter(([, v]) => v) as [string, string][]).toString();
      return call<Task[]>(`/tasks${q ? `?${q}` : ""}`);
    },
    org: () => call<OrgTree>("/org"),
    task: (id: string) => call<TaskDetail>(`/tasks/${id}`),
    retry: (id: string) => post<Task>(`/tasks/${id}/retry`),
    digest: (options: { vertical?: string; date?: string } = {}) =>
      call<DigestDay>(`/digest?${new URLSearchParams(Object.entries(options).filter(([, v]) => v) as [string, string][])}`),
    proposals: (status?: string) => call<Proposal[]>(`/proposals${status ? `?status=${status}` : ""}`),
    approve: (id: string) => post<Proposal>(`/proposals/${id}/approve`),
    reject: (id: string) => post<Proposal>(`/proposals/${id}/reject`),
    nodes: () => call<WorkerNode[]>("/nodes"),
    jobs: () => call<Job[]>("/jobs"),
    brainSearch: (q: string) => call<{ path: string; title: string; snippet: string }[]>(`/brain/search?q=${encodeURIComponent(q)}`),
    brainList: (folder = "") => call<string[]>(`/brain/list?folder=${encodeURIComponent(folder)}`),
    brainNote: (path: string) =>
      call<{ path: string; frontmatter: Record<string, unknown>; body: string }>(`/brain/note?path=${encodeURIComponent(path)}`),
    stats: () => call<Stats>("/stats"),
    pushKey: () => call<{ publicKey: string | null }>("/push/key"),
    pushSubscribe: (sub: PushSubscriptionJSON) => post("/push/subscribe", sub),
    socialAccounts: () => call<SocialAccount[]>("/social/accounts"),
    socialEvents: () => call<SocialEvent[]>("/social/events"),
    socialScheduled: () => call<ScheduledPost[]>("/social/scheduled"),
    cancelScheduled: (id: string) => post<ScheduledPost>(`/social/scheduled/${id}/cancel`),
    compose: (campaign: Campaign) => post<Proposal>("/social/compose", campaign),
    /** Uploads an image or video as the raw body; returns its public URL. */
    uploadMedia: async (file: File) => {
      const res = await fetch(`${base}/api/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${conn.token}`, "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
      return body as { id: string; url: string; type: "image" | "video"; contentType: string; bytes: number };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
