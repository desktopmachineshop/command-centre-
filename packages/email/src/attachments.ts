import { simpleParser } from "mailparser";

/** Longest attachment text handed to an agent by default (a price list can be long; a run's context is not). */
export const MAX_ATTACHMENT_CHARS = 60_000;

export interface MailAttachment {
  /** Position among the message's attachments, from 0: what the mail tools take as `index`. */
  index: number;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface AttachmentText {
  filename: string;
  contentType: string;
  /** How it was read: "pdf", "spreadsheet", "text" or "html". */
  format: "pdf" | "spreadsheet" | "text" | "html";
  text: string;
  truncated: boolean;
  /** Sheets read from a workbook, or pages from a PDF. */
  parts?: number;
}

/** The attachments of a raw message, in the order `parseEmail` lists them. */
export async function mailAttachments(source: Buffer | string): Promise<MailAttachment[]> {
  const mail = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  return mail.attachments
    .filter((a) => a.contentDisposition !== "inline" || a.filename)
    .map((a, index) => ({ index, filename: a.filename ?? "(unnamed)", contentType: a.contentType, size: a.size, content: a.content }));
}

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
const SHEET_EXT = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods", "numbers"]);
const SHEET_TYPES = /spreadsheet|excel|ms-excel|opendocument\.spreadsheet/i;
const TEXT_EXT = new Set(["csv", "tsv", "txt", "md", "json", "xml"]);

/** Which reader an attachment needs, or null when it can't be read as text (images, archives, Word files...). */
export function attachmentFormat(filename: string, contentType: string): AttachmentText["format"] | null {
  const e = ext(filename);
  const type = contentType.toLowerCase();
  if (e === "pdf" || type === "application/pdf") return "pdf";
  if (SHEET_EXT.has(e) || SHEET_TYPES.test(type)) return "spreadsheet";
  if (e === "html" || e === "htm" || type === "text/html") return "html";
  if (TEXT_EXT.has(e) || type.startsWith("text/") || type === "application/json") return "text";
  return null;
}

const clip = (text: string, max: number) =>
  text.length > max ? { text: `${text.slice(0, max)}\n[... truncated at ${max} characters]`, truncated: true } : { text, truncated: false };

const htmlText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/**
 * An attachment as plain text: PDFs page by page, workbooks sheet by sheet as CSV, HTML without
 * its tags, text as is. Throws for formats it can't read, with the reason.
 */
export async function attachmentText(a: Pick<MailAttachment, "filename" | "contentType" | "content">, maxChars = MAX_ATTACHMENT_CHARS): Promise<AttachmentText> {
  const format = attachmentFormat(a.filename, a.contentType);
  const base = { filename: a.filename, contentType: a.contentType };
  if (format === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(a.content));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join("\n\n");
    const body = pages.replace(/--- page \d+ ---\s*/g, "").trim()
      ? pages
      : "(no text layer: this PDF looks scanned. Ask Dave for the spreadsheet version or the figures.)";
    return { ...base, format, parts: totalPages, ...clip(body, maxChars) };
  }
  if (format === "spreadsheet") {
    const XLSX = await import("xlsx");
    const book = XLSX.read(a.content, { type: "buffer", cellDates: true });
    const sheets = book.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(book.Sheets[name]!, { blankrows: false, dateNF: "yyyy-mm-dd" });
      return `--- sheet "${name}" ---\n${csv.trim()}`;
    });
    return { ...base, format, parts: sheets.length, ...clip(sheets.join("\n\n"), maxChars) };
  }
  if (format === "html") return { ...base, format, ...clip(htmlText(a.content.toString("utf8")), maxChars) };
  if (format === "text") return { ...base, format, ...clip(a.content.toString("utf8").replace(/\r\n/g, "\n"), maxChars) };
  throw new Error(`${a.filename} (${a.contentType}) can't be read as text; PDFs, spreadsheets (xlsx, xls, ods, csv), HTML and text files can`);
}
