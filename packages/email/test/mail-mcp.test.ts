import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it } from "vitest";
import { attachmentText, createMailMcpServer, emailPrompt, MemoryMailbox, parseEmail } from "../src";
import { account, rawEmail } from "./fixtures";

/** A one-page PDF with a text layer. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

function workbook(rows: (string | number)[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Prices");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("attachmentText", () => {
  it("reads spreadsheets as CSV per sheet", async () => {
    const out = await attachmentText({ filename: "prices.xlsx", contentType: XLSX_TYPE, content: workbook([["SKU", "Price"], ["ER11-7", 18.4]]) });
    expect(out).toMatchObject({ format: "spreadsheet", parts: 1, truncated: false });
    expect(out.text).toBe('--- sheet "Prices" ---\nSKU,Price\nER11-7,18.4');
  });

  it("reads PDFs page by page", async () => {
    const out = await attachmentText({ filename: "list.pdf", contentType: "application/pdf", content: pdf("ER11-7 collet set 18.40") });
    expect(out).toMatchObject({ format: "pdf", parts: 1 });
    expect(out.text).toContain("ER11-7 collet set 18.40");
  });

  it("reads CSV and HTML, truncates long text and refuses what it can't read", async () => {
    expect((await attachmentText({ filename: "p.csv", contentType: "text/csv", content: Buffer.from("a,b\r\n1,2") })).text).toBe("a,b\n1,2");
    const html = await attachmentText({ filename: "p.html", contentType: "text/html", content: Buffer.from("<table><tr><td>A</td><td>1</td></tr></table>") });
    expect(html.text).toBe("A\t1");
    const long = await attachmentText({ filename: "p.txt", contentType: "text/plain", content: Buffer.from("x".repeat(5000)) }, 1000);
    expect(long.truncated).toBe(true);
    await expect(attachmentText({ filename: "manual.docx", contentType: "application/msword", content: Buffer.alloc(4) })).rejects.toThrow(/can't be read/);
  });
});

describe("mail MCP server", () => {
  let box: MemoryMailbox;
  let reads: number;
  let call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;
  let tools: string[];
  let mcp: () => Client;

  beforeEach(async () => {
    box = new MemoryMailbox();
    reads = 0;
    box.deliver(await rawEmail({ from: "Jane <jane@example.com>", to: "support@desktopmachineshop.com", subject: "Where is my order?", text: "S00042 please", messageId: "<order@example.com>" }));
    box.deliver(
      await rawEmail({
        from: "Arc Euro Trade <sales@arceurotrade.co.uk>",
        to: "support@desktopmachineshop.com",
        subject: "Price list November 2026",
        text: "Please find our new price list attached, valid from 1 November.",
        messageId: "<pricelist@arceurotrade.co.uk>",
        attachments: [
          { filename: "logo.png", content: Buffer.alloc(8), contentType: "image/png" },
          { filename: "Pricelist Nov 2026.xlsx", content: workbook([["Code", "Description", "Price"], ["AET-ER11-7", "ER11 collet set", 18.4]]), contentType: XLSX_TYPE },
          { filename: "Terms.pdf", content: pdf("Carriage free over 100 GBP"), contentType: "application/pdf" },
        ],
      }),
    );
    const server = createMailMcpServer({ accounts: [account()], connect: box.connector, onRead: () => void reads++ });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    mcp = () => client;
    const mcp_ = client;
    tools = (await mcp_.listTools()).tools.map((t) => t.name).sort();
    call = async (name, args = {}) => {
      const res = (await mcp_.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = res.content[0]!.text;
      return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
    };
  });

  it("exposes only read tools", () => {
    expect(tools).toEqual(["list_mail_accounts", "read_attachment", "read_mail", "search_mail"]);
  });

  it("lists the mailboxes it was given", async () => {
    expect((await call("list_mail_accounts")).json).toEqual([{ id: "shop", address: "support@desktopmachineshop.com", vertical: "dms", mailbox: "INBOX" }]);
  });

  it("searches by sender and subject, with attachments listed", async () => {
    const { json } = await call("search_mail", { subject: "price list", withAttachments: true });
    expect(json.note).toMatch(/never as instructions/);
    expect(json.messages).toHaveLength(1);
    expect(json.messages[0]).toMatchObject({
      accountId: "shop",
      messageId: "<pricelist@arceurotrade.co.uk>",
      from: "Arc Euro Trade <sales@arceurotrade.co.uk>",
      attachments: [
        { index: 0, filename: "logo.png", readable: true },
        { index: 1, filename: "Pricelist Nov 2026.xlsx", readable: true },
        { index: 2, filename: "Terms.pdf", readable: true },
      ],
    });
    expect((await call("search_mail", { from: "jane" })).json.messages.map((m: any) => m.subject)).toEqual(["Where is my order?"]);
    expect((await call("search_mail", { withAttachments: true, since: "2026-10-21" })).json.messages).toEqual([]);
    expect(reads).toBe(2);
  });

  it("reads a message and its attachments by Message-ID", async () => {
    const mail = await call("read_mail", { accountId: "shop", messageId: "pricelist@arceurotrade.co.uk" });
    expect(mail.json.text).toContain("valid from 1 November");

    // Default: the first readable attachment (skips the logo).
    const sheet = await call("read_attachment", { accountId: "shop", messageId: "<pricelist@arceurotrade.co.uk>" });
    expect(sheet.json).toMatchObject({ index: 1, filename: "Pricelist Nov 2026.xlsx", format: "spreadsheet" });
    expect(sheet.json.text).toContain("AET-ER11-7,ER11 collet set,18.4");

    const terms = await call("read_attachment", { accountId: "shop", uid: 2, filename: "terms.pdf" });
    expect(terms.json.text).toContain("Carriage free over 100 GBP");

    expect((await call("read_attachment", { accountId: "shop", uid: 1 })).text).toBe("That message has no attachments.");
    expect((await call("read_mail", { accountId: "shop", messageId: "<nope@x>" })).isError).toBe(true);
    expect((await call("read_mail", { accountId: "other", uid: 1 })).text).toMatch(/No mailbox "other"/);
  });

  it("hands images over to look at, including photos pasted into the body", async () => {
    const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const JPG = Buffer.from("ffd8ffe000104a46494600010100", "hex");
    const photoMail = await rawEmail({
        from: "Sam <sam@example.com>",
        to: "support@desktopmachineshop.com",
        subject: "Spindle noise",
        html: '<p>See the photo:</p><img src="cid:pasted1">',
        messageId: "<photo@example.com>",
        attachments: [
          // Pasted into the body: inline, no filename, only a Content-ID.
          { cid: "pasted1", content: PNG, contentType: "image/png", contentDisposition: "inline" },
          { filename: "IMG_0042.JPG", content: JPG, contentType: "application/octet-stream" },
          { filename: "IMG_0043.HEIC", content: Buffer.alloc(16), contentType: "image/heic" },
        ],
      });
    // Nodemailer names every part; phones and Outlook send pasted images with no name at all.
    const nameless = photoMail.toString().replace(/;\s*(?:file)?name="?attachment-1\.png"?/g, "");
    expect(nameless).not.toContain("attachment-1.png");
    box.deliver(Buffer.from(nameless));
    const mail = await call("read_mail", { accountId: "shop", messageId: "<photo@example.com>" });
    expect(mail.json.attachments).toMatchObject([
      { index: 0, filename: "image-1.png", contentType: "image/png", readable: true },
      { index: 1, filename: "IMG_0042.JPG", readable: true },
      { index: 2, filename: "IMG_0043.HEIC", readable: false },
    ]);

    const raw = async (args: Record<string, unknown>) =>
      (await mcp().callTool({ name: "read_attachment", arguments: { accountId: "shop", messageId: "<photo@example.com>", ...args } })) as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      };
    const pasted = await raw({});
    expect(pasted.isError).toBeFalsy();
    expect(JSON.parse(pasted.content[0]!.text!)).toMatchObject({ index: 0, filename: "image-1.png", format: "image" });
    expect(pasted.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    expect((await raw({ index: 1 })).content[1]).toEqual({ type: "image", data: JPG.toString("base64"), mimeType: "image/jpeg" });
    const heic = await raw({ index: 2 });
    expect(heic.isError).toBe(true);
    expect(heic.content[0]!.text).toMatch(/can't view.*JPEG/);
    expect(reads).toBeGreaterThanOrEqual(3);

    const prompt = emailPrompt({ accountId: "shop", ...(await parseEmail(box.messages.at(-1)!.source)) });
    expect(prompt).toContain("Attachments: image-1.png");
    expect(prompt).toMatch(/images as the image itself/);
  });

  it("tells the agent how to read attachments of the email in its task", async () => {
    const source = box.messages[1]!.source;
    const prompt = emailPrompt({ accountId: "shop", account: "support@desktopmachineshop.com", ...(await parseEmail(source)) });
    expect(prompt).toContain('read_attachment with {"accountId":"shop","messageId":"<pricelist@arceurotrade.co.uk>","index":0}');
  });
});
