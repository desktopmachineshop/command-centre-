/**
 * Where Drive mode opens from: the chat composer's box on screen, recorded as its Drive link is
 * tapped, so Drive can grow out of it (pages/Drive.tsx). Read once, and only straight away.
 */
type Origin = { top: number; bottom: number; left: number; right: number; at: number };
let origin: Origin | null = null;

/** Records the element Drive mode is opening from. */
export function setDriveOrigin(el: Element | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  origin = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, at: Date.now() };
}

/** The recorded box, if Drive was opened from it in the last couple of seconds; clears it. */
export function takeDriveOrigin(maxAgeMs = 2000): Origin | null {
  const o = origin;
  origin = null;
  return o && Date.now() - o.at <= maxAgeMs ? o : null;
}
