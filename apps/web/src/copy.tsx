import { type ReactNode, useState } from "react";
import { Icon } from "./icons";
import { BUILD_ID } from "./update";

/** Copies text, falling back to a hidden selection where the clipboard API is missing. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / insecure origins: a selection copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function CopyButton({ text, label, children }: { text: string | (() => string); label: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(typeof text === "function" ? text() : text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className="small copy-btn" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : (children ?? "Copy")}
    </button>
  );
}

/** One fact in an error report: a label and a value (left out when empty). */
export type ReportFacts = [string, string | number | null | undefined][];

/**
 * The text an error report copies: what failed, the ids and times needed to find it in the
 * logs, the full error, and where it was seen (app build, page). Plain text, so it pastes
 * cleanly into a chat with Claude, an issue or an email.
 */
export function errorReport(title: string, error: string, facts: ReportFacts = [], now = new Date()): string {
  const lines = [`Command Centre error: ${title}`, ""];
  for (const [k, v] of facts) if (v !== null && v !== undefined && String(v).trim() !== "") lines.push(`${k}: ${String(v).trim()}`);
  lines.push(`Seen: ${now.toISOString()}`, `App build: ${BUILD_ID}`);
  if (typeof location !== "undefined") lines.push(`Page: ${location.href.replace(/[?&](key|token|auto)=[^&#]*/g, "")}`);
  lines.push("", "Error:", error.trim() || "(no message)");
  return lines.join("\n");
}

/**
 * A failure shown so it can be acted on: the first line of the error, the rest folded away,
 * and "Copy error" with a full report (see errorReport).
 */
export function ErrorReport({ title, error, facts }: { title: string; error: string; facts?: ReportFacts }) {
  const text = error.trim() || "(no message)";
  const [first, ...rest] = text.split("\n");
  return (
    <div className="error-report" role="alert">
      <div className="error-report-head">
        <span className="error">
          <Icon name="alert" size={16} /> <strong>{title}:</strong> {first}
        </span>
        <CopyButton text={() => errorReport(title, text, facts)} label={`error report: ${title}`}>
          Copy error
        </CopyButton>
      </div>
      {rest.length > 0 && (
        <details>
          <summary className="small muted">Full error</summary>
          <pre>{text}</pre>
        </details>
      )}
    </div>
  );
}
