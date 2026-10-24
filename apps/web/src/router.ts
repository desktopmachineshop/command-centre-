import { useEffect, useState } from "react";

/** The hash after "#/", without any "?query". */
const path = () => location.hash.replace(/^#\/?/, "").split("?")[0] || "inbox";

/** Query parameters in the hash, e.g. `#/inbox?vertical=dms&role=customer-support`. */
export const routeQuery = () => new URLSearchParams(location.hash.split("?")[1] ?? "");

/** Hash routes keep the PWA working from any static host and from notification links. */
export function useRoute(): string[] {
  const read = () => path().split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** The hash query, updated on navigation. */
export function useRouteQuery(): URLSearchParams {
  const [query, setQuery] = useState(routeQuery);
  useEffect(() => {
    const on = () => setQuery(routeQuery());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return query;
}

export const go = (path: string) => {
  location.hash = `/${path}`;
};

