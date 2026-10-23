import type { Event, Job, OrgTree, Proposal, Task, VerticalManifest, WorkerNode, AgentMessage, AgentRun } from "@cc/core";

/**
 * Connection settings. Normally `token` is null: the server set an HttpOnly session
 * cookie at sign-in, and nothing is stored here. With "Use an admin token instead",
 * the token (and optionally another server's URL) is kept in localStorage as before.
 */
export interface Connection {
  baseUrl: string;
  token: string | null;
}

/** Same-origin cookie session. */
export const COOKIE_SESSION: Connection = { baseUrl: "", token: null };

const KEY = "cc.connection";

/** The stored admin-token connection, if the user chose that. */
export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(KEY);
    const conn = raw ? (JSON.parse(raw) as Connection) : null;
    return conn?.token ? conn : null;
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
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** The signed-in user (GET /api/auth/me). */
export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  lastLoginAt: string | null;
  totpEnabled: boolean;
};

export type Me = { via: "token"; user: null } | { via: "session"; sessionId: string; user: User; recoveryCodesLeft: number };

export type SessionInfo = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
};

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

export type PostContent = {
  text: string;
  media?: MediaRef[];
  link?: string;
  title?: string;
  target?: string;
  options?: Record<string, unknown>;
};

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

/**
 * `onUnauthorized` runs when the server answers 401 to a signed-in call (session
 * expired or revoked elsewhere), so the app can go back to the sign-in screen.
 */
export function createApi(conn: Connection, onUnauthorized?: () => void) {
  const base = conn.baseUrl.replace(/\/$/, "");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      // The session cookie rides along; X-CC-Request is the server's CSRF check for cookie requests.
      credentials: "include",
      headers: {
        ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
        "content-type": "application/json",
        "x-cc-request": "1",
        ...init.headers,
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/setup")) onUnauthorized?.();
      throw new ApiError(res.status, body?.error ?? res.statusText, body);
    }
    return body as T;
  };
  const post = <T>(path: string, json?: unknown, headers?: Record<string, string>) =>
    call<T>(path, { method: "POST", body: json === undefined ? undefined : JSON.stringify(json), headers });

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
      // Same auth as `call`: session cookie (+ CSRF header) or the admin token.
      const res = await fetch(`${base}/api/media`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
          "content-type": file.type || "application/octet-stream",
          "x-cc-request": "1",
        },
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) onUnauthorized?.();
        throw new ApiError(res.status, body?.error ?? res.statusText, body);
      }
      return body as { id: string; url: string; type: "image" | "video"; contentType: string; bytes: number };
    },

    // --- auth ---
    authStatus: () => call<{ setupRequired: boolean }>("/auth/status"),
    /** First-run setup: the admin token proves this is the server's owner. */
    setup: (adminToken: string, user: { email: string; name: string; password: string }) =>
      post<{ user: User }>("/auth/setup", user, { authorization: `Bearer ${adminToken}` }),
    login: (email: string, password: string, totp?: string) => post<{ user: User }>("/auth/login", { email, password, totp }),
    logout: () => post<{ ok: true }>("/auth/logout"),
    me: () => call<Me>("/auth/me"),
    changePassword: (currentPassword: string, newPassword: string) =>
      post<{ ok: true; revokedSessions: number }>("/auth/password", { currentPassword, newPassword }),
    sessions: () => call<SessionInfo[]>("/auth/sessions"),
    /** A session id, or "others" for every other device. */
    revokeSession: (id: string) => call<{ ok: true; revoked: number }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    totpSetup: () => post<{ secret: string; otpauthUrl: string }>("/auth/totp/setup"),
    totpEnable: (code: string) => post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code }),
    totpDisable: (password: string) => post<{ ok: true }>("/auth/totp/disable", { password }),
  };
}

export type Api = ReturnType<typeof createApi>;
