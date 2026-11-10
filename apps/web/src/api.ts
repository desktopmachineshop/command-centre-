import type { Event, Job, SetupRoleId, OrgConfig, OrgConfigVersion, OrgTree, Proposal, Task, VerticalManifest, WorkerNode, AgentMessage, AgentRun, VoiceResponse } from "@cc/core";
import type { NotificationCategory, NotificationDevice, NotificationPrefs, NotificationPriority, StoredNotification } from "@cc/core";
import type { CardResult } from "@cc/core";
import type { IntegrationsView, SavePatch, SaveResult } from "./integrations";

/**
 * Connection settings. Normally `token` is null: the server set an HttpOnly session
 * cookie at sign-in, and nothing is stored here. With "Use an admin token instead",
 * the token (and optionally another server's URL) is kept in localStorage as before.
 */
/** A file uploaded from the chat box (POST /api/chat/files). */
export interface ChatFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

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

export interface BrainNote {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
  /** The whole file as the editor shows it (only from a read). */
  raw?: string;
}

export interface BrainNoteVersion {
  version: number;
  author: string;
  message: string | null;
  deleted: boolean;
  createdAt: string;
}

/** A computer linked from the desktop app (it has its own worker token). */
export interface DesktopDevice {
  id: string;
  name: string;
  userId: string | null;
  /** The worker node it last connected as. */
  nodeId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The Windows installer the Desktop workflow last built. */
export interface DesktopInstaller {
  version: string;
  filename: string;
  size: number;
  sha256: string;
  commit: string | null;
  uploadedAt: string;
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
  runs: (AgentRun & { messages: AgentMessage[]; response?: VoiceResponse | null })[];
  proposals: Proposal[];
  /** The hidden handover note agents carry the task on from (server handover.ts); null before the first run. */
  handover?: { text: string; at: string } | null;
};

export type Stats = {
  day: string;
  costTodayUsd: number;
  costTodayByVertical: Record<string, number>;
  budgets: { globalUsd: number | null; verticals: Record<string, number> };
  pendingApprovals: number;
  /** Tasks running or queued to run. */
  activeTasks?: number;
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
  /** Other businesses that may post from it too (cross-posting). */
  alsoVerticals?: string[];
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

/** An approved reply, post or DM of a paced account (Reddit with your own login) waiting for its slot, or how it went. */
export type SocialOutboxEntry = {
  id: string;
  accountId: string;
  vertical: string;
  actionType: "social.post" | "social.reply" | "social.dm";
  payload: { text?: string; userId?: string; target?: { id?: string; subreddit?: string }; content?: PostContent };
  notBefore: string;
  status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  result: { ok: boolean; id?: string; url?: string | null; error?: string } | null;
  createdAt: string;
};

export type SocialEvent = Event & { taskId: string | null; taskStatus: string | null };

// --- pa: the Today page (GET /api/pa/today etc.) ---
export type CalendarEvent = {
  accountId: string;
  calendarId: string;
  calendarName: string;
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  busy: boolean;
  response: string | null;
  url: string | null;
};

export type Reminder = {
  id: string;
  text: string;
  dueAt: string;
  recurrence: string | null;
  vertical: string;
  createdBy: "dave" | "agent";
  status: "pending" | "sent" | "done" | "cancelled";
  snoozedUntil: string | null;
  /** A number to call when it fires (the Call button), or null. */
  phone: string | null;
};

/** A Google contact (GET /api/pa/contacts?q=). */
export type Contact = {
  accountId: string;
  id: string;
  name: string;
  phones: { value: string; type: string | null }[];
  emails: { value: string; type: string | null }[];
  company: string | null;
  notes: string | null;
};

export type TodoItem = { id: string; listId: string; text: string; done: boolean; dueDate: string | null; position: number };
export type TodoList = { id: string; vertical: string; name: string; position: number; openCount: number; doneCount: number };

export type TodayView = {
  day: string;
  timeZone: string;
  calendarConfigured: boolean;
  events: CalendarEvent[];
  calendarErrors: string[];
  reminders: Reminder[];
  upcoming: Reminder[];
  lists: (TodoList & { items: TodoItem[] })[];
};
// --- end pa ---

export type Campaign = { title: string; posts: { accountId: string; content: PostContent }[]; publishAt?: string };

// --- voice (Drive mode) ---
export type VoiceConfig = {
  /** `streaming`: live transcription over /ws/voice (self-hosted on the server). */
  stt: { provider: string; model: string; streaming?: boolean } | null;
  tts: { provider: string; model: string; voice: string } | null;
  maxUploadBytes: number;
  maxSeconds: number;
  language: string;
  calendar: boolean;
};

/** A self-hosted voice (GET /api/voice/voices). */
export type VoiceOption = {
  id: string;
  label: string;
  description: string;
  /** "elevenlabs": one of the ElevenLabs voices listed on the Accounts page (no download). */
  tier: "fast" | "natural" | "elevenlabs";
  sizeMb: number;
  status: "missing" | "installing" | "ready" | "failed";
  error: string | null;
  isDefault: boolean;
};
export type VoiceList = { default: string | null; voices: VoiceOption[] };

/** One line of POST /api/voice/turn's stream. */
export type VoiceTurnEvent =
  | { delta: string }
  /** `continued`: Dave's words went to the task that gave the last answer, which resumes. */
  | { done: true; text: string; handoff: { taskId: string | null; continued?: boolean } | null }
  | { error: string };

export type VoiceTurnRequest = {
  text: string;
  vertical?: string;
  role?: string;
  talkingTo?: string;
  lastSpoken?: string | null;
  /** The task whose answer Dave last heard, and that answer: a follow-up on it continues that task. */
  lastTaskId?: string | null;
  lastAnswer?: string | null;
};

export type VoiceBriefing = { text: string; approvals: { count: number }; cost: { todayUsd: number } };

export type NextApproval = {
  /** A batch is one approval: its first item, with `batchId` and `batchSize`. */
  proposal: (Pick<Proposal, "id" | "vertical" | "actionType" | "summary" | "createdAt"> & { batchId?: string; batchSize?: number }) | null;
  position: number;
  remaining: number;
  text: string;
};
// --- end voice ---

/**
 * `onUnauthorized` runs when the server answers 401 to a signed-in call (session
 * expired or revoked elsewhere), so the app can go back to the sign-in screen.
 */
export function createApi(conn: Connection, onUnauthorized?: () => void) {
  const base = conn.baseUrl.replace(/\/$/, "");
  /** Auth for raw (non-JSON) requests: the session cookie plus CSRF header, or the admin token. */
  const authed = (headers: Record<string, string>): RequestInit => ({
    credentials: "include",
    headers: { ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}), "x-cc-request": "1", ...headers },
  });
  const failed = async (res: Response) => {
    const body = await res.json().catch(() => null);
    if (res.status === 401) onUnauthorized?.();
    return new ApiError(res.status, body?.error ?? res.statusText, body);
  };
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
      if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/setup") && !path.startsWith("/auth/dmsid")) onUnauthorized?.();
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
    /** `role` (an org role id, with its `vertical`) sends it to that role rather than whichever fits. */
    /** `files`: ids from `uploadChatFile`, handed to the agent with the message. */
    chat: (text: string, vertical?: string, options: { voice?: boolean; role?: string; files?: string[] } = {}) =>
      post<{ event: Event; task: Task }>("/chat", {
        text,
        vertical,
        ...(options.role ? { role: options.role } : {}),
        ...(options.voice ? { voice: true } : {}),
        ...(options.files?.length ? { files: options.files } : {}),
      }),
    /** A file pasted, dropped or attached in the chat box, uploaded ahead of the message that sends it. */
    uploadChatFile: async (file: File, signal?: AbortSignal) => {
      const res = await fetch(`${base}/api/chat/files?name=${encodeURIComponent(file.name || "pasted file")}`, {
        method: "POST",
        ...authed({ "content-type": file.type || "application/octet-stream" }),
        body: file,
        signal,
      });
      if (!res.ok) throw await failed(res);
      return (await res.json()) as ChatFile;
    },
    tasks: (status?: string, filter: { vertical?: string; role?: string } = {}) => {
      const q = new URLSearchParams(Object.entries({ status, ...filter }).filter(([, v]) => v) as [string, string][]).toString();
      return call<Task[]>(`/tasks${q ? `?${q}` : ""}`);
    },
    /** Live records for the references in an agent's ```card block (docs/CARDS.md). */
    cards: (refs: string[]) => call<{ cards: CardResult[] }>(`/cards?refs=${encodeURIComponent(refs.join(","))}`).then((r) => r.cards),
    org: () => call<OrgTree>("/org"),
    // Org editing: `unit` is a vertical id or "chief-of-staff"; each call returns the whole config again.
    orgConfig: () => call<OrgConfig>("/org/config"),
    orgSave: (unit: string, data: unknown, expectedVersion: number) =>
      call<OrgConfig>(`/org/config/${encodeURIComponent(unit)}`, { method: "PUT", body: JSON.stringify({ data, expectedVersion }) }),
    orgReset: (unit: string, expectedVersion: number) =>
      call<OrgConfig>(`/org/config/${encodeURIComponent(unit)}?expectedVersion=${expectedVersion}`, { method: "DELETE" }),
    orgHistory: (unit: string) => call<OrgConfigVersion[]>(`/org/config/${encodeURIComponent(unit)}/history`),
    orgRestore: (unit: string, version: number) => post<OrgConfig>(`/org/config/${encodeURIComponent(unit)}/restore`, { version }),
    task: (id: string) => call<TaskDetail>(`/tasks/${id}`),
    retry: (id: string) => post<Task>(`/tasks/${id}/retry`),
    /** Stops a task's run (or takes it off the queue), with the open work it handed off. */
    stopTask: (id: string) => post<{ stopped: Task[] }>(`/tasks/${encodeURIComponent(id)}/stop`),
    /** Stops every running, queued or deferred task. */
    stopAll: () => post<{ stopped: Task[] }>("/tasks/stop-all"),
    digest: (options: { vertical?: string; date?: string } = {}) =>
      call<DigestDay>(`/digest?${new URLSearchParams(Object.entries(options).filter(([, v]) => v) as [string, string][])}`),
    proposals: (status?: string) => call<Proposal[]>(`/proposals${status ? `?status=${status}` : ""}`),
    /** A task's proposals plus those of every task it handed off (the chat shows them inline). */
    chainProposals: (taskId: string) => call<{ taskIds: string[]; proposals: Proposal[] }>(`/tasks/${encodeURIComponent(taskId)}/chain-proposals`),
    approve: (id: string) => post<Proposal>(`/proposals/${id}/approve`),
    reject: (id: string) => post<Proposal>(`/proposals/${id}/reject`),
    /** Every item of a batch still pending, approved (or rejected) in one go. */
    approveBatch: (batchId: string) => post<Proposal[]>(`/batches/${encodeURIComponent(batchId)}/approve`),
    rejectBatch: (batchId: string) => post<Proposal[]>(`/batches/${encodeURIComponent(batchId)}/reject`),
    /** Change what a pending proposal will do before approving it. */
    editProposal: (id: string, payload: Record<string, unknown>) =>
      call<Proposal>(`/proposals/${id}`, { method: "PATCH", body: JSON.stringify({ payload }) }),
    /** Reject it and send the feedback to the agent, which proposes a revised version. */
    reviseProposal: (id: string, feedback: string) => post<{ proposal: Proposal; task: Task }>(`/proposals/${id}/revise`, { feedback }),
    nodes: () => call<WorkerNode[]>("/nodes"),
    /** One click on the Devices page: install what a role is missing on that computer (a setup.install job). */
    installRole: (nodeId: string, role: SetupRoleId) => post<Job>(`/nodes/${encodeURIComponent(nodeId)}/setup`, { role }),
    /** Update now: that computer's desktop app installs its newest build (after any running job). */
    updateApp: (nodeId: string) => post<{ requested: true }>(`/nodes/${encodeURIComponent(nodeId)}/update`),
    // --- desktop app: linking computers by signing in, and the installer download ---
    desktopDevices: () => call<DesktopDevice[]>("/desktop/devices"),
    unlinkDesktop: (id: string) => call<{ revoked: true }>(`/desktop/devices/${id}`, { method: "DELETE" }),
    /** Usage by folder, the server volume and the newest files (Storage page). */
    storage: (o: { folder?: string; vertical?: string } = {}) =>
      call<StorageOverview>(`/storage?limit=500${o.folder ? `&folder=${encodeURIComponent(o.folder)}` : ""}${o.vertical ? `&vertical=${encodeURIComponent(o.vertical)}` : ""}`),
    /** Moves a file to another vertical ("shared" for none); on Drive it moves folder too. */
    moveStoredFile: (id: string, vertical: string) =>
      call<StoredFile>(`/storage/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ vertical: vertical === "shared" ? null : vertical }) }),
    deleteStoredFile: (id: string) => call<{ ok: true }>(`/storage/${encodeURIComponent(id)}`, { method: "DELETE" }),
    desktopLink: (code: string) => call<{ code: string; name: string; createdAt: string; approved: boolean }>(`/desktop/link/${encodeURIComponent(code)}`),
    /** `autoKey`: the key the desktop app put in the page it opened, to approve without the button. */
    approveDesktopLink: (code: string, autoKey?: string) => post<DesktopDevice>(`/desktop/link/${encodeURIComponent(code)}/approve`, autoKey ? { autoKey } : undefined),
    desktopInstaller: () => call<{ installer: DesktopInstaller | null }>("/desktop/installer"),
    /** A plain link: the session cookie authenticates the GET, so the browser downloads it itself. */
    desktopDownloadUrl: `${base}/api/desktop/download`,
    /** For an admin-token connection, which a plain link can't authenticate: fetches the installer. */
    desktopDownload: async () => {
      const res = await fetch(`${base}/api/desktop/download`, authed({}));
      if (!res.ok) throw await failed(res);
      return res.blob();
    },
    jobs: () => call<Job[]>("/jobs"),
    cancelJob: (id: string) => post<Job>(`/jobs/${id}/cancel`),
    brainSearch: (q: string) => call<{ path: string; title: string; snippet: string }[]>(`/brain/search?q=${encodeURIComponent(q)}`),
    brainList: (folder = "") => call<string[]>(`/brain/list?folder=${encodeURIComponent(folder)}`),
    brainNote: (path: string) => call<BrainNote>(`/brain/note?path=${encodeURIComponent(path)}`),
    /** `expectedVersion` is the version the editor opened (0 for a new note); a newer one gives a 409. */
    brainSave: (path: string, raw: string, expectedVersion: number) =>
      call<BrainNote>("/brain/note", { method: "PUT", body: JSON.stringify({ path, raw, expectedVersion }) }),
    brainDelete: (path: string, expectedVersion: number) =>
      call<{ deleted: true }>(`/brain/note?path=${encodeURIComponent(path)}&expectedVersion=${expectedVersion}`, { method: "DELETE" }),
    brainHistory: (path: string) => call<BrainNoteVersion[]>(`/brain/history?path=${encodeURIComponent(path)}`),
    brainVersion: (path: string, version: number) =>
      call<{ path: string; frontmatter: Record<string, unknown>; body: string }>(`/brain/version?path=${encodeURIComponent(path)}&version=${version}`),
    brainRestore: (path: string, version: number) => post<BrainNote>("/brain/restore", { path, version }),
    stats: () => call<Stats>("/stats"),
    pushKey: () => call<{ publicKey: string | null }>("/push/key"),
    pushSubscribe: (sub: PushSubscriptionJSON) => post("/push/subscribe", sub),
    socialAccounts: () => call<SocialAccount[]>("/social/accounts"),
    socialEvents: () => call<SocialEvent[]>("/social/events"),
    socialScheduled: () => call<ScheduledPost[]>("/social/scheduled"),
    cancelScheduled: (id: string) => post<ScheduledPost>(`/social/scheduled/${id}/cancel`),
    socialOutbox: () => call<SocialOutboxEntry[]>("/social/outbox"),
    cancelOutbox: (id: string) => post<SocialOutboxEntry>(`/social/outbox/${id}/cancel`),
    compose: (campaign: Campaign) => post<Proposal>("/social/compose", campaign),
    // --- pa ---
    today: (day?: string) => call<TodayView>(`/pa/today${day ? `?day=${day}` : ""}`),
    /** `due` is local Europe/London `YYYY-MM-DDTHH:MM`; `recurrence` is e.g. "weekdays", "weekly:mon,thu", "monthly:15" or "none". */
    getReminder: (id: string) => call<Reminder>(`/pa/reminders/${id}`),
    addReminder: (r: { text: string; due: string; recurrence?: string | null; phone?: string | null }) => post<Reminder>("/pa/reminders", r),
    updateReminder: (id: string, change: { text?: string; due?: string; recurrence?: string | null; phone?: string | null }) =>
      call<Reminder>(`/pa/reminders/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
    cancelReminder: (id: string) => call<Reminder>(`/pa/reminders/${id}`, { method: "DELETE" }),
    completeReminder: (id: string) => post<Reminder>(`/pa/reminders/${id}/complete`),
    snoozeReminder: (id: string, minutes: number) => post<Reminder>(`/pa/reminders/${id}/snooze`, { minutes }),
    searchContacts: (q: string) => call<{ configured: boolean; contacts: Contact[]; errors: string[] }>(`/pa/contacts?q=${encodeURIComponent(q)}`),
    createList: (name: string) => post<TodoList>("/pa/lists", { name }),
    renameList: (id: string, name: string) => call<TodoList>(`/pa/lists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    deleteList: (id: string) => call(`/pa/lists/${id}`, { method: "DELETE" }),
    addItem: (listId: string, text: string) => post<TodoItem[]>(`/pa/lists/${listId}/items`, { text }),
    setItemDone: (id: string, done: boolean) => call<TodoItem>(`/pa/items/${id}`, { method: "PATCH", body: JSON.stringify({ done }) }),
    deleteItem: (id: string) => call(`/pa/items/${id}`, { method: "DELETE" }),
    // --- end pa ---
    // --- voice (Drive mode) ---
    voiceConfig: () => call<VoiceConfig>("/voice/config"),
    voiceBriefing: () => call<VoiceBriefing>("/voice/briefing"),
    nextApproval: (skip: string[] = []) => call<NextApproval>(`/voice/approvals/next${skip.length ? `?skip=${skip.join(",")}` : ""}`),
    replyToTask: (id: string, text: string, voice = true, files?: string[]) =>
      post<Task>(`/tasks/${id}/reply`, { text, voice, ...(files?.length ? { files } : {}) }),
    transcribe: async (audio: Blob, seconds: number, language?: string) => {
      const query = new URLSearchParams({ seconds: seconds.toFixed(1), ...(language ? { language } : {}) });
      const res = await fetch(`${base}/api/voice/transcribe?${query}`, {
        method: "POST",
        ...authed({ "content-type": audio.type || "audio/webm" }),
        body: audio,
      });
      if (!res.ok) throw await failed(res);
      return (await res.json()) as { text: string };
    },
    /** Live transcription socket (self-hosted on the server). */
    voiceListenUrl: `${base.replace(/^http/, "ws") || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`}/ws/voice`,
    voiceWarm: (front = false) => post<{ ok: boolean; front: boolean }>("/voice/warm", { front }),
    /** Drive mode's fast voice front: yields its streamed reply, then whether it handed on to an agent. */
    voiceTurn: async function* (request: VoiceTurnRequest, signal?: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
      const res = await fetch(`${base}/api/voice/turn`, {
        method: "POST",
        ...authed({ "content-type": "application/json" }),
        body: JSON.stringify(request),
        signal,
      });
      if (!res.ok || !res.body) throw await failed(res);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield JSON.parse(line) as VoiceTurnEvent;
        }
      }
      if (buffer.trim()) yield JSON.parse(buffer) as VoiceTurnEvent;
    },
    /**
     * `voice`: a self-hosted voice id. One still downloading speaks in the default voice, or with
     * `fallback: false` (a preview) fails with a 409 `{downloading: true}`. `onFallback` hears why,
     * when the keyed provider failed and the server's own voice spoke instead.
     */
    speak: async (text: string, voice?: string, opts: { fallback?: boolean; onFallback?: (reason: string) => void } = {}) => {
      const res = await fetch(`${base}/api/voice/speak`, {
        method: "POST",
        ...authed({ "content-type": "application/json" }),
        body: JSON.stringify({ text, voice, ...(opts.fallback === false ? { fallback: false } : {}) }),
      });
      if (!res.ok) throw await failed(res);
      // The keyed provider (ElevenLabs, OpenAI) refused, so the server's own voice spoke instead.
      const fellBack = res.headers.get("x-cc-fallback");
      if (fellBack) opts.onFallback?.(fellBack);
      return res.blob();
    },
    voices: () => call<VoiceList>("/voice/voices"),
    installVoice: (id: string) => post<VoiceList>(`/voice/voices/${encodeURIComponent(id)}/install`),
    // --- end voice ---
    /** Uploads an image or video as the raw body; returns its public URL. */
    uploadMedia: async (file: File, vertical?: string) => {
      const res = await fetch(`${base}/api/media${vertical ? `?vertical=${encodeURIComponent(vertical)}` : ""}`, {
        method: "POST",
        ...authed({ "content-type": file.type || "application/octet-stream" }),
        body: file,
      });
      if (!res.ok) throw await failed(res);
      const body = await res.json();
      return body as { id: string; url: string; type: "image" | "video"; contentType: string; bytes: number };
    },

    // --- auth ---
    authStatus: () => call<{ setupRequired: boolean; dmsid?: boolean; dmsidCodeRequired?: boolean }>("/auth/status"),
    /** The authenticator-code step after signing in with DMSid (two-factor on). */
    dmsidCode: (code: string) => post<{ user: User }>("/auth/dmsid/totp", { code }),
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

    // --- notifications ---
    notifications: (options: { category?: string; unread?: boolean; limit?: number } = {}) =>
      call<{ items: StoredNotification[]; unread: number; unreadByCategory: Record<string, number> }>(
        `/notifications?${new URLSearchParams(
          Object.entries({ category: options.category, unread: options.unread ? "1" : undefined, limit: options.limit?.toString() }).filter(
            ([, v]) => v,
          ) as [string, string][],
        )}`,
      ),
    notification: (id: string) => call<StoredNotification>(`/notifications/${id}`),
    unreadCount: () => call<{ unread: number }>("/notifications/unread-count"),
    markRead: (id: string) => post<{ unread: number }>(`/notifications/${id}/read`),
    markAllRead: (category?: string) => post<{ changed: number; unread: number }>("/notifications/read-all", { category }),
    notificationPrefs: () =>
      call<{ prefs: NotificationPrefs; defaults: NotificationPrefs; categories: NotificationCategory[] }>("/notifications/prefs"),
    saveNotificationPrefs: (patch: Partial<NotificationPrefs>) =>
      call<{ prefs: NotificationPrefs }>("/notifications/prefs", { method: "PUT", body: JSON.stringify(patch) }),
    devices: () => call<{ publicKey: string | null; devices: NotificationDevice[] }>("/notifications/devices"),
    addDevice: (subscription: PushSubscriptionJSON, name?: string) => post<NotificationDevice>("/notifications/devices", { subscription, name }),
    updateDevice: (id: string, patch: { name?: string; minPriority?: NotificationPriority }) =>
      call<NotificationDevice>(`/notifications/devices/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    removeDevice: (id: string) => call<{ ok: true }>(`/notifications/devices/${id}`, { method: "DELETE" }),
    testNotification: (options: { category?: NotificationCategory; deviceId?: string }) =>
      post<{ notification: StoredNotification; pushConfigured: boolean }>("/notifications/test", options),
    // --- end notifications ---

    // --- integrations (the Accounts page; types in integrations.ts) ---
    integrations: () => call<IntegrationsView>("/integrations"),
    /** Single kinds use id "default". */
    saveIntegration: (kind: string, id: string, patch: SavePatch) =>
      call<SaveResult>(`/integrations/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) }),
    testIntegration: (kind: string, id: string) =>
      post<{ ok: boolean; message: string; account?: string }>(`/integrations/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/test`),
    importIntegration: (kind: string, id: string) =>
      post<SaveResult>(`/integrations/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/import`),
    removeIntegration: (kind: string, id: string) =>
      call<SaveResult>(`/integrations/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Starts a sign-in; the browser then goes to `url` and comes back to #/accounts?connected=… */
    startOAuth: (provider: string, body: { id: string; vertical?: string; data?: Record<string, unknown> }) =>
      post<{ url: string }>(`/integrations/oauth/${encodeURIComponent(provider)}/start`, body),
    googleCalendars: (id: string) =>
      call<{ calendars: { id: string; name?: string; summary?: string; primary?: boolean; accessRole?: string }[] }>(`/integrations/google/${encodeURIComponent(id)}/calendars`),
    /** Connect Claude: the server runs `claude setup-token` and returns its sign-in link. */
    claudeSetupStart: () => post<{ setupId: string; url: string }>("/integrations/claude/setup"),
    /** The code claude.ai shows after signing in; the server saves the token it gets back. */
    claudeSetupCode: (setupId: string, code: string) =>
      post<SaveResult & { runner: string }>(`/integrations/claude/setup/${encodeURIComponent(setupId)}/code`, { code }),
    claudeSetupCancel: (setupId: string) => call<{ ok: true }>(`/integrations/claude/setup/${encodeURIComponent(setupId)}`, { method: "DELETE" }),
    /** Connect ChatGPT: the server runs `codex login --device-auth` and returns its link and one-time code. */
    codexSetupStart: () => post<{ setupId: string; url: string; code: string }>("/integrations/codex/setup"),
    /** Polled until the code has been entered; once connected the server has saved the sign-in. */
    codexSetupStatus: (setupId: string) =>
      call<{ status: "pending" } | { status: "failed"; message: string } | (SaveResult & { status: "connected"; account: string })>(`/integrations/codex/setup/${encodeURIComponent(setupId)}`),
    codexSetupCancel: (setupId: string) => call<{ ok: true }>(`/integrations/codex/setup/${encodeURIComponent(setupId)}`, { method: "DELETE" }),
    // --- end integrations ---
  };
}

export type Api = ReturnType<typeof createApi>;

/** A stored file (GET /api/storage). `url` is its public /media link when it has one. */
export interface StoredFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  folder: string;
  backend: "local" | "gdrive";
  createdAt: string;
  url: string | null;
  /** null: shared (no vertical). */
  vertical: string | null;
  /** The piece of work it belongs to, e.g. "video:<production id>". */
  work: string | null;
  /** An intermediate file, deleted once its work's final file is published. */
  wip: boolean;
}

export interface StorageOverview {
  backend: "local" | "gdrive";
  byFolder: { folder: string; backend: "local" | "gdrive"; vertical: string | null; files: number; bytes: number }[];
  totalBytes: number;
  files: StoredFile[];
  /** The server volume (null when it can't be read). */
  volume: { free: number; total: number; minFreeBytes: number; renderRetentionDays: number } | null;
  drive: { folderUrl: string; quota: { limit: number | null; usage: number; usageInDrive: number } | null } | null;
  cache: { bytes: number; maxBytes: number; files: number } | null;
}
