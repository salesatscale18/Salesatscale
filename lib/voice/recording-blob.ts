/**
 * Call recordings in Vercel Blob (lib/voice/recording.ts RecordingStore), private, kept RECORDING_TTL_DAYS.
 *
 * NOT ACTIVE YET: `@vercel/blob` is not a dependency of this repository (package.json is a claimed area). The
 * package is loaded with a runtime import guarded by BLOB_READ_WRITE_TOKEN; when it cannot be loaded,
 * blobRecordingStore returns null and calls are not recorded (the session row says "off"). Once the dependency
 * lands, replace the runtime import with a static `import { put, list, del } from "@vercel/blob"`.
 * Written against @vercel/blob's documented put / list / del; to verify against 2.8.2 once installed: the
 * `access: "private"` option, the 90-day expiry option name, and reading a private blob with the token.
 * Server-only. Never logs or stores a URL with a token.
 */
import type { RecordingChunkInfo, RecordingStore } from "./recording";

type BlobItem = { pathname: string; size: number; url: string; downloadUrl?: string };
type BlobModule = {
  put(pathname: string, body: Uint8Array | Buffer, opts: Record<string, unknown>): Promise<{ url: string }>;
  list(opts: Record<string, unknown>): Promise<{ blobs: BlobItem[]; cursor?: string; hasMore?: boolean }>;
  del(urls: string | string[], opts: Record<string, unknown>): Promise<void>;
};

const MODULE = "@vercel/blob";

async function loadBlob(): Promise<BlobModule | null> {
  try {
    return (await import(/* webpackIgnore: true */ MODULE)) as BlobModule;
  } catch {
    return null;
  }
}

/** The Blob store, or null when @vercel/blob cannot be loaded. */
export async function blobRecordingStore(token: string): Promise<RecordingStore | null> {
  const blob = await loadBlob();
  if (!blob) return null;
  const listAll = async (prefix: string): Promise<BlobItem[]> => {
    const out: BlobItem[] = [];
    let cursor: string | undefined;
    do {
      const r = await blob.list({ prefix, token, cursor, limit: 1000 });
      out.push(...r.blobs);
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
  };
  return {
    kind: "blob",
    async put(path, bytes, opts) {
      await blob.put(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: "private", token, addRandomSuffix: false, allowOverwrite: true, contentType: "application/octet-stream",
        // The account's keep period, then deleted by the store; none: kept until deleted (option name to verify).
        ...(opts?.ttlDays ? { ttlDays: opts.ttlDays } : {}),
      });
    },
    async list(prefix): Promise<RecordingChunkInfo[]> {
      return (await listAll(prefix)).map((b) => ({ path: b.pathname, size: b.size }));
    },
    async read(path, start, end) {
      const [item] = (await listAll(path)).filter((b) => b.pathname === path);
      if (!item) throw new Error("recording chunk not found");
      const res = await fetch(item.downloadUrl ?? item.url, { headers: { authorization: `Bearer ${token}`, range: `bytes=${start}-${end - 1}` } });
      if (!res.ok) throw new Error(`recording chunk read failed: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range answers 200 with the whole chunk.
      return res.status === 206 ? buf : buf.slice(start, end);
    },
    async deleteAll(prefix) {
      const items = await listAll(prefix);
      if (items.length) await blob.del(items.map((b) => b.url), { token });
    },
  };
}
