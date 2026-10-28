import { Fragment, type ReactNode } from "react";

/**
 * Agent replies are markdown. This renders the common subset (headings, lists, code, quotes,
 * tables, emphasis, links) straight to React elements, so no model text ever becomes raw HTML.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `md ${className}` : "md"}>{blocks(text.replace(/\r\n?/g, "\n").split("\n"))}</div>;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-"))
  );
}

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = out.length;

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push(
        <pre key={key}>
          <code className={fence[2] ? `lang-${fence[2]}` : undefined}>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1]!.length + 2, 6)}` as "h3";
      out.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(lines[i]!.replace(QUOTE, ""));
      out.push(<blockquote key={key}>{blocks(body)}</blockquote>);
      continue;
    }

    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      const head = cells(line);
      const align = cells(next).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : undefined));
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      out.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const indent = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
        const body = [m[3]!];
        // Continuation: indented deeper than the marker (nested lists included), or blank before more of it.
        for (i++; i < lines.length; i++) {
          const l = lines[i]!;
          const lead = l.length - l.trimStart().length;
          if (l.trim() && lead > indent) body.push(l.slice(Math.min(lead, indent + m[2]!.length + 1)));
          else if (!l.trim() && lines[i + 1] !== undefined && lines[i + 1]!.trim() && indentOf(lines[i + 1]!) > indent) body.push("");
          else break;
        }
        items.push(body);
        // A blank line between items of the same list keeps the list going.
        if (!lines[i]?.trim() && lines[i + 1] !== undefined && ITEM.exec(lines[i + 1]!)?.[1]!.length === indent) i++;
      }
      const start = ordered ? Number.parseInt(item[2]!, 10) : undefined;
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key} start={start !== 1 ? start : undefined}>
          {items.map((body, k) => (
            <li key={k}>{listItem(body)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim(); i++) {
      if (para.length && startsBlock(lines[i]!, lines[i + 1])) break;
      para.push(lines[i]!.trim());
    }
    out.push(<p key={key}>{lines_(para)}</p>);
  }
  return out;
}

/** A tight list item stays inline; anything with nested blocks renders as blocks. */
function listItem(body: string[]): ReactNode {
  const task = /^\[([ xX])\]\s+/.exec(body[0]!);
  if (task) body = [body[0]!.slice(task[0].length), ...body.slice(1)];
  const check = task && <input type="checkbox" checked={task[1] !== " "} disabled readOnly />;
  const simple = body.every((l, j) => j === 0 || (l.trim() && !startsBlock(l, body[j + 1])));
  return (
    <>
      {check}
      {simple ? lines_(body.map((l) => l.trim())) : blocks(body)}
    </>
  );
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Single newlines inside a paragraph are kept: agents use them as deliberate line breaks. */
function lines_(ls: string[]): ReactNode[] {
  return ls.map((l, j) => (
    <Fragment key={j}>
      {j > 0 && <br />}
      {inline(l)}
    </Fragment>
  ));
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w\\])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)|(https?:\/\/[^\s<>]*[^\s<>.,:;!?"'*_)\]])|\\([\\`*_{}[\]()#+\-.!|~>])/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = INLINE.lastIndex;
    const key = out.length;
    // The regex is global and shared, so remember where we are before recursing.
    const resume = INLINE.lastIndex;
    if (m[1]) out.push(<code key={key}>{m[2]!.replace(/^ (.*) $/, "$1")}</code>);
    else if (m[3] !== undefined) out.push(link(m[4]!, inline(m[3]), key));
    else if (m[5] !== undefined) out.push(<strong key={key}>{inline(m[5])}</strong>);
    else if (m[6] !== undefined) out.push(<strong key={key}>{inline(m[6])}</strong>);
    else if (m[7] !== undefined) out.push(<del key={key}>{inline(m[7])}</del>);
    else if (m[8] !== undefined) out.push(<em key={key}>{inline(m[8])}</em>);
    else if (m[9] !== undefined) out.push(<em key={key}>{inline(m[9])}</em>);
    else if (m[10] !== undefined) out.push(link(m[10], m[10], key));
    else if (m[11] !== undefined) out.push(m[11]);
    INLINE.lastIndex = resume;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Only web, mail and in-app links become anchors; anything else (javascript:, data:) stays text. */
function link(href: string, label: ReactNode, key: number): ReactNode {
  if (href.startsWith("#") || /^\/(?![/\\])/.test(href)) {
    return (
      <a key={key} href={href}>
        {label}
      </a>
    );
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    return (
      <a key={key} href={href} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    );
  }
  return <Fragment key={key}>{label}</Fragment>;
}
