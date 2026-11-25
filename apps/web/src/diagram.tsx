import type React from "react";
import { useEffect, useId, useState } from "react";

/**
 * A ```mermaid diagram in markdown (lessons draw flowcharts, timelines and charts this way).
 * Mermaid is large, so it loads only when a page first shows a diagram. It runs in "strict"
 * mode: labels are text, scripts and links in the source are dropped, so a model's diagram
 * can't put HTML on the page. Until it draws (or if the source doesn't parse) the source shows.
 */
export function Diagram({ code }: { code: string }) {
  const id = `diagram-${useId().replace(/[^\w-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dark = useDark();
  useEffect(() => {
    let live = true;
    setFailed(false);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
        const { svg } = await mermaid.render(id, code);
        if (live) setSvg(svg);
      })
      .catch(() => {
        if (live) setFailed(true);
        // Mermaid leaves its error drawing in the body when a render fails.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      });
    return () => {
      live = false;
    };
  }, [code, dark, id]);
  if (svg && !failed) {
    // Its drawn width: on a phone a wide diagram keeps a readable size and scrolls sideways.
    const natural = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)?.[1] ?? 0);
    return <div className="md-diagram" role="img" style={natural ? ({ "--natural": `${Math.round(natural)}px` } as React.CSSProperties) : undefined} dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return (
    <pre className={failed ? "md-diagram-source" : "md-diagram-source is-loading"}>
      <code>{code}</code>
    </pre>
  );
}

/** Whether the page is dark (the theme picker's choice, else the system's), following changes. */
function useDark(): boolean {
  const read = () => {
    if (typeof document === "undefined") return false;
    const pref = document.documentElement.getAttribute("data-theme");
    return pref ? pref === "dark" : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, []);
  return dark;
}
