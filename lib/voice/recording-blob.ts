/**
 * Call recordings in Vercel Blob (lib/voice/recording.ts RecordingStore), with the same client setup and
 * conventions as the sources' files (lib/sources/blob.ts): private access, BLOB_READ_WRITE_TOKEN (no store when it
 * is unset), no random suffix, paths `voice/<production|development>/<accountId>/<sessionId>/<chunk>`; Preview
 * never writes (recordingStoreFor refuses it before a store is made).
 *
 * @vercel/blob 2.8.2 has no per-blob expiry, so the keep period is ours: the cron deletes the chunks of calls past
 * their period (lib/voice/recording-playback.ts expireRecordings). Reads are ranges of a chunk (seeking in the
 * player). Server-only. Never logs or stores a URL or a token.
 */
import { del, get, list, put } from "@vercel/blob";
import type { RecordingChunkInfo, RecordingStore } from "./recording";

type Env = Record<string, string | undefined>;

/** The Blob store for recordings, or null when BLOB_READ_WRITE_TOKEN is not set (as lib/sources/blob.ts fileStore). */
export function blobRecordingStore(env: Env = process.env): RecordingStore | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const listAll = async (prefix: string) => {
    const out: { pathname: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, token, cursor, limit: 1000 });
      out.push(...r.blobs.map((b) => ({ pathname: b.pathname, size: b.size })));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
  };
  return {
    kind: "blob",
    async put(path, bytes) {
      await put(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: "private", contentType: "application/octet-stream", token, addRandomSuffix: false, allowOverwrite: true,
      });
    },
    async list(prefix): Promise<RecordingChunkInfo[]> {
      return (await listAll(prefix)).map((b) => ({ path: b.pathname, size: b.size }));
    },
    async read(path, start, end) {
      const r = await get(path, { access: "private", token, useCache: false, headers: { range: `bytes=${start}-${end - 1}` } });
      if (!r || !r.stream) throw new Error("recording chunk not found");
      const buf = new Uint8Array(await new Response(r.stream).arrayBuffer());
      // A store that answers the whole chunk (no range support): the slice asked for.
      return buf.byteLength > end - start ? buf.slice(start, end) : buf;
    },
    async deleteAll(prefix) {
      const items = await listAll(prefix);
      if (items.length) await del(items.map((b) => b.pathname), { token });
    },
  };
}
