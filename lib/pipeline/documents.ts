/**
 * PDFs as pages: a PDF source whose original file is kept (lib/sources/blob.ts)
 * goes to stage 1 (facts) as an Anthropic document block too, next to its
 * extracted text, so slides, tables and charts are read as pages. Only small
 * files: at most DOCUMENT_MAX_PAGES pages and DOCUMENT_MAX_BYTES bytes. No
 * store (BLOB_READ_WRITE_TOKEN not set) or no kept file: text only, as before.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { sources, type SourceOrigin, type SourceStats } from "@/db/schema";
import { storedFileOf, type FileStore, type StoredFile } from "@/lib/sources/blob";
import type { PipelineDocument } from "./llm";

export const DOCUMENT_MAX_PAGES = 20;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Estimated input tokens per PDF page (its text and its image). */
export const DOCUMENT_PAGE_TOKENS = 2_500;

/** A source's PDF that stage 1 may read as pages. */
export type DocumentRef = { sourceId: string; title: string; file: StoredFile; pages: number };

/** The kept PDF of a source when it is within the limits, else null (pure). */
export function documentFile(row: { kind: string; origin: SourceOrigin | null; stats: SourceStats | null }): { file: StoredFile; pages: number } | null {
  if (row.kind !== "file") return null;
  const file = storedFileOf(row.origin);
  const pages = row.stats?.pages ?? 0;
  if (!file || file.contentType !== "application/pdf") return null;
  if (!(file.size > 0 && file.size <= DOCUMENT_MAX_BYTES)) return null;
  if (!(pages >= 1 && pages <= DOCUMENT_MAX_PAGES)) return null;
  return { file, pages };
}

/** The PDFs of these sources that stage 1 may read as pages (no bytes read). */
export async function documentRefs(db: Db, accountId: string, sourceIds: string[]): Promise<DocumentRef[]> {
  if (sourceIds.length === 0) return [];
  const rows = await db.select({ id: sources.id, kind: sources.kind, title: sources.title, origin: sources.origin, stats: sources.stats })
    .from(sources).where(and(eq(sources.accountId, accountId), inArray(sources.id, sourceIds)));
  const order = new Map(sourceIds.map((id, i) => [id, i]));
  return rows
    .flatMap((r) => {
      const d = documentFile(r);
      return d ? [{ sourceId: r.id, title: r.title, ...d }] : [];
    })
    .sort((a, b) => order.get(a.sourceId)! - order.get(b.sourceId)!);
}

/** Reads the PDFs from the store; a file that is missing, too large or fails to load is left out (text only). */
export async function loadDocuments(store: FileStore, refs: DocumentRef[]): Promise<PipelineDocument[]> {
  const out: PipelineDocument[] = [];
  for (const r of refs) {
    try {
      const bytes = await store.get(r.file.blobPath);
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > DOCUMENT_MAX_BYTES) continue;
      out.push({ sourceId: r.sourceId, title: r.title, base64: Buffer.from(bytes).toString("base64") });
    } catch (e) {
      console.error("[pipeline] could not read a kept file", { sourceId: r.sourceId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
