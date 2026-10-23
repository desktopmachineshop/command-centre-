import { useEffect, useState } from "react";

/** Hash routes keep the PWA working from any static host and from notification links. */
export function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, "") || "inbox").split("/");
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
