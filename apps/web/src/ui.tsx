/**
 * Shared building blocks. Pages use these with the classes in styles.css:
 *   <PageHead title="…" sub="…">actions</PageHead>   page title row
 *   <VTag id={task.vertical} />                        vertical chip in the vertical's colour
 *   <Status value={task.status} />                     status pill (class "status <value>")
 *   <Empty icon="inbox">text</Empty>                   empty state
 *   <Skeleton rows={3} />                              loading placeholder
 *   <ErrorBanner>{error}</ErrorBanner>                 error banner (a p.error)
 */
import { createContext, type CSSProperties, type ReactNode, useContext } from "react";
import { Icon, type IconName } from "./icons";
import type { ThemePref } from "./theme";

export type VerticalInfo = { id: string; name: string; color?: string | null };

/** Vertical id → name and colour, from the manifests (GET /api/verticals). Loaded once by the shell. */
export const VerticalsContext = createContext<Record<string, VerticalInfo>>({});

/** A vertical chip: coloured dot + id, tinted with the manifest's `color`. */
export function VTag({ id, children }: { id: string; children?: ReactNode }) {
  const v = useContext(VerticalsContext)[id];
  const style = v?.color ? ({ "--v": v.color } as CSSProperties) : undefined;
  return (
    <span className="tag vtag" data-v={id} style={style} title={v?.name ?? id}>
      {children ?? id}
    </span>
  );
}

/** A status pill. The class is `status <value>`, so CSS colours it by status. */
export function Status({ value, label }: { value: string; label?: string }) {
  return <span className={`status ${value}`}>{label ?? value.replace(/_/g, " ")}</span>;
}

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        <h2>{title}</h2>
        {sub && <p className="muted small page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function Empty({ icon = "spark", children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="empty-text">{children}</div>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-card">
          <span className="skeleton" style={{ width: "28%" }} />
          <span className="skeleton" style={{ width: `${70 - i * 9}%` }} />
          <span className="skeleton" style={{ width: "45%" }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "system" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** One button that cycles System → Light → Dark (the phone top bar, where space is tight). */
export function ThemeCycle({ value, onChange }: { value: ThemePref; onChange: (v: ThemePref) => void }) {
  const i = THEMES.findIndex((t) => t.value === value);
  const cur = THEMES[i]!;
  const next = THEMES[(i + 1) % THEMES.length]!;
  return (
    <button
      type="button"
      className="ghost icon-btn theme-cycle"
      aria-label={`${cur.label} theme. Switch to ${next.label.toLowerCase()}`}
      title={`${cur.label} theme`}
      onClick={() => onChange(next.value)}
    >
      <Icon name={cur.icon} size={20} />
    </button>
  );
}

/** System / Light / Dark segmented control. */
export function ThemeToggle({ value, onChange }: { value: ThemePref; onChange: (v: ThemePref) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="radio"
          aria-checked={value === t.value}
          aria-label={`${t.label} theme`}
          title={`${t.label} theme`}
          className={value === t.value ? "on" : ""}
          onClick={() => onChange(t.value)}
        >
          <Icon name={t.icon} size={18} />
        </button>
      ))}
    </div>
  );
}
