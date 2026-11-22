/**
 * The original uploaded file of a source, kept in Vercel Blob (private
 * access), so a slide-deck PDF can later be read as pages (lib/pipeline/
 * documents.ts). The source's `origin` jsonb holds only a small reference
 * `{ blobPath, size, contentType }` under `origin.file`, never the bytes.
 *
 * - No BLOB_READ_WRITE_TOKEN: no store, everything works as before (text only).
 * - Paths start with the environment ("production/" or "development/").
 * - Preview (VERCEL_ENV=preview) never writes: it shares the production
 *   database, so a Preview upload would leave production rows pointing at
 *   Preview files. Reads and deletes still work there (a source deleted on
 *   Preview is gone from production too, so its file goes with it).
 * - A store error never fails an upload or a delete: the text is what counts.
 */
import { del, get, put } from "@vercel/blob";
import type { SourceOrigin } from "@/db/schema";

/** Where a source's original file is kept. */
export type StoredFile = { blobPath: string; size: number; contentType: string };
/** A source's origin with its stored file (no schema change: `origin` is jsonb). */
export type OriginWithFile = SourceOrigin & { file?: StoredFile };

export interface FileStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The file's bytes, or null when it is not there. */
  get(path: string): Promise<Uint8Array | null>;
  del(path: string): Promise<void>;
}

type Env = Record<string, string | undefined>;

/** The Vercel Blob store, or null when BLOB_READ_WRITE_TOKEN is not set. */
export function fileStore(env: Env = process.env): FileStore | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return {
    async put(path, bytes, contentType) {
      await put(path, Buffer.from(bytes), { access: "private", contentType, token, addRandomSuffix: false, allowOverwrite: true });
    },
    async get(path) {
      const r = await get(path, { access: "private", token, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return new Uint8Array(await new Response(r.stream).arrayBuffer());
    },
    async del(path) {
      await del(path, { token });
    },
  };
}

/** The first part of every path: "production" or "development"; null on Preview (no writes). */
export function blobEnvironment(env: Env = process.env): "production" | "development" | null {
  if (env.VERCEL_ENV === "preview") return null;
  return env.VERCEL_ENV === "production" ? "production" : "development";
}

/** A file name safe for a path: letters, digits, dot, dash and underscore. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-100) || "file";
}

/** The blob path of a source's file. */
export function sourceFilePath(envName: string, accountId: string, sourceId: string, fileName: string): string {
  return `sources/${envName}/${accountId}/${sourceId}/${safeFileName(fileName)}`;
}

/** Keeps a source's file. Null when there is no store, on Preview, or when the store fails. */
export async function storeSourceFile(
  store: FileStore | null, accountId: string, sourceId: string, file: { name: string; contentType: string; bytes: Uint8Array }, env: Env = process.env,
): Promise<StoredFile | null> {
  const envName = blobEnvironment(env);
  if (!store || !envName) return null;
  const blobPath = sourceFilePath(envName, accountId, sourceId, file.name);
  try {
    await store.put(blobPath, file.bytes, file.contentType);
    return { blobPath, size: file.bytes.byteLength, contentType: file.contentType };
  } catch (e) {
    console.error("[sources] could not keep the file", { sourceId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Removes a source's file; errors are logged, never thrown. */
export async function deleteSourceFile(store: FileStore | null, file: StoredFile | undefined | null): Promise<boolean> {
  if (!store || !file?.blobPath) return false;
  try {
    await store.del(file.blobPath);
    return true;
  } catch (e) {
    console.error("[sources] could not delete the file", { blobPath: file.blobPath, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** The stored file of a source's origin, if any. */
export function storedFileOf(origin: SourceOrigin | null | undefined): StoredFile | null {
  const f = (origin as OriginWithFile | null | undefined)?.file;
  return f && typeof f.blobPath === "string" && f.blobPath ? f : null;
}
