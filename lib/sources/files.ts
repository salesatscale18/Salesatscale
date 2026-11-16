/**
 * Uploaded files to text sections (P8.3). Pure parsing, no AI:
 * - PDF: one section per page (locator "p.N"); empty pages are reported as scanned.
 * - DOCX: sections by headings.
 * - TXT / MD: sections by Markdown headings or by size.
 * - CSV / XLSX: rows stored as text; mapping them into the catalog is a later step.
 * The uploaded bytes are never stored, only the text.
 */
import type { SourceProblem } from "@/db/schema";
import { parseCsv } from "@/lib/leads/rules";
import { decodeEntities, htmlToText } from "./html";
import { cleanText, MAX_FILE_BYTES, type ParseResult, type ParsedSection } from "./text";

export type FileKind = "pdf" | "docx" | "txt" | "md" | "csv" | "xlsx";

/** File types the upload accepts (the `accept` attribute and the server check). */
export const FILE_ACCEPT = ".pdf,.docx,.txt,.md,.csv,.xlsx";

const EXT: Record<string, FileKind> = { pdf: "pdf", docx: "docx", txt: "txt", md: "md", markdown: "md", csv: "csv", xlsx: "xlsx" };

export class FileRejected extends Error {}

/** The kind of an upload from its name, checked against its first bytes. Throws FileRejected with a plain message. */
export function fileKind(name: string, bytes: Uint8Array): FileKind {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const kind = EXT[ext];
  if (!kind) throw new FileRejected(`${name}: this file type is not supported. Upload PDF, DOCX, TXT, MD, CSV or XLSX.`);
  if (bytes.byteLength === 0) throw new FileRejected(`${name}: the file is empty.`);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new FileRejected(`${name}: the file is larger than 10 MB.`);
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (kind === "pdf" && !head.startsWith("%PDF")) throw new FileRejected(`${name}: this is not a valid PDF file.`);
  if ((kind === "docx" || kind === "xlsx") && !head.startsWith("PK")) throw new FileRejected(`${name}: this is not a valid ${kind.toUpperCase()} file.`);
  return kind;
}

const scanned = (from: number, to: number): SourceProblem => ({
  where: from === to ? `p.${from}` : `p.${from}–${to}`,
  message: from === to ? `Page ${from} looks scanned, so we could not read it.` : `Pages ${from} to ${to} look scanned, so we could not read them.`,
  fix: "Upload a text version or type the key points.",
});

export async function parsePdf(bytes: Uint8Array): Promise<ParseResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pages: string[];
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    pages = (await extractText(doc, { mergePages: false })).text;
  } catch {
    return { sections: [], problems: [{ where: "file", message: "We could not open this PDF. It may be damaged or password protected.", fix: "Save it again without a password and upload it, or upload a Word version." }] };
  }
  const sections: ParsedSection[] = [];
  const problems: SourceProblem[] = [];
  let runStart = 0;
  pages.forEach((raw, i) => {
    const n = i + 1;
    const text = cleanText(raw);
    if (text) {
      sections.push({ locator: `p.${n}`, heading: null, text });
      if (runStart) { problems.push(scanned(runStart, n - 1)); runStart = 0; }
    } else if (!runStart) runStart = n;
  });
  if (runStart) problems.push(scanned(runStart, pages.length));
  return { sections, problems, stats: { pages: pages.length } };
}

/** Splits HTML (from mammoth) into sections at h1–h3. */
export function sectionsFromHeadings(html: string): ParsedSection[] {
  const parts = html.split(/(?=<h[1-3][^>]*>)/i);
  const out: ParsedSection[] = [];
  for (const part of parts) {
    const h = part.match(/^<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const heading = h ? cleanText(decodeEntities(h[1].replace(/<[^>]+>/g, " "))).replace(/\n/g, " ") : null;
    const body = htmlToText(h ? part.slice(h[0].length) : part).text;
    if (!body && !heading) continue;
    out.push({ locator: heading ? heading.slice(0, 80) : out.length === 0 ? "Start" : `Part ${out.length + 1}`, heading, text: body || heading || "" });
  }
  return out;
}

export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return value;
}

export async function parseDocx(bytes: Uint8Array): Promise<ParseResult> {
  let html: string;
  try {
    html = await docxToHtml(bytes);
  } catch {
    return { sections: [], problems: [{ where: "file", message: "We could not open this Word file.", fix: "Save it again as DOCX and upload it, or upload a PDF version." }] };
  }
  const sections = sectionsFromHeadings(html);
  return { sections, problems: sections.length ? [] : [{ where: "file", message: "This document has no text we can read.", fix: "Upload a text version or type the key points." }] };
}

/** Splits plain text into parts of about `size` characters at blank lines. */
export function chunkText(text: string, size = 4000): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size * 2) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parsePlainText(raw: string, markdown: boolean): ParseResult {
  const text = cleanText(raw.replace(/^﻿/, ""));
  if (markdown && /^#{1,3}\s/m.test(text)) {
    const sections: ParsedSection[] = [];
    for (const part of text.split(/\n(?=#{1,3}\s)/)) {
      const h = part.match(/^#{1,3}\s+(.+)/);
      const heading = h ? h[1].trim() : null;
      const body = cleanText(h ? part.slice(h[0].length) : part);
      if (!body && !heading) continue;
      sections.push({ locator: heading ? heading.slice(0, 80) : "Start", heading, text: body || heading || "" });
    }
    return { sections, problems: [] };
  }
  const parts = chunkText(text);
  return { sections: parts.map((p, i) => ({ locator: parts.length === 1 ? "text" : `part ${i + 1}`, heading: null, text: p })), problems: [] };
}

const ROWS_PER_SECTION = 50;

const mapColumns = (where: string): SourceProblem => ({
  where,
  message: "We saved these rows as text. To use them as products or prices, map their columns first.",
  fix: "Map columns to import into the catalog",
});

/** Rows as text sections, 50 rows each, with the header row repeated on top of every section. */
function rowSections(rows: string[][], label: string): ParsedSection[] {
  const clean = rows.map((r) => r.map((c) => c.replace(/\s+/g, " ").trim())).filter((r) => r.some(Boolean));
  if (clean.length === 0) return [];
  const [header, ...body] = clean;
  const line = (r: string[]) => r.join(" | ");
  if (body.length === 0) return [{ locator: `${label}row 1`, heading: null, text: line(header) }];
  const out: ParsedSection[] = [];
  for (let i = 0; i < body.length; i += ROWS_PER_SECTION) {
    const chunk = body.slice(i, i + ROWS_PER_SECTION);
    const from = i + 2;
    const to = i + 1 + chunk.length;
    out.push({ locator: `${label}rows ${from}–${to}`, heading: null, text: [line(header), ...chunk.map(line)].join("\n") });
  }
  return out;
}

// TODO(P8 catalog import): map CSV/XLSX columns (name, unit, price, currency) into catalog items or a price list.
export function parseCsvFile(raw: string, name: string): ParseResult {
  const rows = parseCsv(raw.replace(/^﻿/, ""));
  const sections = rowSections(rows, "");
  return {
    sections,
    problems: sections.length ? [mapColumns(name)] : [{ where: name, message: "This file has no rows.", fix: "Check the file and upload it again." }],
    needsInput: sections.length > 0,
    stats: { rows: rows.length },
  };
}

function xmlText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

/** Column letters ("C") to a 0-based index. */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** Reads every sheet of an XLSX workbook as rows of cell text (values, not formulas). */
export async function readXlsx(bytes: Uint8Array): Promise<{ name: string; rows: string[][] }[]> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && f.name.endsWith(".xml") && f.originalSize < 50 * 1024 * 1024 });
  const read = (n: string) => (files[n] ? strFromU8(files[n]) : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(""));
  const names = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const sheetFiles = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  return sheetFiles.map((f, i) => {
    const rows: string[][] = [];
    for (const rm of read(f).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const inner = cm[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join("");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = xmlText(v);
        const at = ref ? colIndex(ref) : row.length;
        if (at > 200) continue;
        while (row.length < at) row.push("");
        row[at] = value;
      }
      rows.push(row);
    }
    return { name: names[i] ?? `Sheet${i + 1}`, rows };
  });
}

export async function parseXlsxFile(bytes: Uint8Array, name: string): Promise<ParseResult> {
  let sheets: { name: string; rows: string[][] }[];
  try {
    sheets = await readXlsx(bytes);
  } catch {
    return { sections: [], problems: [{ where: name, message: "We could not open this spreadsheet.", fix: "Save it again as XLSX or CSV and upload it." }] };
  }
  const sections = sheets.flatMap((s) => rowSections(s.rows, sheets.length > 1 ? `${s.name} ` : ""));
  const rows = sheets.reduce((n, s) => n + s.rows.length, 0);
  return {
    sections,
    problems: sections.length ? [mapColumns(name)] : [{ where: name, message: "This spreadsheet has no rows.", fix: "Check the file and upload it again." }],
    needsInput: sections.length > 0,
    stats: { rows },
  };
}

/** Parses one uploaded file by its kind. */
export async function parseFile(kind: FileKind, bytes: Uint8Array, name: string): Promise<ParseResult> {
  switch (kind) {
    case "pdf": return parsePdf(bytes);
    case "docx": return parseDocx(bytes);
    case "txt": return parsePlainText(new TextDecoder().decode(bytes), false);
    case "md": return parsePlainText(new TextDecoder().decode(bytes), true);
    case "csv": return parseCsvFile(new TextDecoder().decode(bytes), name);
    case "xlsx": return parseXlsxFile(bytes, name);
  }
}
