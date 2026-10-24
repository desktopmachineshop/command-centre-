import { useEffect, useState } from "react";

/**
 * Installing the app (Android Chrome turns it into a real app: WebAPK, app-drawer icon,
 * no browser bar). Chrome fires `beforeinstallprompt` once it considers the app installable,
 * possibly before React mounts, so the listener is registered when this module loads
 * (it is imported from main.tsx).
 */
type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPromptEvent | null = null;
let installed = isStandalone();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own Install button instead of Chrome's mini-infobar
    deferred = e as InstallPromptEvent;
    notify();
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}

const DISMISS_KEY = "cc.installBannerDismissed";

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  return {
    /** Chrome has offered the install and the app isn't installed yet. */
    canInstall: !!deferred && !installed,
    installed,
    /** Show the one-time banner? (installable and not dismissed before) */
    showBanner: !!deferred && !installed && !dismissed,
    async install() {
      if (!deferred) return false;
      const prompt = deferred;
      deferred = null; // a prompt can only be used once
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      notify();
      return outcome === "accepted";
    },
    dismissBanner() {
      setDismissed(true);
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        // storage unavailable: the banner just comes back next visit
      }
    },
  };
}
