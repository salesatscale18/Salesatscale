/**
 * The time the buyer asked for ("write to me / talk to me at X", reach spec
 * 3 and 7; boards ReachSms and ReachChat):
 *
 * - At X the scheduler writes the follow-up into the web chat and sends the
 *   named_time SMS with the chat link (lib/follow-ups/scheduler.ts), at any hour.
 * - `runNamedTimeRetries` (the same cron, every minute): 10 minutes later, if
 *   the chat was not opened (any open of /c/ counts) and the buyer did not
 *   write, one named_time_retry SMS ("Still a good time? Talk, write or pick a
 *   new time"). At most 2 SMS per named time. Both are service messages the
 *   buyer asked for: not behind SMS_AGENT_NUDGES.
 * - `talkNowFor`: opened from that SMS within 2 hours of X, the buyer page
 *   shows the talk-now card (after the first SMS) or the new-time card (after
 *   the second).
 * - `rescheduleFromChat`: the new-time card's "Message me …" moves the
 *   buyer-named follow-up (schedule_follow_up with buyer_named_time true).
 */
import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, followUps, leadEvents, leads, messages, type Lead, type SellerAccount } from "@/db/schema";
import { CHAT_OPENED_EVENT } from "@/lib/agent/thread-markers";
import { rateLimit } from "@/lib/security/rate-limit";
import { WEB_CHAT_CHANNELS } from "@/lib/simulator/rules";
import { SMS_EVENTS, SMS_NUDGE_EVENTS } from "@/lib/sms/rules";
import { nudgeBuyer, type NudgeDeps } from "@/lib/sms/service";
import { scheduleFollowUp } from "./schedule";

const MINUTE = 60_000;
/** The second SMS goes this long after the first… */
export const NAMED_TIME_RETRY_MS = 10 * MINUTE;
/** …and not at all when the cron finds it later than this (the moment has passed). */
export const NAMED_TIME_RETRY_LATEST_MS = 30 * MINUTE;
/** The talk-now and new-time cards show for this long after the named time. */
export const TALK_NOW_WINDOW_MS = 2 * 60 * MINUTE;

export type RetrySummary = { checked: number; sent: number; skipped: number };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Sends the second named-time SMS where it is due, across accounts (each row
 * scoped by its own account). A claim per first SMS (one per day window)
 * keeps two cron runs from sending it twice.
 */
export async function runNamedTimeRetries(db: Db, now = new Date(), deps: NudgeDeps = {}): Promise<RetrySummary> {
  const summary: RetrySummary = { checked: 0, sent: 0, skipped: 0 };
  const firsts = await db.select({ id: leadEvents.id, accountId: leadEvents.accountId, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data })
    .from(leadEvents)
    .where(and(
      inArray(leadEvents.type, [...SMS_NUDGE_EVENTS]), sql`${leadEvents.data}->>'kind' = 'named_time'`,
      lte(leadEvents.createdAt, new Date(now.getTime() - NAMED_TIME_RETRY_MS)), gt(leadEvents.createdAt, new Date(now.getTime() - NAMED_TIME_RETRY_LATEST_MS)),
    ))
    .limit(200);
  for (const e of firsts) {
    summary.checked++;
    const messageId = str(e.data?.messageId);
    const scope = and(eq(leadEvents.accountId, e.accountId), eq(leadEvents.leadId, e.leadId), gt(leadEvents.createdAt, e.createdAt));
    // The open is stamped by the app server, the SMS by the database: a minute's margin for clock skew
    // (a buyer who opened the chat a moment before the time is in it anyway).
    const since = new Date(e.createdAt.getTime() - MINUTE);
    const [[retried], [opened], [wrote]] = await Promise.all([
      // Already tried (sent, mocked, refused or failed): never a third SMS.
      db.select({ id: leadEvents.id }).from(leadEvents)
        .where(and(scope, inArray(leadEvents.type, [SMS_EVENTS.sent, SMS_EVENTS.mocked, SMS_EVENTS.refused, SMS_EVENTS.failed]), sql`${leadEvents.data}->>'kind' = 'named_time_retry'`)).limit(1),
      // Any open of /c/ since the first SMS counts.
      db.select({ id: leadEvents.id }).from(leadEvents)
        .where(and(eq(leadEvents.accountId, e.accountId), eq(leadEvents.leadId, e.leadId), gt(leadEvents.createdAt, since), eq(leadEvents.type, CHAT_OPENED_EVENT))).limit(1),
      db.select({ id: messages.id }).from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(messages.accountId, e.accountId), eq(conversations.accountId, e.accountId), eq(conversations.leadId, e.leadId),
          eq(messages.actor, "buyer"), gt(messages.createdAt, since),
        )).limit(1),
    ]);
    if (retried || opened || wrote) { summary.skipped++; continue; }
    if (!(await rateLimit(db, `named-retry:${e.id}`, { limit: 1, windowSeconds: 86_400 }, now)).ok) { summary.skipped++; continue; }
    const r = await nudgeBuyer(db, { userId: null, actingAs: false }, { accountId: e.accountId, leadId: e.leadId, kind: "named_time_retry", messageId, now }, deps);
    if (r.outcome === "sent" || r.outcome === "mocked") summary.sent++;
    else summary.skipped++;
  }
  return summary;
}

export type TalkNow = { kind: "talk_now" | "new_time"; at: string };

/**
 * The card the buyer page shows when the chat was opened from an SMS: the
 * latest SMS to the lead decides. The named-time SMS within 2 hours of the
 * time: the talk-now card ("{Day} {HH:MM} your time · the time you asked
 * for"); the second one (or the missed team call's): the new-time card.
 */
export async function talkNowFor(db: Db, ctx: { lead: Pick<Lead, "id">; account: Pick<SellerAccount, "id"> }, now = new Date()): Promise<TalkNow | null> {
  const [last] = await db.select({ createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, ctx.account.id), eq(leadEvents.leadId, ctx.lead.id), inArray(leadEvents.type, [...SMS_NUDGE_EVENTS]),
      gte(leadEvents.createdAt, new Date(now.getTime() - TALK_NOW_WINDOW_MS))))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  const kind = last?.data?.kind;
  if (kind !== "named_time" && kind !== "named_time_retry") return null;
  // The time the buyer asked for: the follow-up that wrote the message this SMS points to.
  const messageId = str(last.data?.messageId);
  const [f] = messageId
    ? await db.select({ dueAt: followUps.dueAt }).from(followUps)
      .where(and(eq(followUps.accountId, ctx.account.id), eq(followUps.leadId, ctx.lead.id), eq(followUps.sentMessageId, messageId))).limit(1)
    : [];
  const at = f?.dueAt ?? last.createdAt;
  if (now.getTime() - at.getTime() > TALK_NOW_WINDOW_MS) return null;
  return { kind: kind === "named_time" ? "talk_now" : "new_time", at: at.toISOString() };
}

export type RescheduleResult =
  | { ok: true; at: string }
  | { ok: false; reason: "invalid_time" | "too_soon" | "too_far" | "no_chat" | "not_open" | "opted_out" | "refused" };

/**
 * The new-time card: the buyer picks when to be messaged (any hour). It moves
 * the buyer-named follow-up (one per lead: a new one replaces the scheduled
 * one) with its topic, through schedule_follow_up's own checks.
 */
export async function rescheduleFromChat(db: Db, ctx: { lead: Pick<Lead, "id">; account: Pick<SellerAccount, "id"> }, raw: unknown, now = new Date()): Promise<RescheduleResult> {
  const at = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_time" };
  const [lead] = await db.select({ status: leads.status, language: leads.language }).from(leads).where(and(eq(leads.id, ctx.lead.id), eq(leads.accountId, ctx.account.id)));
  if (!lead || lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  const [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, ctx.account.id), eq(conversations.leadId, ctx.lead.id), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  if (!conv) return { ok: false, reason: "no_chat" };
  if (conv.status !== "open") return { ok: false, reason: "not_open" };
  const [prev] = await db.select({ topic: followUps.topic }).from(followUps)
    .where(and(eq(followUps.accountId, ctx.account.id), eq(followUps.leadId, ctx.lead.id))).orderBy(desc(followUps.createdAt)).limit(1);
  const r = await scheduleFollowUp(
    db, { accountId: ctx.account.id, leadId: ctx.lead.id, conversationId: conv.id, language: conv.language ?? lead.language },
    { due_at: at.toISOString(), topic: prev?.topic ?? "", buyer_named_time: true }, now,
  );
  if (r.ok) return { ok: true, at: r.followUp.dueAt.toISOString() };
  return { ok: false, reason: r.rule.includes("15 minutes") ? "too_soon" : r.rule.includes("30 days") ? "too_far" : r.rule.includes("paused") ? "not_open" : "refused" };
}
