import { useEffect, useState } from "react";

/**
 * Notices a new deploy. An installed app on a phone can sit in the background for days and
 * resume with old code, so it checks /version.json (never cached) against its own build id
 * when it comes back to the foreground, when the live connection returns (every deploy
 * restarts the server) and every 15 minutes. Coming back to the app reloads straight away;
 * otherwise a banner offers Update, so a half-filled form isn't lost.
 */
declare const __BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export type UpdateAction = "none" | "reload" | "banner";

/** `latest` null = couldn't tell (offline, dev server): do nothing. */
export function decideUpdate(current: string, latest: string | null, resumed: boolean): UpdateAction {
  if (!latest || current === "dev" || latest === current) return "none";
  return resumed ? "reload" : "banner";
}

let available = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

async function latestId(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

/** Returns true when a newer version is on the server. */
export async function checkForUpdate(resumed = false): Promise<boolean> {
  const action = decideUpdate(BUILD_ID, await latestId(), resumed);
  if (action === "none") return false;
  void navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  if (action === "reload") {
    location.reload();
  } else if (!available) {
    available = true;
    notify();
  }
  return true;
}

export function applyUpdate() {
  location.reload();
}

let started = false;
export function startUpdateChecks() {
  if (started || typeof document === "undefined") return;
  started = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate(true);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") void checkForUpdate(false);
  }, 15 * 60_000);
}

export function useUpdate() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { available, update: applyUpdate, check: () => checkForUpdate(false), version: BUILD_ID };
}
