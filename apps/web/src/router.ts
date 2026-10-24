import { useEffect, useState } from "react";

/** Hash routes keep the PWA working from any static host and from notification links. */
export function useRoute(): string[] {
  // The query part (`#/approvals/id?action=approve`) is read with routeQuery(), not part of the segments.
  const read = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "inbox").split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = `/${path}`;
};

/** Query parameters of the hash route, e.g. `#/approvals/123?action=approve`. */
export function routeQuery(): URLSearchParams {
  const q = location.hash.indexOf("?");
  return new URLSearchParams(q >= 0 ? location.hash.slice(q + 1) : "");
}
