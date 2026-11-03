import type { AgentMessage } from "@cc/core";

/**
 * The Chat page's conversation, kept on this device so it survives leaving the page or
 * reloading, like a Claude session. It lasts until "New chat" or an hour without activity.
 * Only what the server can't give back is stored (what Dave typed, which task each message
 * went to, and when); the replies are fetched again from the tasks themselves.
 */
export const CHAT_KEY = "cc.chat.thread";
export const CHAT_IDLE_MS = 60 * 60_000;

export interface SavedTurn {
  text: string;
  taskId: string;
  /**
   * When the server took it (ISO, the task's own timestamp, so it compares with run start times
   * on the same clock). Runs that started after it, before the next turn on the task, are its replies.
   */
  at: string;
}

export interface SavedChat {
  v: 1;
  threadId: string | null;
  vertical: string;
  /** Last send or reply (ms); an hour after it the chat starts fresh. */
  lastActive: number;
  turns: SavedTurn[];
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked (private mode, some embedded views)
  }
};

/** The saved chat, or null when there is none, it is unreadable, or it has been idle for an hour. */
export function loadChat(now = Date.now()): SavedChat | null {
  try {
    const raw = storage()?.getItem(CHAT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedChat;
    if (saved?.v !== 1 || !Array.isArray(saved.turns) || !saved.turns.length) return null;
    if (now - saved.lastActive > CHAT_IDLE_MS) {
      clearChat();
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

export function saveChat(chat: Omit<SavedChat, "v">): void {
  try {
    if (!chat.turns.length) return clearChat();
    storage()?.setItem(CHAT_KEY, JSON.stringify({ v: 1, ...chat }));
  } catch {
    // storage full or blocked: the chat just won't survive a reload
  }
}

export function clearChat(): void {
  try {
    storage()?.removeItem(CHAT_KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * Splits a task's runs between the turns sent to it: each run belongs to the latest turn sent
 * at or before it started (a report back from a role lands on the turn it answers). Runs
 * from before the first turn go to the first. Returns each turn's messages, in turn order.
 */
export function messagesByTurn(turns: Pick<SavedTurn, "at">[], runs: { startedAt: string; messages: AgentMessage[] }[]): AgentMessage[][] {
  const out: AgentMessage[][] = turns.map(() => []);
  if (!turns.length) return out;
  const starts = turns.map((t) => Date.parse(t.at));
  for (const run of [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const at = Date.parse(run.startedAt);
    let i = 0;
    for (let j = 0; j < starts.length; j++) if (starts[j]! <= at) i = j;
    out[i]!.push(...run.messages);
  }
  return out;
}
