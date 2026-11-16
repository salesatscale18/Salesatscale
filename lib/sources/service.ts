/**
 * Knowledge sources (P8.3): create, read, re-read and delete sources, and
 * store their parsed text and sections. Every function takes `accountId`
 * and only touches that account's rows. No AI calls: parsing only.
 *
 * text_hash: the sha256 of extracted_text at the time the pipeline last
 * analysed it. Null means "new or changed: needs analysis". Ingestion never
 * sets it; a re-read that finds the same text keeps it (nothing to redo).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  knowledgeFacts, sourceSections, sources, type Source, type SourceKind, type SourceOrigin, type SourceProblem, type SourceStats,
} from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { isUuid } from "@/lib/security/ids";
import { docxToHtml, fileKind, parseFile, FileRejected } from "./files";
import { htmlToText } from "./html";
import { parseTranscript } from "./transcript";
import { crawlWebsite, normalizePaths, type CrawlOptions } from "./website";
import { parsePublicUrl, UnsafeUrlError } from "./ssrf";
import { capSections, estimateTokens, guessLanguage, joinSections, sha256, statusFor, type ParseResult } from "./text";

export { FileRejected, UnsafeUrlError };

/** A plain-words input error the page shows as is. */
export class SourceInputError extends Error {}

const where = (accountId: string, id: string) => and(eq(sources.accountId, accountId), eq(sources.id, id));

/** The sources table without the (large) text column. */
const listColumns = {
  id: sources.id, kind: sources.kind, title: sources.title, language: sources.language, status: sources.status,
  origin: sources.origin, stats: sources.stats, problems: sources.problems, textHash: sources.textHash,
  createdAt: sources.createdAt, updatedAt: sources.updatedAt,
};
export type SourceListRow = Pick<Source, keyof typeof listColumns>;

export async function listSources(db: Db, accountId: string): Promise<SourceListRow[]> {
  return db.select(listColumns).from(sources).where(eq(sources.accountId, accountId)).orderBy(desc(sources.createdAt), desc(sources.id));
}

export async function getSource(db: Db, accountId: string, id: string): Promise<Source | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(sources).where(where(accountId, id));
  return row ?? null;
}

export async function listSections(db: Db, accountId: string, sourceId: string) {
  if (!isUuid(sourceId)) return [];
  return db.select().from(sourceSections)
    .where(and(eq(sourceSections.accountId, accountId), eq(sourceSections.sourceId, sourceId)))
    .orderBy(asc(sourceSections.position));
}

/** Facts found in this source (P8.4 fills them). */
export async function listSourceFacts(db: Db, accountId: string, sourceId: string) {
  if (!isUuid(sourceId)) return [];
  return db.select().from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.sourceId, sourceId)))
    .orderBy(asc(knowledgeFacts.topic), asc(knowledgeFacts.createdAt));
}

/** Setup step "Sources" is done once one source is ready. */
export async function hasReadySource(db: Db, accountId: string): Promise<boolean> {
  const [row] = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.accountId, accountId), eq(sources.status, "ready"))).limit(1);
  return !!row;
}

const cleanTitle = (s: string, fallback: string) => s.replace(/\s+/g, " ").trim().slice(0, 200) || fallback;

async function insertSource(
  db: Db, actor: Actor, accountId: string,
  v: { kind: SourceKind; title: string; origin: SourceOrigin; language?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sources).values({
    id, accountId, kind: v.kind, title: v.title, origin: v.origin, language: v.language ?? null,
    status: "processing", createdByUserId: actor.userId,
  });
  return id;
}

/**
 * Stores a parse result: caps the text, replaces the sections, and sets
 * status, problems, stats and language, all in one transaction. When the
 * text is unchanged (re-read), sections and text_hash are kept.
 */
export async function saveParse(
  db: Db, accountId: string, sourceId: string, result: ParseResult,
  opts: { language?: string | null; extraStats?: Partial<SourceStats> } = {},
): Promise<Source | null> {
  const current = await getSource(db, accountId, sourceId);
  if (!current) return null;
  const { sections, problem } = capSections(result.sections);
  const problems: SourceProblem[] = [...result.problems, ...(problem ? [problem] : [])].slice(0, 50);
  const text = joinSections(sections);
  const status = statusFor({ sections, problems: problem ? [...result.problems, problem] : result.problems, needsInput: result.needsInput });
  const stats: SourceStats = { ...result.stats, ...opts.extraStats, chars: text.length, sections: sections.length };
  const language = opts.language !== undefined ? opts.language : guessLanguage(text);
  const unchanged = current.extractedText !== "" && sha256(current.extractedText) === sha256(text);
  await atomic(db, (q) => [
    ...(unchanged ? [] : [
      q.delete(sourceSections).where(and(eq(sourceSections.accountId, accountId), eq(sourceSections.sourceId, sourceId))),
      ...(sections.length
        ? [q.insert(sourceSections).values(sections.map((s, i) => ({
          id: crypto.randomUUID(), accountId, sourceId, position: i, locator: s.locator.slice(0, 120), heading: s.heading?.slice(0, 300) ?? null,
          text: s.text, tokenEstimate: estimateTokens(s.text),
        })))]
        : []),
    ]),
    q.update(sources).set({
      status, problems, stats, language: language ?? current.language,
      ...(unchanged ? {} : { extractedText: text, textHash: null }),
    }).where(where(accountId, sourceId)),
  ]);
  return getSource(db, accountId, sourceId);
}

async function markFailed(db: Db, accountId: string, sourceId: string, message: string) {
  await db.update(sources).set({
    status: "failed",
    problems: [{ where: "source", message, fix: "Try again, or upload the content as a file." }],
  }).where(where(accountId, sourceId));
}

// ---------------------------------------------------------------------------
// Notes ("Write a note")
// ---------------------------------------------------------------------------

export const NOTE_MAX = 20_000;

function noteSections(title: string, body: string): ParseResult {
  const text = body.replace(/\r\n?/g, "\n").trim();
  return { sections: text ? [{ locator: "note", heading: title, text }] : [], problems: [] };
}

function checkNote(title: string, body: string) {
  if (!title.trim()) throw new SourceInputError("Give the note a title.");
  if (!body.trim()) throw new SourceInputError("Write the note text.");
  if (body.length > NOTE_MAX) throw new SourceInputError("A note can be up to 20,000 characters. Upload longer text as a file.");
}

export async function addNote(db: Db, actor: Actor, accountId: string, input: { title: string; body: string }): Promise<Source> {
  checkNote(input.title, input.body);
  const title = cleanTitle(input.title, "Note");
  const id = await insertSource(db, actor, accountId, { kind: "text", title, origin: {} });
  return (await saveParse(db, accountId, id, noteSections(title, input.body)))!;
}

/** Replaces a note's text; it needs analysis again (text_hash cleared). Null when not this account's note. */
export async function updateNote(db: Db, accountId: string, id: string, input: { title: string; body: string }): Promise<Source | null> {
  const current = await getSource(db, accountId, id);
  if (!current || current.kind !== "text") return null;
  checkNote(input.title, input.body);
  const title = cleanTitle(input.title, current.title);
  // Any edit needs analysis again, even when only the title changed.
  await db.update(sources).set({ title, textHash: null }).where(where(accountId, id));
  return saveParse(db, accountId, id, noteSections(title, input.body));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type UploadedFile = { name: string; type: string; bytes: Uint8Array };

/** Reads one uploaded file into a new source. The bytes are not kept: only name, type and size. */
export async function addFile(db: Db, actor: Actor, accountId: string, file: UploadedFile): Promise<Source> {
  const name = cleanTitle(file.name.split(/[\\/]/).pop() ?? "", "File");
  const kind = fileKind(name, file.bytes);
  const id = await insertSource(db, actor, accountId, {
    kind: "file", title: name, origin: { fileName: name, mime: file.type.slice(0, 100) || kind, size: file.bytes.byteLength },
  });
  try {
    const result = await parseFile(kind, file.bytes, name);
    return (await saveParse(db, accountId, id, result))!;
  } catch {
    await markFailed(db, accountId, id, "We could not read this file.");
    return (await getSource(db, accountId, id))!;
  }
}

// ---------------------------------------------------------------------------
// Calls (transcripts only; audio comes later)
// ---------------------------------------------------------------------------

export type CallInput = {
  title: string;
  rep?: string;
  callDate?: string;
  consent: boolean;
  /** Pasted transcript. */
  text?: string;
  /** Or an uploaded transcript file (.txt, .vtt, .srt, .docx). */
  file?: UploadedFile;
};

const TRANSCRIPT_EXT = /\.(txt|vtt|srt|docx)$/i;

export async function addCall(db: Db, actor: Actor, accountId: string, input: CallInput, now = new Date()): Promise<Source> {
  if (!input.consent) throw new SourceInputError("Confirm that you may use this recording or transcript.");
  let raw = input.text?.trim() ?? "";
  let fileMeta: Pick<SourceOrigin, "fileName" | "mime" | "size"> = {};
  if (input.file && input.file.bytes.byteLength > 0) {
    const name = input.file.name.split(/[\\/]/).pop() ?? "transcript";
    if (!TRANSCRIPT_EXT.test(name)) throw new SourceInputError(`${name}: upload a transcript as TXT, VTT, SRT or DOCX. Audio recordings are coming soon.`);
    if (input.file.bytes.byteLength > 10 * 1024 * 1024) throw new SourceInputError(`${name}: the file is larger than 10 MB.`);
    if (/\.docx$/i.test(name)) {
      try {
        raw = htmlToText(await docxToHtml(input.file.bytes)).text;
      } catch {
        throw new SourceInputError(`${name}: we could not open this Word file.`);
      }
    } else raw = new TextDecoder().decode(input.file.bytes);
    fileMeta = { fileName: name.slice(0, 200), mime: input.file.type.slice(0, 100), size: input.file.bytes.byteLength };
  }
  if (!raw.trim()) throw new SourceInputError("Paste the transcript or upload a transcript file.");
  const date = input.callDate && /^\d{4}-\d{2}-\d{2}$/.test(input.callDate) ? input.callDate : undefined;
  const origin: SourceOrigin = {
    ...fileMeta,
    rep: input.rep?.trim().slice(0, 100) || undefined,
    callDate: date,
    consentConfirmed: true,
    consentConfirmedAt: now.toISOString(),
  };
  const title = cleanTitle(input.title, fileMeta.fileName ?? `Call ${date ?? now.toISOString().slice(0, 10)}`);
  const id = await insertSource(db, actor, accountId, { kind: "call", title, origin });
  const result = parseTranscript(raw);
  if (result.stats?.durationSec) {
    await db.update(sources).set({ origin: { ...origin, durationSec: result.stats.durationSec } }).where(where(accountId, id));
  }
  return (await saveParse(db, accountId, id, result))!;
}

// ---------------------------------------------------------------------------
// Websites
// ---------------------------------------------------------------------------

/** Creates the website source (status processing). Call `readWebsite` next, e.g. in `after()`. */
export async function addWebsite(db: Db, actor: Actor, accountId: string, input: { url: string; paths: string[] }): Promise<Source> {
  const url = parsePublicUrl(input.url);
  const allowedPaths = normalizePaths(input.paths);
  const id = await insertSource(db, actor, accountId, { kind: "website", title: url.host, origin: { url: url.toString(), allowedPaths } });
  return (await getSource(db, accountId, id))!;
}

/** Crawls a website source and stores the result. Never throws: failures become the source's problems. */
export async function readWebsite(
  db: Db, accountId: string, id: string, deps: Pick<CrawlOptions, "fetchImpl" | "lookup" | "limits" | "now"> = {},
): Promise<Source | null> {
  const src = await getSource(db, accountId, id);
  if (!src || src.kind !== "website" || !src.origin.url) return null;
  try {
    const result = await crawlWebsite({ url: src.origin.url, allowedPaths: src.origin.allowedPaths ?? [], ...deps });
    // The letters decide; the page's lang attribute is the fallback.
    const declared = result.lang?.split("-")[0] ?? null;
    return await saveParse(db, accountId, id, result, { language: guessLanguage(joinSections(result.sections)) ?? declared });
  } catch (e) {
    await markFailed(db, accountId, id, e instanceof UnsafeUrlError ? e.message : "We could not read this website.");
    return getSource(db, accountId, id);
  }
}

/** Marks a website for a new read; returns false when it is not this account's website. */
export async function markWebsiteForReread(db: Db, accountId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.update(sources).set({ status: "processing" })
    .where(and(where(accountId, id), eq(sources.kind, "website"))).returning({ id: sources.id });
  return rows.length > 0;
}

/** Deletes a source and its sections; facts found in it keep their text but lose the link. */
export async function deleteSource(db: Db, accountId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.delete(sources).where(where(accountId, id)).returning({ id: sources.id });
  return rows.length > 0;
}

/** Sources stuck in processing (e.g. the function stopped) for longer than this are shown as failed on read. */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/** Marks this account's sources that have been processing too long as failed. Returns how many. */
export async function failStaleSources(db: Db, accountId: string, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STALE_PROCESSING_MS);
  const rows = await db.update(sources).set({
    status: "failed",
    problems: [{ where: "source", message: "Reading this source stopped before it finished.", fix: "Re-read it, or upload the content again." }],
  }).where(and(eq(sources.accountId, accountId), eq(sources.status, "processing"), sql`${sources.updatedAt} < ${before.toISOString()}::timestamptz`))
    .returning({ id: sources.id });
  return rows.length;
}
