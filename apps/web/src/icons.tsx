/**
 * Inline SVG icons (24×24, 1.75 stroke, currentColor), no icon library. Add one by
 * putting its path data in PATHS; `<Icon name="…" />` sizes to 1.25em by default.
 */
const PATHS = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  approvals: "M9 12l2 2 4-4M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
  chat: "M4 5h16v11H9l-5 4z M8 9.5h8 M8 12.5h5",
  social: "M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1z M17 9a4 4 0 0 1 0 6 M19.5 6.5a7.5 7.5 0 0 1 0 11",
  org: "M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-2h12v2",
  brain: "M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h9 M9 8h4",
  devices: "M3 5h14v10H3z M7 19h6 M10 15v4 M19 9h2v10h-4v-2",
  storage: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  today: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M8 14h3v3H8z",
  speaker: "M11 5L6 9H2v6h4l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14",
  // Converse (Drive mode): a voice waveform. While it's open the chat box's button folds it away ("fold").
  drive: "M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4",
  fold: "M7 3.5l5 5 5-5 M7 20.5l5-5 5 5 M4 12h16",
  // Read aloud: a speech bubble with sound coming from it.
  narrate: "M3 5h11v8.5H8L3 17.5z M17.5 7.5a4 4 0 0 1 0 5 M20.5 5a8 8 0 0 1 0 10",
  install: "M12 3v12 M7 10l5 5 5-5 M5 21h14",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.4 M12 16.8h.01",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  system: "M3 5h18v11H3z M8 20h8 M12 16v4",
  close: "M6 6l12 12 M18 6L6 18",
  attach: "M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5",
  file: "M6 3h8l5 5v13H6z M14 3v5h5",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
  stop: "M7 7h10v10H7z",
  send: "M4 12l16-8-6 16-2.5-6.5z M11.5 13.5L20 4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4",
  back: "M15 5l-7 7 7 7",
  chevron: "M9 6l6 6-6 6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M7 7l10 10 M17 7L7 17",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  plus: "M12 5v14 M5 12h14",
  logout: "M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10",
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
  key: "M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M10.5 11.5L4 18v2h3v-2h2v-2h2l1.5-1.5",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  // --- accounts page ---
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  briefcase: "M4 8h16v11H4z M9 8V5h6v3 M4 13h16",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  code: "M8 8l-5 4 5 4 M16 8l5 4-5 4 M14 5l-4 14",
  server: "M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  sliders: "M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4",
  pulse: "M3 12h4l3-7 4 14 3-7h4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
  const s = size ?? "1.25em";
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Command Centre mark (matches public/icon.svg). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <rect width="512" height="512" rx="120" fill="var(--brand-tile)" />
      <path d="M363.2 166 A140 140 0 1 0 363.2 346" fill="none" stroke="var(--brand-ring)" strokeWidth="50" />
      <circle cx="256" cy="256" r="45" fill="var(--brand-ring)" />
    </svg>
  );
}
