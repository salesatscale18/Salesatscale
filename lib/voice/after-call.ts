/**
 * The buyer's last turn on a call, answered in the chat (live voice, release 2).
 *
 * A buyer call can end while the buyer's last line is unanswered: they spoke
 * or typed and the call ended (hang-up, time limit, silence, a dropped
 * connection, an error) before the agent said anything. The agent then
 * answers it in the chat right after the call, with the normal chat turn for
 * that already-stored message (replyToBuyer → runBuyerTurn with
 * buyerMessageStored, all its gates), so the reply is an ordinary chat message
 * after the "Voice call" summary row.
 *
 * Three paths can trigger it, and each is safe to run more than once:
 * - the voice socket, right after the call is stored, when its function has time left;
 * - the buyer page's next poll (`/chat/<token>/messages`), when the socket's function did not;
 * - the platform cron (`/api/cron/follow-ups`), when the buyer closed the page (not for a call closed as stale).
 * The durable marker is the conversation itself (its last message is the call's
 * buyer line); a conditional update on the session (`settings._afterCall`)
 * claims the reply, so it is produced at most once. A buyer chat message sent
 * after the call takes the turn instead (the call line is then no longer the last).
 *
 * Test-lab calls never get one: the seller starts a new call or chat there.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, messages, voiceSessions, type VoiceEndReason, type VoiceSession } from "@/db/schema";
import type { LlmClient } from "@/lib/agent/llm";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { activeCallOn } from "./one-agent";
import { voiceLine } from "./log";

/**
 * Endings that leave the conversation open and with the agent. Not: opt_out, handoff, take_over, budget, agent_closed.
 * `idle` (ended on standby): the agent spoke last before standby, so there is normally nothing to answer; it is
 * listed so a buyer line the model never answered before standby still gets its reply.
 */
export const AFTER_CALL_REASONS: ReadonlySet<VoiceEndReason> = new Set(["user_hangup", "limit", "silence", "idle", "connection_lost", "error"]);
/** The cron answers calls that ended at most this long ago. */
export const AFTER_CALL_MAX_AGE_MS = 24 * 3_600_000;
/** The socket's function answers right away only with at least this much time left; otherwise a poll or the cron does. */
export const AFTER_CALL_MIN_SEC = 60;

const CLAIM_KEY = "_afterCall";

export type AfterCallTurn = { session: VoiceSession; messageId: string; body: string; leadId: string };

/**
 * The call's unanswered buyer turn, or null: a buyer call (not a test) that
 * ended for a reason that leaves the conversation with the agent, on an open
 * conversation whose last buyer, agent or person message is the buyer's line
 * from this call. `claimed`: whether a path already took it.
 */
export async function unansweredCallTurn(db: Db, session: VoiceSession): Promise<(AfterCallTurn & { claimed: boolean }) | null> {
  if (session.isTest || session.status !== "ended" || !session.endReason || !AFTER_CALL_REASONS.has(session.endReason)) return null;
  const [[conv], [last]] = await Promise.all([
    db.select({ status: conversations.status, leadId: conversations.leadId }).from(conversations)
      .where(and(eq(conversations.id, session.conversationId), eq(conversations.accountId, session.accountId))),
    db.select({ id: messages.id, actor: messages.actor, body: messages.body, voiceSessionId: messages.voiceSessionId }).from(messages)
      .where(and(eq(messages.accountId, session.accountId), eq(messages.conversationId, session.conversationId), inArray(messages.actor, ["buyer", "agent", "human"])))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1),
  ]);
  if (!conv || conv.status !== "open" || !last || last.actor !== "buyer" || last.voiceSessionId !== session.id) return null;
  const claimed = !!(session.settings as Record<string, unknown> | null)?.[CLAIM_KEY];
  return { session, messageId: last.id, body: last.body, leadId: conv.leadId, claimed };
}

/** The conversation's latest call when its last buyer turn waits for the after-call reply (claimed or not), else null. */
export async function pendingAfterCall(db: Db, accountId: string, conversationId: string): Promise<(AfterCallTurn & { claimed: boolean }) | null> {
  const [s] = await db.select().from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId), eq(voiceSessions.isTest, false)))
    .orderBy(desc(voiceSessions.createdAt)).limit(1);
  return s ? unansweredCallTurn(db, s) : null;
}

/** Takes the after-call reply for one session, once (a conditional update). */
async function claim(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db.update(voiceSessions)
    .set({ settings: sql`coalesce(${voiceSessions.settings}, '{}'::jsonb) || jsonb_build_object(${CLAIM_KEY}::text, 'claimed'::text)` })
    .where(and(eq(voiceSessions.id, sessionId), sql`coalesce(${voiceSessions.settings}->>${CLAIM_KEY}, '') = ''`))
    .returning({ id: voiceSessions.id });
  return rows.length > 0;
}

/** Gives a claim back (a call took the conversation first): a later poll or the cron may answer the line. */
async function release(db: Db, sessionId: string): Promise<void> {
  await db.update(voiceSessions).set({ settings: sql`coalesce(${voiceSessions.settings}, '{}'::jsonb) - ${CLAIM_KEY}::text` })
    .where(eq(voiceSessions.id, sessionId));
}

export type AfterCallResult = { status: "replied" | "no_reply" | "skipped"; reason?: string };

/**
 * Answers the call's unanswered buyer turn in the chat, at most once. The chat
 * turn keeps every gate of a normal chat reply (a person holding the chat, a
 * paused account, an opted-out lead, the platform AI budget). Never throws.
 */
export async function replyAfterCall(db: Db, llm: LlmClient, sessionId: string): Promise<AfterCallResult> {
  try {
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, sessionId));
    if (!s) return { status: "skipped", reason: "not_found" };
    const turn = await unansweredCallTurn(db, s);
    if (!turn) return { status: "skipped", reason: "answered_or_not_eligible" };
    // One agent at a time. Claim first, then check for a call: a call created between a check and the claim would
    // otherwise leave the claim used and the line unanswered. A call holding the conversation (pending or live)
    // gives the claim back: its first line answers the buyer's line (lib/voice/instructions.ts answerLastInstruction);
    // if it does not, the line is still the last one and a later poll or the cron answers it.
    if (turn.claimed || !(await claim(db, s.id))) return { status: "skipped", reason: "claimed" };
    const active = await activeCallOn(db, s.accountId, s.conversationId);
    if (active) {
      await release(db, s.id);
      console.info(voiceLine(active, `text agent blocked: after-call reply of ${s.id.slice(0, 8)} (this call is pending or live)`));
      return { status: "skipped", reason: "call_active" };
    }
    const out = await replyToBuyer(db, llm, null, { accountId: s.accountId, conversationId: s.conversationId, leadId: turn.leadId, text: turn.body });
    // A call that started after the check: the chat turn stood down (in_call) and sent nothing; the claim goes back.
    if (out.turn.status === "in_call") {
      await release(db, s.id);
      return { status: "skipped", reason: "call_active" };
    }
    if (out.delivery && !out.delivery.delivered) console.warn(`[voice] after-call reply not delivered: ${out.delivery.reason}`);
    return out.turn.status === "replied" ? { status: "replied" } : { status: "no_reply", reason: out.turn.status };
  } catch (e) {
    console.error("[voice] after-call reply failed", e);
    return { status: "no_reply", reason: "error" };
  }
}

/**
 * The cron's sweep: buyer calls that ended in the last 24 hours with an
 * unanswered last turn nobody took yet (the buyer closed the page, and the
 * socket's function had no time left). At most `limit` per run.
 * Calls closed as stale (endDetail by "relay_gone": the function died, lib/voice/service.ts) are left out: the cron
 * spends no model call on them. The buyer page's next poll still answers such a turn when the buyer comes back.
 */
export async function runAfterCallReplies(db: Db, llm: LlmClient, now = new Date(), limit = 5): Promise<{ replied: number; checked: number }> {
  const recent = await db.select().from(voiceSessions)
    .where(and(
      eq(voiceSessions.isTest, false), eq(voiceSessions.status, "ended"), gt(voiceSessions.endedAt, new Date(now.getTime() - AFTER_CALL_MAX_AGE_MS)),
      inArray(voiceSessions.endReason, [...AFTER_CALL_REASONS]), isNull(sql`${voiceSessions.settings}->>${CLAIM_KEY}`),
      sql`coalesce(${voiceSessions.usage}->'endDetail'->>'by', '') <> 'relay_gone'`,
    ))
    .orderBy(desc(voiceSessions.endedAt)).limit(50);
  let replied = 0;
  let checked = 0;
  for (const s of recent) {
    if (checked >= limit) break;
    if (!(await unansweredCallTurn(db, s))) continue;
    checked++;
    if ((await replyAfterCall(db, llm, s.id)).status === "replied") replied++;
  }
  return { replied, checked };
}
