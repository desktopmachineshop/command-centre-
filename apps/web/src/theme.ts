import { useEffect, useState } from "react";

/**
 * Light / dark theme. "system" follows `prefers-color-scheme`; "light" and "dark" set
 * `data-theme` on <html>, which styles.css uses to override the system choice.
 * index.html runs the same logic inline before first paint, so there is no flash.
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "cc.theme";

/** The browser chrome colour (status bar on phones) for each theme: the top bar's surface. */
export const THEME_COLOR = { light: "#ffffff", dark: "#161920" } as const;

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function saveTheme(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage unavailable (private mode): the choice lasts until reload.
  }
}

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  const dark = pref === "dark" || (pref === "system" && systemDark());
  root.style.colorScheme = dark ? "dark" : "light";
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // With "system" each meta keeps its own media query; an explicit choice sets both.
    const forDark = meta.media.includes("dark");
    meta.content = pref === "system" ? THEME_COLOR[forDark ? "dark" : "light"] : THEME_COLOR[dark ? "dark" : "light"];
  }
}

/** The current preference and a setter that applies and remembers it. */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  return [
    pref,
    (p) => {
      saveTheme(p);
      setPref(p);
    },
  ];
}

/** True while the media query matches; follows changes (e.g. window resize). */
export function useMedia(query: string): boolean {
  const get = () => typeof matchMedia === "function" && matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
