import { useEffect, useLayoutEffect, useRef } from "react";

/** Within this many pixels of the bottom counts as "reading the latest". */
const NEAR_BOTTOM_PX = 160;

const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });

/**
 * Keeps the page scrolled to the newest message, like a chat: it jumps to the bottom when
 * `ready` first turns true, then follows each change of `signal` (a new message, a status) only
 * while Dave is at the bottom. Scrolled up to read something earlier, he stays where he is.
 */
export function useStickToBottom(signal: unknown, ready = true) {
  const following = useRef(true);
  const jumped = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      following.current = atBottom();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    if (!jumped.current || following.current) {
      jumped.current = true;
      toBottom();
      // Images, video posters and fonts can grow the page after this paint.
      const again = setTimeout(() => following.current && toBottom(), 120);
      return () => clearTimeout(again);
    }
  }, [signal, ready]);
}
