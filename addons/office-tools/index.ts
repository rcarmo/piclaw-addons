import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, extname, resolve, basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeZipEntryText } from "./zip-entry-text.ts";

type MaybeAbortSignal = AbortSignal | null | undefined;

function registerToolStatusHintProvider(provider: { id: string; buildHints: (ctx: { toolName: string; args: unknown }) => unknown }): void {
  const fn = (globalThis as any).__piclaw_registerToolStatusHintProvider;
  if (typeof fn === "function") fn(provider);
}
const EXT_DIR = typeof import.meta.dir === "string" ? import.meta.dir : dirname(new URL(import.meta.url).pathname);
const OFFICE_TOOLS_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 3h10l4 4v14H4z"></path><path d="M14 3v5h4"></path><path d="M7 13h10"></path><path d="M7 17h10"></path></svg>`;
const require = createRequire(import.meta.url);
const ASSETS_DIR = resolve(EXT_DIR, "assets");
const PPTXGEN_PATH = resolve(EXT_DIR, "vendor/pptxgenjs/pptxgen.cjs.js");
const XLSX_PACKAGE = "xlsx";

let cachedXlsx: any | null = null;
let cachedPptxGenJs: any | null = null;
let cachedFflate: any | null = null;
let cachedCdpModule: Promise<typeof import("../../browser/cdp-browser/cdp.ts")> | null = null;
const DOCX_TEMPLATE_PATH = resolve(ASSETS_DIR, "docx-template.zip");
const PDF_CSS_PATH = resolve(ASSETS_DIR, "md2pdf.css");

const READABLE_FORMATS = new Set([".docx", ".xlsx", ".pptx"]);
const WRITABLE_FORMATS = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

function getXlsx(): any {
  if (!cachedXlsx) cachedXlsx = require(XLSX_PACKAGE);
  return cachedXlsx;
}

function getPptxGenJs(): any {
  if (!cachedPptxGenJs) cachedPptxGenJs = require(PPTXGEN_PATH);
  return cachedPptxGenJs;
}

function getFflate(): any {
  if (!cachedFflate) cachedFflate = require("fflate");
  return cachedFflate;
}

async function getCdpModule(): Promise<typeof import("../../browser/cdp-browser/cdp.ts")> {
  if (!cachedCdpModule) cachedCdpModule = import("../../browser/cdp-browser/cdp.ts");
  return await cachedCdpModule;
}

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

type OfficeToolUiContext = {
  hasUI?: boolean;
  ui?: {
    setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void;
    setWorkingMessage: (message?: string) => void;
  };
};

const OFFICE_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function startOfficeUiProgress(ctx: OfficeToolUiContext | undefined, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingIndicator({ frames: OFFICE_WORKING_FRAMES, intervalMs: 90 });
  ctx.ui.setWorkingMessage(message);
}

function updateOfficeUiProgress(ctx: OfficeToolUiContext | undefined, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(message);
}

function finishOfficeUiProgress(ctx: OfficeToolUiContext | undefined): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(undefined);
  ctx.ui.setWorkingIndicator({ frames: [] });
}

registerToolStatusHintProvider({
  id: "office_tools",
  buildHints: ({ toolName, args }) => {
    if (toolName !== "office_read" && toolName !== "office_write") return null;
    const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
    const path = readTrimmedString(record?.path);
    if (!path) return null;
    const mode = toolName === "office_read" ? "Office read" : "Office write";
    return {
      key: toolName,
      icon_svg: OFFICE_TOOLS_STATUS_ICON_SVG,
      label: path,
      title: `${mode} • ${path}`,
      kind: "file",
    };
  },
});

function resolveWorkspacePath(baseDir: string, requestedPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, requestedPath.replace(/^@/, ""));
  if (target !== base && !target.startsWith(base + "/") && !target.startsWith(base + "\\")) {
    throw new Error("Path must stay inside the workspace");
  }
  return target;
}

function readZipEntries(buf: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  const eocdSignature = 0x06054b50;
  const centralDirSignature = 0x02014b50;
  const localHeaderSignature = 0x04034b50;
  const minEocdSize = 22;
  const maxCommentSize = 0xffff;
  const searchStart = Math.max(0, buf.length - (minEocdSize + maxCommentSize));

  let eocdOffset = -1;
  for (let offset = buf.length - minEocdSize; offset >= searchStart; offset -= 1) {
    if (buf.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buf.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  let seen = 0;

  while (offset + 46 <= buf.length && seen < entryCount) {
    if (buf.readUInt32LE(offset) !== centralDirSignature) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buf.length) break;
    const name = buf.toString("utf-8", nameStart, nameEnd);

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== localHeaderSignature) {
      offset = nameEnd + extraLength + commentLength;
      seen += 1;
      continue;
    }

    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd <= buf.length) {
      const text = decodeZipEntryText(name, method, buf.subarray(dataStart, dataEnd));
      if (text !== null) entries.set(name, text);
    }

    offset = nameEnd + extraLength + commentLength;
    seen += 1;
  }

  return entries;
}

function stripXml(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(Number(n)))
    .trim();
}

function docxToMarkdown(buf: Buffer): string {
  const zip = readZipEntries(buf);
  const docXml = zip.get("word/document.xml");
  if (!docXml) throw new Error("No word/document.xml found");

  const relsXml = zip.get("word/_rels/document.xml.rels") || "";
  const relMap = new Map<string, string>();
  for (const match of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(match[1], match[2]);
  }

  const lines: string[] = [];
  const body = docXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/)?.[1] || docXml;
  for (const element of body.match(/<w:tbl[\s\S]*?<\/w:tbl>|<w:p[\s\S]*?<\/w:p>/g) || []) {
    if (element.startsWith("<w:tbl")) {
      lines.push(docxTable(element));
      lines.push("");
    } else {
      lines.push(docxParagraph(element, relMap));
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function docxParagraph(pXml: string, relMap: Map<string, string>): string {
  const style = pXml.match(/w:pStyle\s+w:val="([^"]+)"/)?.[1] || "";
  const headingLevel = style.match(/^Heading(\d)$/i)?.[1];
  const isBulletStyle = /^ListBullet/i.test(style);
  const isNumberStyle = /^ListNumber/i.test(style);
  const isList = /<w:numPr/.test(pXml) || isBulletStyle || isNumberStyle;
  const indent = pXml.match(/w:ilvl\s+w:val="(\d+)"/)?.[1] || "0";
  const text = docxRuns(pXml, relMap);
  if (!text && !headingLevel) return "";
  if (headingLevel) return `${"#".repeat(Math.min(Number(headingLevel), 6))} ${text}`;
  if (isList) {
    const prefix = isNumberStyle ? "1." : "-";
    return `${"  ".repeat(Number(indent))}${prefix} ${text}`;
  }
  return text;
}

function docxRuns(pXml: string, relMap: Map<string, string>): string {
  const parts: string[] = [];
  for (const chunk of pXml.match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>|<w:r[\s>][\s\S]*?<\/w:r>/g) || []) {
    if (chunk.startsWith("<w:hyperlink")) {
      const relId = chunk.match(/r:id="([^"]+)"/)?.[1];
      const url = relId ? relMap.get(relId) : null;
      const linkText = stripXml(chunk.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ""));
      parts.push(url && linkText ? `[${linkText}](${url})` : linkText);
      continue;
    }
    const text = (chunk.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((token) => token.replace(/<[^>]+>/g, "")).join("");
    if (!text) continue;
    const rPr = chunk.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] || "";
    const bold = /<w:b[\s/>]/.test(rPr) && !/<w:b\s+w:val="(false|0)"/.test(rPr);
    const italic = /<w:i[\s/>]/.test(rPr) && !/<w:i\s+w:val="(false|0)"/.test(rPr);
    parts.push(bold && italic ? `***${text}***` : bold ? `**${text}**` : italic ? `*${text}*` : text);
  }
  return parts.join("").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function docxTable(tblXml: string): string {
  const rows = (tblXml.match(/<w:tr[\s\S]*?<\/w:tr>/g) || []).map((row) =>
    (row.match(/<w:tc[\s\S]*?<\/w:tc>/g) || []).map((cell) =>
      (cell.match(/<w:p[\s\S]*?<\/w:p>/g) || []).map((p) => docxRuns(p, new Map())).join(" ").trim(),
    ),
  );
  return mdTable(rows);
}

function xlsxToMarkdown(buf: Buffer): string {
  const XLSX = getXlsx();
  const workbook = XLSX.read(buf, { type: "buffer" });
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const data: string[][] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "" });
    if (!data.length) continue;
    sections.push(`## ${name}\n`);
    const cols = Math.max(...data.map((row: string[]) => row.length));
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i].map((cell: unknown) => String(cell ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "));
      while (row.length < cols) row.push("");
      sections.push(`| ${row.join(" | ")} |`);
      if (i === 0) sections.push(`|${" --- |".repeat(cols)}`);
    }
    sections.push("");
  }
  return sections.join("\n").trim();
}

function pptxToMarkdown(buf: Buffer): string {
  const zip = readZipEntries(buf);
  const sections: string[] = [];
  const slides = [...zip.keys()]
    .filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));

  for (const file of slides) {
    const num = file.match(/slide(\d+)/)?.[1] || "?";
    const xml = zip.get(file) || "";
    let title = "";
    const body: string[] = [];
    const tables: string[] = [];

    for (const shape of xml.match(/<p:sp[\s>][\s\S]*?<\/p:sp>/g) || []) {
      const isTitle = /type="(title|ctrTitle)"/i.test(shape);
      const texts = slideTexts(shape);
      if (isTitle && texts.length) title = texts.join(" ");
      else if (texts.length && !title && body.length === 0) title = texts.join(" ").replace(/^\*\*(.*?)\*\*$/, "$1");
      else if (texts.length) body.push(...texts);
    }

    for (const table of xml.match(/<a:tbl[\s\S]*?<\/a:tbl>/g) || []) {
      tables.push(pptxTable(table));
    }

    sections.push(`## Slide ${num}${title ? `: ${title}` : ""}\n`);
    if (body.length) sections.push(body.join("\n"));
    if (tables.length) sections.push(tables.join("\n\n"));

    const noteXml = zip.get(`ppt/notesSlides/notesSlide${num}.xml`);
    if (noteXml) {
      const notes = (noteXml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || [])
        .map((p) => stripXml(p))
        .filter((text) => text && !/^\d+$/.test(text));
      if (notes.length) sections.push(`\n> **Notes:** ${notes.join(" ")}`);
    }
    sections.push("");
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function slideTexts(shape: string): string[] {
  return (shape.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []).map((paragraph) => {
    const bullet = /<a:buChar|<a:buAutoNum/.test(paragraph);
    const text = (paragraph.match(/<a:r[\s>][\s\S]*?<\/a:r>/g) || []).map((runXml) => {
      const textValue = runXml.match(/<a:t>([^<]*)<\/a:t>/)?.[1] || "";
      const rPr = runXml.match(/<a:rPr[^>]*>/)?.[0] || "";
      const bold = /\bb="1"/.test(rPr);
      const italic = /\bi="1"/.test(rPr);
      return bold && italic ? `***${textValue}***` : bold ? `**${textValue}**` : italic ? `*${textValue}*` : textValue;
    }).join("");
    return text.trim() ? (bullet ? `- ${text.trim()}` : text.trim()) : null;
  }).filter(Boolean) as string[];
}

function pptxTable(tblXml: string): string {
  const rows = (tblXml.match(/<a:tr[\s\S]*?<\/a:tr>/g) || []).map((row) =>
    (row.match(/<a:tc[\s\S]*?<\/a:tc>/g) || []).map((cell) => stripXml(cell).replace(/\n/g, " ").trim()),
  );
  return mdTable(rows);
}

function mdTable(rows: string[][]): string {
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((row) => row.length));
  return rows.map((row, index) => {
    while (row.length < cols) row.push("");
    const line = `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
    return index === 0 ? `${line}\n|${" --- |".repeat(cols)}` : line;
  }).join("\n");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(text: string, props?: string): string {
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function boldRun(text: string): string {
  return run(text, "<w:b/>");
}

function italicRun(text: string): string {
  return run(text, "<w:i/>");
}

function codeRun(text: string): string {
  return run(text, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
}

function para(content: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}${content}</w:p>`;
}

function hrPara(): string {
  return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
}

function parseInlineDocx(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        result += boldRun(text.substring(i + 2, end));
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && text[end + 1] !== "*") {
        result += italicRun(text.substring(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "`" && text[i + 1] !== "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        result += codeRun(text.substring(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    let j = i + 1;
    while (j < text.length && text[j] !== "*" && text[j] !== "`") j += 1;
    result += run(text.substring(i, j));
    i = j;
  }
  return result;
}

function renderDocxTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = rows[0].length;
  const pageWidth = 9360;
  const col0MaxLen = Math.max(...rows.map((row) => (row[0] ?? "").trim().replace(/\*\*/g, "").length));
  const col0Width = Math.min(3600, Math.max(1200, col0MaxLen * 120));
  const remainingWidth = pageWidth - col0Width;
  const otherColWidth = cols > 1 ? Math.floor(remainingWidth / (cols - 1)) : 0;

  let xml = "<w:tbl>";
  xml += '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:type="pct" w:w="5000"/>';
  xml += '<w:tblLook w:firstColumn="1" w:firstRow="1" w:lastColumn="0" w:lastRow="0" w:noHBand="0" w:noVBand="1" w:val="04A0"/></w:tblPr>';
  xml += "<w:tblGrid>";
  xml += `<w:gridCol w:w="${col0Width}"/>`;
  for (let c = 1; c < cols; c += 1) xml += `<w:gridCol w:w="${otherColWidth}"/>`;
  xml += "</w:tblGrid>";

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const isHeader = r === 0;
    xml += "<w:tr>";
    for (let c = 0; c < cols; c += 1) {
      const cell = row[c] ?? "";
      const width = c === 0 ? col0Width : otherColWidth;
      xml += `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${width}"/>`;
      if (isHeader) xml += '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>';
      xml += "</w:tcPr>";
      xml += isHeader
        ? `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${parseInlineDocx(`**${cell.trim()}**`)}</w:p>`
        : `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${parseInlineDocx(cell.trim())}</w:p>`;
      xml += "</w:tc>";
    }
    xml += "</w:tr>";
  }
  xml += "</w:tbl>";
  return xml;
}

function markdownToDocxBodyXml(markdown: string): string {
  const lines = markdown.split("\n");
  let body = "";
  let i = 0;
  let tableRows: string[][] = [];
  let inTable = false;

  const flushTable = () => {
    if (tableRows.length > 0) body += renderDocxTable(tableRows);
    tableRows = [];
    inTable = false;
  };

  const isLabelLine = (line: string) => /^\*\*[^*]+[:]\*\*\s*.+/.test(line.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const cells = line.split("|").slice(1, -1);
      if (cells.every((cell) => /^[\s:-]+$/.test(cell))) {
        i += 1;
        continue;
      }
      if (!inTable) inTable = true;
      tableRows.push(cells);
      i += 1;
      continue;
    }
    if (inTable) flushTable();

    if (/^---+\s*$/.test(line.trim())) {
      body += hrPara();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      const spacing = level === 1 ? 360 : level === 2 ? 240 : 160;
      body += `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:spacing w:before="${spacing}"/></w:pPr>${parseInlineDocx(heading[2])}</w:p>`;
      i += 1;
      continue;
    }

    if (isLabelLine(line)) {
      let merged = parseInlineDocx(line.trim());
      let j = i + 1;
      while (j < lines.length && isLabelLine(lines[j])) {
        merged += '<w:r><w:br/></w:r>' + parseInlineDocx(lines[j].trim());
        j += 1;
      }
      body += para(merged);
      i = j;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      body += para(parseInlineDocx(line.replace(/^\s*[-*]\s+/, "")), "ListBullet");
      i += 1;
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)/);
    if (numbered) {
      body += para(parseInlineDocx(numbered[1]), "ListNumber");
      i += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      i += 1;
      let code = "";
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code += (code ? "\n" : "") + lines[i];
        i += 1;
      }
      if (i < lines.length) i += 1;
      for (const codeLine of code.split("\n")) {
        body += para(codeRun(codeLine || " "));
      }
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    body += para(parseInlineDocx(line));
    i += 1;
  }

  if (inTable) flushTable();
  return body;
}

async function mdToDocx(markdown: string): Promise<Buffer> {
  const { unzipSync, strFromU8, strToU8, zipSync } = getFflate();
  if (!existsSync(DOCX_TEMPLATE_PATH)) throw new Error(`Template not found: ${DOCX_TEMPLATE_PATH}`);
  const templateEntries = unzipSync(readFileSync(DOCX_TEMPLATE_PATH));
  const templateDocXml = templateEntries["word/document.xml"] ? strFromU8(templateEntries["word/document.xml"]) : "";
  const bodyXml = markdownToDocxBodyXml(markdown);
  templateEntries["word/document.xml"] = strToU8(templateDocXml.replace("{{BODY}}", bodyXml));
  return Buffer.from(zipSync(templateEntries, { level: 6 }));
}

interface ExtractedSheet {
  name: string;
  rows: string[][];
}

function extractMarkdownTables(markdown: string): ExtractedSheet[] {
  const sheets: ExtractedSheet[] = [];
  const lines = markdown.split("\n");
  let currentHeading = "";
  let i = 0;
  let tableCount = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const heading = trimmed.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      currentHeading = heading[1].trim();
      i += 1;
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!(rowLine.startsWith("|") && rowLine.endsWith("|"))) break;
        const cells = rowLine.split("|").slice(1, -1).map((cell) => cell.trim());
        if (!cells.every((cell) => /^[\s:-]+$/.test(cell))) rows.push(cells);
        i += 1;
      }
      if (rows.length) {
        tableCount += 1;
        sheets.push({
          name: (currentHeading || `Table ${tableCount}`).substring(0, 31).replace(/[\\/*?\[\]]/g, "_"),
          rows,
        });
      }
      continue;
    }
    i += 1;
  }

  return sheets;
}

function mdToXlsx(markdown: string): Buffer {
  const XLSX = getXlsx();
  const workbook = XLSX.utils.book_new();
  const tables = extractMarkdownTables(markdown);

  if (tables.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet(markdown.split("\n").map((line) => [line]));
    XLSX.utils.book_append_sheet(workbook, ws, "Content");
  } else {
    for (const table of tables) {
      const rows = table.rows.map((row) => row.map((cell) => {
        const maybeNumber = Number(cell);
        return cell !== "" && !Number.isNaN(maybeNumber) ? maybeNumber : cell;
      }));
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = table.rows[0]?.map((_, ci) => ({
        wch: Math.min(Math.max(...table.rows.map((row) => String(row[ci] ?? "").length), 8) + 2, 50),
      }));
      XLSX.utils.book_append_sheet(workbook, ws, table.name || "Table");
    }
  }

  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function stripMdFmt(text: string): string {
  return text.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1").replace(/`(.*?)`/g, "$1");
}

async function mdToPptx(markdown: string): Promise<Buffer> {
  const PptxGenJS = getPptxGenJs();
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^---\s*$/.test(line.trim()) || /^##\s/.test(line.trim())) {
      if (current.some((entry) => entry.trim())) blocks.push(current.join("\n"));
      current = /^##\s/.test(line.trim()) ? [line] : [];
      continue;
    }
    current.push(line);
  }
  if (current.some((entry) => entry.trim())) blocks.push(current.join("\n"));

  for (const block of blocks) {
    const slide = pptx.addSlide();
    const lines = block.trim().split("\n");
    let title = "";
    const bodyLines: string[] = [];
    const tables: string[][][] = [];
    let inTable = false;
    let currentTable: string[][] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#{1,2}\s/.test(trimmed) && !title) {
        title = trimmed.replace(/^#+\s*/, "");
        continue;
      }
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (/^\|[\s-:|]+\|$/.test(trimmed)) continue;
        if (!inTable) {
          inTable = true;
          currentTable = [];
        }
        currentTable.push(trimmed.split("|").slice(1, -1).map((cell) => cell.trim()));
        continue;
      }
      if (inTable) {
        tables.push(currentTable);
        currentTable = [];
        inTable = false;
      }
      if (trimmed === "---") continue;
      if (trimmed) bodyLines.push(trimmed);
    }
    if (inTable && currentTable.length) tables.push(currentTable);

    if (title) slide.addText(stripMdFmt(title), { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 28, bold: true, color: "1F3864" });
    let yPos = title ? 1.3 : 0.5;

    if (bodyLines.length) {
      slide.addText(bodyLines.map((line) => ({
        text: stripMdFmt(line.replace(/^[-*]\s+|^\d+\.\s+/, "")),
        options: {
          fontSize: 14,
          bullet: /^[-*]\s/.test(line) || /^\d+\.\s/.test(line),
          bold: /^\*\*[^*]+\*\*$/.test(line.trim()),
        },
      })), { x: 0.5, y: yPos, w: 12, h: Math.min(bodyLines.length * 0.35, 4.5), valign: "top" });
      yPos += Math.min(bodyLines.length * 0.35, 4.5) + 0.2;
    }

    for (const table of tables) {
      if (!table.length) continue;
      const cols = Math.max(...table.map((row) => row.length));
      const colWidth = Math.min(11 / cols, 3);
      slide.addTable(table.map((row, rowIndex) => {
        while (row.length < cols) row.push("");
        return row.map((cell) => ({
          text: cell,
          options: {
            fontSize: 10,
            bold: rowIndex === 0,
            fill: rowIndex === 0 ? { color: "D9E2F3" } : undefined,
            border: { type: "solid", pt: 0.5, color: "9DC3E6" },
          },
        }));
      }), { x: 0.5, y: yPos, w: cols * colWidth, fontSize: 10, colW: Array(cols).fill(colWidth) });
      yPos += table.length * 0.35 + 0.3;
    }
  }

  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseInlineHtml(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToHtml(markdown: string): string {
  const css = existsSync(PDF_CSS_PATH) ? readFileSync(PDF_CSS_PATH, "utf-8") : "";
  const lines = markdown.split("\n");
  let html = "";
  let i = 0;
  let inList: "ul" | "ol" | null = null;
  let tableRows: string[][] = [];
  let inTable = false;

  const flushList = () => {
    if (inList) {
      html += `</${inList}>`;
      inList = null;
    }
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    html += "<table><thead><tr>";
    for (const cell of tableRows[0]) html += `<th>${parseInlineHtml(escapeHtml(cell.trim()))}</th>`;
    html += "</tr></thead><tbody>";
    for (let r = 1; r < tableRows.length; r += 1) {
      html += "<tr>";
      for (const cell of tableRows[r]) html += `<td>${parseInlineHtml(escapeHtml(cell.trim()))}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    tableRows = [];
    inTable = false;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      flushList();
      const cells = line.split("|").slice(1, -1);
      if (cells.every((cell) => /^[\s:-]+$/.test(cell))) {
        i += 1;
        continue;
      }
      if (!inTable) inTable = true;
      tableRows.push(cells);
      i += 1;
      continue;
    }
    if (inTable) flushTable();

    if (/^---+\s*$/.test(line.trim())) {
      flushList();
      html += "<hr>";
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      flushList();
      html += `<h${heading[1].length}>${parseInlineHtml(escapeHtml(heading[2]))}</h${heading[1].length}>`;
      i += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      flushList();
      i += 1;
      let code = "";
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code += (code ? "\n" : "") + lines[i];
        i += 1;
      }
      if (i < lines.length) i += 1;
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (inList !== "ul") {
        flushList();
        html += "<ul>";
        inList = "ul";
      }
      html += `<li>${parseInlineHtml(escapeHtml(line.replace(/^\s*[-*]\s+/, "")))}</li>`;
      i += 1;
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)/);
    if (numbered) {
      if (inList !== "ol") {
        flushList();
        html += "<ol>";
        inList = "ol";
      }
      html += `<li>${parseInlineHtml(escapeHtml(numbered[1]))}</li>`;
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      flushList();
      i += 1;
      continue;
    }

    flushList();
    html += `<p>${parseInlineHtml(escapeHtml(line))}</p>`;
    i += 1;
  }

  flushList();
  if (inTable) flushTable();

  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>${css}</style>\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

async function mdToPdf(markdown: string, outputPath: string, signal?: MaybeAbortSignal): Promise<void> {
  const html = markdownToHtml(markdown);
  const htmlPath = outputPath.replace(/\.pdf$/i, ".print.html");
  writeFileSync(htmlPath, html, "utf-8");

  try {
    const { findCdpPort, ensureBrowser, findBrowser, printToPdf } = await getCdpModule();
    const port = await findCdpPort(signal) ?? await ensureBrowser(signal);
    if (!port) {
      const browser = findBrowser();
      throw new Error(browser
        ? `No CDP browser found. ${browser.name} exists at ${browser.command} but could not launch with CDP.`
        : "No Chromium browser found. Install Edge, Chrome, or Chromium and launch with --remote-debugging-port=9224");
    }

    await printToPdf({
      port,
      outPath: outputPath,
      url: pathToFileURL(htmlPath).href,
      waitMs: 2000,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px; width:100%; text-align:center; color:#666; font-family:Calibri,sans-serif;">\n        <span class="pageNumber"></span> / <span class="totalPages"></span>\n      </div>`,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      signal,
    });
  } finally {
    rmSync(htmlPath, { force: true });
  }
}

export const officeReadParameters = Type.Object({
  path: Type.String({ description: "Workspace path to the Office document (.docx, .xlsx, or .pptx)" }),
});

export const officeWriteParameters = Type.Object({
  path: Type.String({ description: "Workspace output path (.docx, .xlsx, .pptx, or .pdf)" }),
  markdown: Type.String({ description: "Markdown content to convert" }),
});

export async function executeOfficeRead(params: { path: string }, ctx?: { cwd?: string } & OfficeToolUiContext): Promise<any> {
  startOfficeUiProgress(ctx, `Office: reading ${params.path}…`);
  try {
    const baseDir = ctx?.cwd ?? process.cwd();
    const filePath = resolveWorkspacePath(baseDir, params.path);
    if (!existsSync(filePath)) return { content: [{ type: "text", text: `File not found: ${params.path}` }], details: { ok: false } };
    const ext = extname(filePath).toLowerCase();
    if (!READABLE_FORMATS.has(ext)) {
      return { content: [{ type: "text", text: `Unsupported format: ${ext}. Supported: .docx, .xlsx, .pptx.` }], details: { ok: false } };
    }

    updateOfficeUiProgress(ctx, `Office: parsing ${basename(filePath)}…`);
    const buf = readFileSync(filePath);
    if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) {
      return { content: [{ type: "text", text: `Legacy Office format (OLE2), not OOXML. Re-save as ${ext}x in Office first.` }], details: { ok: false } };
    }

    let markdown = "";
    if (ext === ".docx") markdown = docxToMarkdown(buf);
    else if (ext === ".xlsx") markdown = xlsxToMarkdown(buf);
    else if (ext === ".pptx") markdown = pptxToMarkdown(buf);

    const truncated = markdown.length > 100_000;
    return {
      content: [{ type: "text", text: (truncated ? `${markdown.slice(0, 100_000)}\n\n…(truncated)` : markdown) || "(empty document)" }],
      details: { ok: true, path: filePath, format: ext, chars: markdown.length, truncated },
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Failed to read Office document: ${error.message}` }],
      details: { ok: false, error: error.message },
    };
  } finally {
    finishOfficeUiProgress(ctx);
  }
}

export async function executeOfficeWrite(
  params: { path: string; markdown: string },
  signal?: MaybeAbortSignal,
  ctx?: { cwd?: string } & OfficeToolUiContext,
): Promise<any> {
  startOfficeUiProgress(ctx, `Office: writing ${params.path}…`);
  try {
    const baseDir = ctx?.cwd ?? process.cwd();
    const filePath = resolveWorkspacePath(baseDir, params.path);
    const ext = extname(filePath).toLowerCase();
    if (!WRITABLE_FORMATS.has(ext)) {
      return { content: [{ type: "text", text: `Unsupported format: ${ext}. Use .docx, .xlsx, .pptx, or .pdf.` }], details: { ok: false } };
    }
    mkdirSync(dirname(filePath), { recursive: true });

    updateOfficeUiProgress(ctx, `Office: generating ${basename(filePath)}…`);
    let buf: Buffer | null = null;
    if (ext === ".docx") buf = await mdToDocx(params.markdown);
    else if (ext === ".xlsx") buf = mdToXlsx(params.markdown);
    else if (ext === ".pptx") buf = await mdToPptx(params.markdown);
    else if (ext === ".pdf") {
      updateOfficeUiProgress(ctx, `Office: exporting PDF ${basename(filePath)}…`);
      await mdToPdf(params.markdown, filePath, signal);
    }

    if (buf) writeFileSync(filePath, buf);
    const size = existsSync(filePath) ? readFileSync(filePath).length : 0;
    return {
      content: [{ type: "text", text: `Written: ${params.path} (${Math.max(1, Math.round(size / 1024))} KB)` }],
      details: { ok: true, path: filePath, format: ext, size },
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Failed to generate Office output: ${error.message}` }],
      details: { ok: false, error: error.message },
    };
  } finally {
    finishOfficeUiProgress(ctx);
  }
}

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "office_read",
    label: "Read Office Document",
    description:
      "Read a Microsoft Office document (.docx, .xlsx, .pptx) and return its content as Markdown. " +
      "OOXML only; legacy .doc/.xls/.ppt formats are rejected.",
    promptSnippet: "office_read: extract a .docx, .xlsx, or .pptx file to Markdown for inspection.",
    parameters: officeReadParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return await executeOfficeRead(params, ctx as { cwd?: string } | undefined);
    },
  });

  pi.registerTool({
    name: "office_write",
    label: "Write Office Document",
    description:
      "Generate a Microsoft Office document (.docx, .xlsx, .pptx) or PDF (.pdf) from Markdown content.",
    promptSnippet: "office_write: generate a .docx, .xlsx, .pptx, or .pdf file from Markdown content.",
    parameters: officeWriteParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return await executeOfficeWrite(params, signal, ctx as { cwd?: string } | undefined);
    },
  });
}
