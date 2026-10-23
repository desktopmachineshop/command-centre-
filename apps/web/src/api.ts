import type { Event, Job, Proposal, Task, VerticalManifest, WorkerNode, AgentMessage, AgentRun } from "@cc/core";

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
    tasks: (status?: string) => call<Task[]>(`/tasks${status ? `?status=${status}` : ""}`),
    task: (id: string) => call<TaskDetail>(`/tasks/${id}`),
    proposals: (status?: string) => call<Proposal[]>(`/proposals${status ? `?status=${status}` : ""}`),
    approve: (id: string) => post<Proposal>(`/proposals/${id}/approve`),
    reject: (id: string) => post<Proposal>(`/proposals/${id}/reject`),
    nodes: () => call<WorkerNode[]>("/nodes"),
    jobs: () => call<Job[]>("/jobs"),
    brainSearch: (q: string) => call<{ path: string; title: string; snippet: string }[]>(`/brain/search?q=${encodeURIComponent(q)}`),
    brainList: (folder = "") => call<string[]>(`/brain/list?folder=${encodeURIComponent(folder)}`),
    brainNote: (path: string) =>
      call<{ path: string; frontmatter: Record<string, unknown>; body: string }>(`/brain/note?path=${encodeURIComponent(path)}`),
    stats: () => call<{ costTodayUsd: number; pendingApprovals: number }>("/stats"),
    pushKey: () => call<{ publicKey: string | null }>("/push/key"),
    pushSubscribe: (sub: PushSubscriptionJSON) => post("/push/subscribe", sub),
  };
}

export type Api = ReturnType<typeof createApi>;
