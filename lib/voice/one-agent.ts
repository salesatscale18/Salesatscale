/**
 * One agent at a time on a conversation (owner, 23 Nov 2026): the chat agent (lib/agent/turn.ts) and the call's
 * voice agent (lib/voice/engine.ts) share the conversation's messages, deal state, ask counters and stage, so only
 * one of them may act at a time, decided by state:
 * - while a call on the conversation is pending (fresh) or live, no chat turn starts from any trigger (typed message,
 *   test-lab composer, WhatsApp, the after-call reply): `activeCallOn` says so, and `textTurnBlocked` logs the skip;
 * - a call's start waits for a chat turn still answering a typed message (VoiceEngine waitForTextTurn).
 * The state is the voice session row itself (voice_sessions.status): no lock of its own, nothing to release.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { voiceSessions } from "@/db/schema";
import { STALE_PENDING_SEC } from "./service";
import { voiceLine } from "./log";

/**
 * The call holding the conversation now, or null: a live session, or a pending one created less than
 * STALE_PENDING_SEC ago (its socket is still connecting). Test-lab calls count too: the test-lab composer must not
 * answer next to a test call either.
 */
export async function activeCallOn(db: Db, accountId: string, conversationId: string, now = new Date()): Promise<string | null> {
  const rows = await db.select({ id: voiceSessions.id, status: voiceSessions.status, createdAt: voiceSessions.createdAt }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId), inArray(voiceSessions.status, ["pending", "live"])))
    .orderBy(desc(voiceSessions.createdAt));
  const active = rows.find((r) => r.status === "live" || r.createdAt.getTime() > now.getTime() - STALE_PENDING_SEC * 1000);
  return active?.id ?? null;
}

/**
 * For every chat-turn trigger: true (and one log line) when a call holds the conversation, so the trigger must not
 * start a chat turn now. `trigger`: a short name for the log ("typed message", "test lab", "whatsapp", …).
 */
export async function textTurnBlocked(db: Db, accountId: string, conversationId: string, trigger: string, now = new Date()): Promise<boolean> {
  const active = await activeCallOn(db, accountId, conversationId, now);
  if (!active) return false;
  console.info(voiceLine(active, `text agent blocked: ${trigger}`));
  return true;
}
