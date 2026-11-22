/**
 * Playing back a call recording (seller side): a WAV built on the fly from the stored chunks
 * (lib/voice/recording.ts), with HTTP Range so the browser can seek. Never a public or long-lived URL: the bytes
 * go through our route after its account check (app/app/[account]/calls/[sessionId]/recording/route.ts).
 * Server-only.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { voiceSessions } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { playbackStoreFor, wavHeader, type RecordingChunkInfo, type RecordingStore } from "./recording";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

/** Parses one `bytes=a-b` range over `size` bytes; null when absent or not satisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** The WAV response for these chunks: 200 for the whole file, 206 for a range, 416 for an impossible range. */
export function wavResponse(store: RecordingStore, chunks: RecordingChunkInfo[], range: string | null, download?: string): Response {
  const dataBytes = chunks.reduce((n, c) => n + c.size, 0);
  const header = wavHeader(dataBytes);
  const size = header.byteLength + dataBytes;
  const base = {
    "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    ...(download ? { "Content-Disposition": `attachment; filename="${download}"` } : {}),
  };
  const r = parseRange(range, size);
  if (r === "invalid") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  const start = r?.start ?? 0;
  const end = r?.end ?? size - 1;
  // The pieces that cover [start, end]: the header, then each chunk's slice.
  const pieces: (() => Promise<Uint8Array>)[] = [];
  if (start < header.byteLength) pieces.push(async () => header.slice(start, Math.min(end + 1, header.byteLength)));
  let at = header.byteLength;
  for (const c of chunks) {
    const from = Math.max(start, at);
    const to = Math.min(end + 1, at + c.size);
    if (from < to) {
      const offset = at;
      pieces.push(() => store.read(c.path, from - offset, to - offset));
    }
    at += c.size;
  }
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= pieces.length) return controller.close();
      try {
        controller.enqueue(await pieces[i++]());
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(body, {
    status: r ? 206 : 200,
    headers: { ...base, "Content-Length": String(end - start + 1), ...(r ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) },
  });
}

/**
 * The recording of one of this account's calls as a WAV, or 404: another account's call, a call with no saved
 * recording (off, failed, deleted, or still running with nothing stored), or no store to read it from here.
 * A saved recording whose chunks are gone (the store's keep period ran out) is marked deleted on the way.
 * `download`: served as an attachment ("call-2026-11-22-1a2b3c4d.wav"). The caller has checked the person's
 * access to `accountId`.
 */
export async function recordingResponse(
  db: Db, accountId: string, sessionId: string, range: string | null,
  opts: { store?: RecordingStore | null; env?: Record<string, string | undefined>; download?: boolean } = {},
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return NOT_FOUND();
  const [s] = await db.select({ mode: voiceSessions.mode, state: voiceSessions.recordingState, prefix: voiceSessions.recordingRef, at: voiceSessions.connectedAt })
    .from(voiceSessions).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.accountId, accountId)));
  if (!s || !s.prefix || (s.state !== "saved" && s.state !== "recording")) return NOT_FOUND();
  const store = opts.store !== undefined ? opts.store : await playbackStoreFor(s.mode, opts.env);
  if (!store) return NOT_FOUND();
  const chunks = await store.list(s.prefix).catch(() => null);
  if (!chunks?.length) {
    // Listed fine and empty: the store deleted it (its keep period). A failed list proves nothing.
    if (chunks && s.state === "saved") await markDeleted(db, accountId, sessionId);
    return NOT_FOUND();
  }
  const name = opts.download ? `call-${(s.at ?? new Date()).toISOString().slice(0, 10)}-${sessionId.slice(0, 8)}.wav` : undefined;
  return wavResponse(store, chunks, range, name);
}

async function markDeleted(db: Db, accountId: string, sessionId: string) {
  await db.update(voiceSessions).set({ recordingState: "deleted", recordingChunks: 0, recordingBytes: 0 })
    .where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.accountId, accountId)));
}

/**
 * "Delete recording…" (seller side): removes the call's audio from the store and marks it deleted; the call's
 * written lines stay. Audited. False when this account has no such recording. The caller checks access.
 */
export async function deleteRecording(
  db: Db, actor: Actor, accountId: string, sessionId: string,
  opts: { store?: RecordingStore | null; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  const [s] = await db.select({ mode: voiceSessions.mode, state: voiceSessions.recordingState, prefix: voiceSessions.recordingRef })
    .from(voiceSessions).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.accountId, accountId)));
  if (!s?.prefix || (s.state !== "saved" && s.state !== "failed")) return false;
  const store = opts.store !== undefined ? opts.store : await playbackStoreFor(s.mode, opts.env);
  if (store) await store.deleteAll(s.prefix);
  await markDeleted(db, accountId, sessionId);
  // Deleted by someone, not by the keep period: the call reads "Recording deleted" (no "kept N days").
  await db.update(voiceSessions).set({ recordingKeepDays: null }).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.accountId, accountId)));
  await writeAudit(db, actor, { accountId, action: "voice.recording_deleted", targetType: "voice_session", targetId: sessionId, details: {} });
  return true;
}

/**
 * The keep period ran out (the account's setting when the call was recorded): the store deletes the audio by
 * itself (its ttl); this marks the rows (the cron, once a minute: one update). Returns how many.
 */
export async function expireRecordings(db: Db, now = new Date()): Promise<number> {
  const rows = await db.update(voiceSessions).set({ recordingState: "deleted", recordingChunks: 0, recordingBytes: 0 })
    .where(and(
      eq(voiceSessions.recordingState, "saved"),
      // 0: kept until someone deletes it.
      sql`coalesce(${voiceSessions.recordingKeepDays}, 180) > 0`,
      sql`${voiceSessions.endedAt} + make_interval(days => coalesce(${voiceSessions.recordingKeepDays}, 180)) < ${now.toISOString()}::timestamptz`,
    ))
    .returning({ id: voiceSessions.id });
  return rows.length;
}
