/**
 * Agreed follow-ups (P11 follow-up, user decision 4): the agent's
 * schedule_follow_up tool, the reads for the agent's context and the lead
 * page, and the seller's Cancel. Every function is scoped by account. The
 * platform scheduler that sends them is lib/follow-ups/scheduler.ts.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { auditLog, conversations, followUps, leadEvents, leads, sellerAccounts, type FollowUp } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import type { AccountAccess } from "@/lib/accounts/service";
import { isWithinContactHours, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { cleanTopic, dueWindow, formatBuyerLocal, formatDueLocal, isoInZone, nearestAllowedTime, parseDueAt, type FollowUpReason } from "./rules";

// ---------------------------------------------------------------------------
// The agent's tool
// ---------------------------------------------------------------------------

export type ScheduleInput = { due_at: unknown; topic: unknown };
export type ScheduleContext = { accountId: string; leadId: string; conversationId: string; language: string };

export type ScheduleResult =
  /** dueLocal: the short form for seller views; dueForBuyer: the long form the agent tells the buyer ("Friday 20 November at 12:30"). */
  | { ok: true; followUp: FollowUp; dueLocal: string; dueForBuyer: string; replaced: boolean }
  | { ok: false; rule: string; extra: Record<string, unknown> };

/**
 * Schedules the follow-up the buyer agreed to. One per lead: a new one
 * replaces the scheduled one (cancelled with reason "replaced"). Refused for
 * an opted-out lead, a chat a person holds or that is closed, a paused
 * account, a time less than 15 minutes or more than 30 days ahead, and a time
 * outside contact hours (the result then offers the nearest allowed time).
 */
export async function scheduleFollowUp(db: Db, ctx: ScheduleContext, input: ScheduleInput, now = new Date()): Promise<ScheduleResult> {
  const [row] = await db.select({ lead: leads, conv: conversations, account: sellerAccounts }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, conversations.accountId))
    .where(and(
      eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId),
      eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId),
    ));
  if (!row) return { ok: false, rule: "Conversation not found", extra: {} };
  const { lead, conv, account } = row;
  // The lead's market decides the time zone and contact hours (its own, else the account's).
  const contact = await leadContactSettings(db, account, lead.marketId);
  const tz = contact.timezone;
  if (lead.status === "opted_out") return { ok: false, rule: "Lead opted out", extra: { message: "Do not schedule anything. The buyer does not want to be contacted." } };
  if (account.status === "paused") return { ok: false, rule: "The seller's account is paused", extra: { message: "Do not promise to come back. Say the team will be in touch." } };
  if (conv.status !== "open") return { ok: false, rule: "The agent is paused for this chat", extra: { message: "A person handles this chat now. Do not promise to come back yourself." } };

  const due = parseDueAt(input.due_at);
  if (!due) {
    return { ok: false, rule: "Invalid time", extra: { message: `Give due_at as an ISO date-time with the offset of ${tz}, e.g. ${isoInZone(now, tz)}.` } };
  }
  const window = dueWindow(due, now);
  if (window !== "ok") {
    return {
      ok: false, rule: window === "too_soon" ? "Time is less than 15 minutes ahead" : "Time is more than 30 days ahead",
      extra: { message: "Ask the buyer for a time between 15 minutes and 30 days from now." },
    };
  }
  if (!isWithinContactHours(contact.contactHours, tz, due)) {
    const nearest = nearestAllowedTime(contact.contactHours, tz, due, now);
    return {
      ok: false, rule: "Outside contact hours",
      extra: nearest
        ? {
            suggested_due_at: isoInZone(nearest, tz), suggested_local: formatBuyerLocal(nearest, tz), contact_hours: summarizeContactHours(contact.contactHours),
            message: `Not scheduled: you only write to buyers within contact hours. Offer the buyer ${formatBuyerLocal(nearest, tz)} instead (in their own wording); when they agree, call schedule_follow_up with suggested_due_at.`,
          }
        : { contact_hours: summarizeContactHours(contact.contactHours), message: "Not scheduled: ask the buyer for another time within contact hours." },
    };
  }

  const topic = cleanTopic(input.topic);
  const id = randomUUID();
  const dueLocal = formatDueLocal(due, tz);
  const [existing] = await db.select({ id: followUps.id }).from(followUps)
    .where(and(eq(followUps.accountId, ctx.accountId), eq(followUps.leadId, ctx.leadId), eq(followUps.status, "scheduled"))).limit(1);
  await atomic(db, (q) => [
    // One scheduled follow-up per lead: the new one replaces the old.
    q.update(followUps).set({ status: "cancelled", reason: "replaced" satisfies FollowUpReason })
      .where(and(eq(followUps.accountId, ctx.accountId), eq(followUps.leadId, ctx.leadId), eq(followUps.status, "scheduled"))),
    q.insert(followUps).values({
      id, accountId: ctx.accountId, leadId: ctx.leadId, conversationId: ctx.conversationId, dueAt: due, topic,
      // created_at from the database clock, like the buyer messages it is compared with (buyer_replied).
      language: ctx.language, status: "scheduled",
    }),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: "follow_up.scheduled", actor: "agent",
      data: { followUpId: id, dueAt: due.toISOString(), replaced: !!existing },
    }),
    q.insert(auditLog).values({
      accountId: ctx.accountId, actorUserId: null, action: "follow_up.scheduled", targetType: "follow_up", targetId: id,
      details: { leadId: ctx.leadId, dueAt: due.toISOString(), ...(existing ? { replaced: existing.id } : {}) },
    }),
  ]);
  const [followUp] = await db.select().from(followUps).where(and(eq(followUps.id, id), eq(followUps.accountId, ctx.accountId)));
  return { ok: true, followUp, dueLocal, dueForBuyer: formatBuyerLocal(due, tz), replaced: !!existing };
}

/** The deal's next step for a scheduled follow-up: "Follow up Tue 18 Nov 10:00: the second office". */
export const followUpNextStep = (dueLocal: string, topic: string | null) => `Follow up ${dueLocal}${topic ? `: ${topic}` : ""}`;

// ---------------------------------------------------------------------------
// Reads for the agent's context and the lead page
// ---------------------------------------------------------------------------

/** The lead's scheduled follow-up, if any. */
export async function scheduledFollowUp(db: Db, accountId: string, leadId: string): Promise<FollowUp | null> {
  const [f] = await db.select().from(followUps)
    .where(and(eq(followUps.accountId, accountId), eq(followUps.leadId, leadId), eq(followUps.status, "scheduled")))
    .orderBy(desc(followUps.createdAt)).limit(1);
  return f ?? null;
}

/** How long a failed follow-up stays on the lead page and in Needs you. */
export const FAILED_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** What the lead page shows: the scheduled follow-up, else the latest one that failed recently. */
export async function leadFollowUp(db: Db, accountId: string, leadId: string, now = new Date()): Promise<FollowUp | null> {
  const scheduled = await scheduledFollowUp(db, accountId, leadId);
  if (scheduled) return scheduled;
  const [latest] = await db.select().from(followUps)
    .where(and(eq(followUps.accountId, accountId), eq(followUps.leadId, leadId)))
    .orderBy(desc(followUps.updatedAt)).limit(1);
  return latest?.status === "failed" && now.getTime() - latest.updatedAt.getTime() < FAILED_SHOWN_MS ? latest : null;
}

// ---------------------------------------------------------------------------
// The seller cancels (or dismisses a failed one)
// ---------------------------------------------------------------------------

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;

/** Every member of a seller account is its admin today; a platform admin acting as one may cancel too. */
export const mayCancelFollowUps = (a: Pick<Access, "role">) => a.role === "seller_admin" || a.role === "platform_admin";

export type CancelResult = { ok: true; leadId: string } | { ok: false; reason: "forbidden" | "not_found" };

/** Cancels a scheduled follow-up, or dismisses a failed one. Account admins only; audited. */
export async function cancelFollowUp(db: Db, a: Access, followUpId: string): Promise<CancelResult> {
  if (!mayCancelFollowUps(a)) return { ok: false, reason: "forbidden" };
  const accountId = a.account.id;
  const [f] = await db.select().from(followUps).where(and(eq(followUps.id, followUpId), eq(followUps.accountId, accountId)));
  if (!f || (f.status !== "scheduled" && f.status !== "failed")) return { ok: false, reason: "not_found" };
  const reason: FollowUpReason = f.status === "scheduled" ? "cancelled_by_seller" : "dismissed_by_seller";
  const [changed] = await db.update(followUps).set({ status: "cancelled", reason })
    .where(and(eq(followUps.id, f.id), eq(followUps.accountId, accountId), eq(followUps.status, f.status))).returning({ id: followUps.id });
  if (!changed) return { ok: false, reason: "not_found" };
  const actor: Actor = { userId: a.user.id, actingAs: a.actingAs };
  await Promise.all([
    db.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: f.leadId, type: "follow_up.cancelled", actor: "human", actorUserId: a.user.id, data: { followUpId: f.id, reason },
    }),
    writeAudit(db, actor, { accountId, action: `follow_up.${reason === "cancelled_by_seller" ? "cancelled" : "dismissed"}`, targetType: "follow_up", targetId: f.id, details: { leadId: f.leadId } }),
  ]);
  return { ok: true, leadId: f.leadId };
}

/** A person takes over a chat: the lead's scheduled follow-ups are cancelled (statement for an atomic batch). */
export const cancelOnTakeOver = (q: Db, accountId: string, leadId: string) =>
  q.update(followUps).set({ status: "cancelled", reason: "taken_over" satisfies FollowUpReason })
    .where(and(eq(followUps.accountId, accountId), eq(followUps.leadId, leadId), eq(followUps.status, "scheduled")));

/** Failed follow-ups of the last FAILED_SHOWN_MS for the account's Needs you list (not test leads). */
export async function failedFollowUps(db: Db, accountId: string, now: Date) {
  return db.select({ followUp: followUps, leadName: leads.fullName, company: leads.company, marketId: leads.marketId }).from(followUps)
    .innerJoin(leads, eq(leads.id, followUps.leadId))
    .where(failedFollowUpWhere(accountId, now));
}

export const failedFollowUpWhere = (accountId: string, now: Date) => and(
  eq(followUps.accountId, accountId), eq(followUps.status, "failed"), gt(followUps.updatedAt, new Date(now.getTime() - FAILED_SHOWN_MS)),
  eq(leads.accountId, accountId), eq(leads.isTest, false), inArray(leads.status, ["new", "waiting_for_reply", "agent_handling", "human_handling", "meeting_booked"]),
);
