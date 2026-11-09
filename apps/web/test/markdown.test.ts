import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordCard } from "../src/cards";
import { Markdown } from "../src/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders emphasis, code and strikethrough inline", () => {
    expect(html("**bold** and *it* and `x*y*` and ~~gone~~")).toBe(
      '<div class="md"><p><strong>bold</strong> and <em>it</em> and <code>x*y*</code> and <del>gone</del></p></div>',
    );
  });

  it("keeps snake_case identifiers literal", () => {
    expect(html("call get_order_lines now")).toContain("get_order_lines");
  });

  it("renders headings, lists and nested lists", () => {
    const out = html("## Plan\n\n1. First\n2. Second\n   - sub a\n   - sub b\n\n- [x] done\n- [ ] todo");
    expect(out).toContain("<h4>Plan</h4>");
    expect(out).toContain("<ol><li>First</li><li><p>Second</p><ul><li>sub a</li><li>sub b</li></ul></li></ol>");
    expect(out).toContain('readOnly="" checked=""/>done');
  });

  it("renders fenced code verbatim", () => {
    expect(html("```ts\nconst a = **1**;\n```")).toContain('<pre><code class="lang-ts">const a = **1**;</code></pre>');
  });

  it("draws a card block as cards, not code", () => {
    const out = html("Here it is:\n\n```card\nodoo.product:42\nodoo.order:S00042\n```\n\nAnything else?");
    expect(out).not.toContain("<pre>");
    expect(out).toContain('<div class="record-cards">');
    expect(out).toContain('<code class="record-card-ref">odoo.product:42</code>');
    expect(out).toContain('<code class="record-card-ref">odoo.order:S00042</code>');
    expect(out).toContain("<p>Anything else?</p>");
  });

  it("renders tables", () => {
    const out = html("| SKU | Qty |\n|---|--:|\n| A1 | 3 |");
    expect(out).toContain("<th>SKU</th>");
    expect(out).toContain('<td style="text-align:right">3</td>');
  });

  it("renders blockquotes and rules", () => {
    expect(html("> note\n\n---")).toBe('<div class="md"><blockquote><p>note</p></blockquote><hr/></div>');
  });

  it("keeps single newlines as line breaks", () => {
    expect(html("line one\nline two")).toContain("line one<br/>line two");
  });

  it("links web URLs and refuses script URLs", () => {
    expect(html("[docs](https://example.com) https://a.b/c.")).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a> <a href="https://a.b/c" target="_blank" rel="noreferrer noopener">https://a.b/c</a>.',
    );
    expect(html("[x](javascript:alert(1))")).not.toContain("<a");
    expect(html("[x](//evil.com)")).not.toContain("<a");
    expect(html("[task](#/task/1)")).toContain('<a href="#/task/1">task</a>');
  });

  it("never emits raw HTML from the text", () => {
    expect(html("<img src=x onerror=alert(1)>")).toContain("&lt;img");
  });
});

describe("what the app shows of a voice-mode task", () => {
  it("drops the voice rules from an older stored prompt, and the protocol line from answers", async () => {
    const { askText, withoutVoiceLine } = await import("../src/format");
    expect(askText("another reminder for a bug fix\n\nVOICE MODE: Dave is driving and will hear your answer\n- Answer in one to three")).toBe("another reminder for a bug fix");
    expect(askText("plain request\nsecond line")).toBe("plain request\nsecond line");
    expect(withoutVoiceLine('Added the reminder for tomorrow.\n{"voice":{"type":"final","text":"Done, reminder set."}}')).toBe("Added the reminder for tomorrow.");
    expect(withoutVoiceLine('```json {"voice":{"type":"converse","text":"Which day?"}}```')).toBe("");
    expect(withoutVoiceLine('Config is {"a": 1}')).toBe('Config is {"a": 1}');
  });

  it("links brain note paths to the note in the Brain page", () => {
    const href = '<a href="#/brain/dms%2Fwork-instructions%2Fsplitting-a-delivery-into-parcels.md" class="brain-link">';
    expect(html("Updated dms/work-instructions/splitting-a-delivery-into-parcels.md with steps 3 to 6.")).toContain(
      `${href}dms/work-instructions/splitting-a-delivery-into-parcels.md</a> with`,
    );
    expect(html("Saved to `dms/work-instructions/splitting-a-delivery-into-parcels.md`.")).toContain(
      `${href}<code>dms/work-instructions/splitting-a-delivery-into-parcels.md</code></a>.`,
    );
    expect(html("See [the parcels guide](dms/work-instructions/splitting-a-delivery-into-parcels.md)")).toContain(`${href}the parcels guide</a>`);
    expect(html("(personal/ideas_list.md)")).toContain('href="#/brain/personal%2Fideas_list.md"');
  });

  it("leaves URLs, plain words and non-note code alone", () => {
    expect(html("https://example.com/docs/a.md")).toContain('href="https://example.com/docs/a.md" target="_blank"');
    expect(html("README.md and `src/app.ts`")).not.toContain("<a");
  });

  it("draws a card with its picture, badges, facts and a safe link", () => {
    const card = { ref: "odoo.product:1", kind: "odoo.product", title: "ER11 collet set", subtitle: "ER11-7", image: "data:image/png;base64,AAAA", url: "https://x.odoo.com/web#id=1", badges: [{ text: "In stock", tone: "good" as const }], facts: [{ label: "On hand", value: "3" }], footnote: "Live from Odoo" };
    const out = renderToStaticMarkup(createElement(RecordCard, { card }));
    expect(out).toContain('<img class="record-card-image" src="data:image/png;base64,AAAA"');
    expect(out).toContain('<span class="record-badge tone-good">In stock</span>');
    expect(out).toContain("<dt>On hand</dt><dd>3</dd>");
    expect(out).toContain('href="https://x.odoo.com/web#id=1"');
    expect(out).toContain("Open in Odoo");
    const unsafe = renderToStaticMarkup(createElement(RecordCard, { card: { ...card, url: "javascript:alert(1)", image: "data:image/svg+xml;base64,AAAA" } }));
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("svg+xml");
  });
});
