/**
 * Callback requests (O6): the agent's request_callback tool, the reads for the
 * agent's context, the lead page and Needs you, and the seller's Confirm and
 * Change time. Every function is scoped by account. The chat never pauses: the
 * conversation stays with the agent until the call. Rules and the stored
 * shape (lead events): lib/callbacks/rules.ts.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { auditLog, conversations, dealStates, leadEvents, leads, messages, sellerAccounts, toolCalls } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import type { AccountAccess } from "@/lib/accounts/service";
import { summarizeContactHours } from "@/lib/accounts/contact-hours";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { formatDueLocal, isoInZone, zonedInstant } from "@/lib/follow-ups/rules";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { defaultTransport, type TwilioTransport } from "@/lib/channels/twilio";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { isLocale, t } from "@/lib/i18n";
import {
  buyerCallTime, CALLBACK_EVENT_TYPES, CALLBACK_EVENTS, checkCallTime, cleanBrief, currentCallbackOf, currentCallbacks, parseCallTime,
  type CallbackRequest,
} from "./rules";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// The agent's tool
// ---------------------------------------------------------------------------

export type CallbackInput = { time: unknown; brief: unknown };
export type CallbackContext = { accountId: string; leadId: string; conversationId: string };

export type CallbackResult =
  | { ok: true; request: CallbackRequest; timeLocal: string; replaced: boolean }
  | { ok: false; rule: string; extra: Record<string, unknown> };

/** The deal's next step for a call request: "Call requested Wed 18 Nov 10:00: pricing for 3 sites". */
export const callbackNextStep = (timeLocal: string, brief: string, confirmed = false) =>
  `Call ${confirmed ? "confirmed" : "requested"} ${timeLocal}${brief ? `: ${brief}` : ""}`;

/**
 * Records the call the buyer agreed to. One per lead: a new request replaces
 * the earlier one. Refused for an opted-out lead, a paused account, a chat a
 * person holds or that is closed, an unreadable time, a time in the past or
 * less than 15 minutes or more than 30 days ahead, and a time outside the
 * lead's contact hours (the result then offers the nearest allowed time).
 * The conversation stays with the agent.
 */
export async function requestCallback(db: Db, ctx: CallbackContext, input: CallbackInput, now = new Date()): Promise<CallbackResult> {
  const [row] = await db.select({ lead: leads, conv: conversations, account: sellerAccounts }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, conversations.accountId))
    .where(and(
      eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId),
      eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId),
    ));
  if (!row) return { ok: false, rule: "Conversation not found", extra: {} };
  const { lead, conv, account } = row;
  if (lead.status === "opted_out") return { ok: false, rule: "Lead opted out", extra: { message: "Do not arrange a call. The buyer does not want to be contacted." } };
  if (account.status === "paused") return { ok: false, rule: "The seller's account is paused", extra: { message: "Do not promise a call. Say the team will be in touch." } };
  if (conv.status !== "open") return { ok: false, rule: "The agent is paused for this chat", extra: { message: "A person handles this chat now. Do not arrange a call yourself." } };

  // The lead's market decides the time zone and contact hours (its own, else the account's).
  const contact = await leadContactSettings(db, account, lead.marketId);
  const tz = contact.timezone;
  const brief = cleanBrief(input.brief);
  if (!brief) return { ok: false, rule: "No brief", extra: { message: "Give a short brief: what the buyer wants to cover and what the person should have ready." } };
  const at = parseCallTime(input.time, tz);
  if (!at) {
    return { ok: false, rule: "Invalid time", extra: { message: `Give time as an ISO date-time with the offset of ${tz}, e.g. ${isoInZone(now, tz)}, or as a local date and time, e.g. ${isoInZone(now, tz).slice(0, 16)}.` } };
  }
  const check = checkCallTime(contact.contactHours, tz, at, now);
  if (!check.ok) {
    const rule = { past: "Time is in the past", too_soon: "Time is less than 15 minutes ahead", too_far: "Time is more than 30 days ahead", outside_hours: "Outside contact hours" }[check.why];
    return {
      ok: false, rule,
      extra: check.nearest
        ? {
            suggested_time: isoInZone(check.nearest, tz), suggested_local: formatDueLocal(check.nearest, tz), contact_hours: summarizeContactHours(contact.contactHours),
            message: `Not requested. Offer the buyer ${formatDueLocal(check.nearest, tz)} instead (in their own wording); when they agree, call request_callback with suggested_time.`,
          }
        : { contact_hours: summarizeContactHours(contact.contactHours), message: "Not requested: ask the buyer for another time within the next 30 days and within contact hours." },
    };
  }

  const before = await leadCallback(db, ctx.accountId, ctx.leadId, now);
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(leadEvents).values({
      id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: CALLBACK_EVENTS.requested, actor: "agent", createdAt: now,
      data: { callbackId: id, at: at.toISOString(), timezone: tz, brief, conversationId: ctx.conversationId, ...(before ? { replaces: before.id } : {}) },
    }),
    q.insert(auditLog).values({
      accountId: ctx.accountId, actorUserId: null, action: "callback.requested", targetType: "lead", targetId: ctx.leadId,
      details: { callbackId: id, at: at.toISOString(), ...(before ? { replaces: before.id } : {}) },
    }),
  ]);
  const request = (await leadCallback(db, ctx.accountId, ctx.leadId, now))!;
  return { ok: true, request, timeLocal: formatDueLocal(at, tz), replaced: !!before };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A confirmed call stays on the lead page and in the agent's context until this long after its time. */
export const CONFIRMED_SHOWN_MS = 2 * HOUR;
/** How far back Needs you looks for requests: 30 days ahead at most, plus a week. */
const LOOKBACK_MS = 37 * DAY;

/** A request still to act on (waiting for the seller), or a confirmed call that has not passed yet. */
export const isActiveCallback = (c: CallbackRequest | null, now: Date): c is CallbackRequest =>
  !!c && (c.status === "requested" || c.at.getTime() + CONFIRMED_SHOWN_MS > now.getTime());

/** The lead's active call request, if any. */
export async function leadCallback(db: Db, accountId: string, leadId: string, now = new Date()): Promise<CallbackRequest | null> {
  const rows = await db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES])));
  const c = currentCallbackOf(rows);
  return isActiveCallback(c, now) ? c : null;
}

export type CallbackNeed = CallbackRequest & { leadName: string; company: string | null; marketId: string | null };

/** Requests waiting for the seller, for the account's Needs you list (not test leads, not closed leads). */
export async function requestedCallbacks(db: Db, accountId: string, now: Date): Promise<CallbackNeed[]> {
  const rows = await db.select({
    type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data,
    leadName: leads.fullName, company: leads.company, marketId: leads.marketId,
  }).from(leadEvents)
    .innerJoin(leads, eq(leads.id, leadEvents.leadId))
    .where(and(
      eq(leadEvents.accountId, accountId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES]), gt(leadEvents.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
      eq(leads.accountId, accountId), eq(leads.isTest, false), inArray(leads.status, ["new", "waiting_for_reply", "agent_handling", "human_handling", "meeting_booked"]),
    ));
  const lead = new Map(rows.map((r) => [r.leadId, r]));
  return currentCallbacks(rows)
    .filter((c) => c.status === "requested")
    .map((c) => ({ ...c, leadName: lead.get(c.leadId)!.leadName, company: lead.get(c.leadId)!.company, marketId: lead.get(c.leadId)!.marketId }));
}

// ---------------------------------------------------------------------------
// The seller confirms or changes the time
// ---------------------------------------------------------------------------

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;

/** Every member of a seller account is its admin today; a platform admin acting as one may act too. */
export const mayManageCallbacks = (a: Pick<Access, "role">) => a.role === "seller_admin" || a.role === "platform_admin";

export type BuyerTold = { told: true; messageId: string } | { told: false; reason: "no_conversation" | "closed" | "opted_out" | "window_closed" };
export type SellerCallbackResult =
  | { ok: true; leadId: string; request: CallbackRequest; buyer: BuyerTold }
  | { ok: false; reason: "forbidden" | "not_found" | "already_confirmed" | "past" | "invalid_time" };

/** Confirms the requested time and tells the buyer in the chat. Account admins only; audited. */
export async function confirmCallback(db: Db, a: Access, leadId: string, callbackId: string, transport?: TwilioTransport | null, now = new Date()): Promise<SellerCallbackResult> {
  if (!mayManageCallbacks(a)) return { ok: false, reason: "forbidden" };
  const c = await leadCallback(db, a.account.id, leadId, now);
  if (!c || c.id !== callbackId) return { ok: false, reason: "not_found" };
  if (c.status === "confirmed") return { ok: false, reason: "already_confirmed" };
  if (c.at.getTime() <= now.getTime()) return { ok: false, reason: "past" };
  return sellerSets(db, a, c, c.at, c.timezone, "confirmed", transport, now);
}

/**
 * Sets another time ("YYYY-MM-DD" and "HH:MM" in the lead's time zone), which
 * is then confirmed, and tells the buyer in the chat. The time must be in the
 * future; the seller may pick it outside contact hours (they agreed it).
 */
export async function changeCallback(
  db: Db, a: Access, leadId: string, callbackId: string, input: { date: string; time: string }, transport?: TwilioTransport | null, now = new Date(),
): Promise<SellerCallbackResult> {
  if (!mayManageCallbacks(a)) return { ok: false, reason: "forbidden" };
  const c = await leadCallback(db, a.account.id, leadId, now);
  if (!c || c.id !== callbackId) return { ok: false, reason: "not_found" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return { ok: false, reason: "invalid_time" };
  const [lead] = await db.select({ marketId: leads.marketId }).from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, a.account.id)));
  if (!lead) return { ok: false, reason: "not_found" };
  const tz = (await leadContactSettings(db, a.account, lead.marketId)).timezone;
  const at = zonedInstant(tz, input.date, input.time);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_time" };
  if (at.getTime() <= now.getTime()) return { ok: false, reason: "past" };
  return sellerSets(db, a, c, at, tz, "changed", transport, now);
}

async function sellerSets(
  db: Db, a: Access, c: CallbackRequest, at: Date, timezone: string, how: "confirmed" | "changed", transport: TwilioTransport | null | undefined, now: Date,
): Promise<SellerCallbackResult> {
  const accountId = a.account.id;
  const actor: Actor = { userId: a.user.id, actingAs: a.actingAs };
  const timeLocal = formatDueLocal(at, timezone);
  await Promise.all([
    db.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: c.leadId, type: CALLBACK_EVENTS[how], actor: "human", actorUserId: a.user.id, createdAt: now,
      data: { callbackId: c.id, at: at.toISOString(), timezone, ...(how === "changed" ? { previousAt: c.at.toISOString() } : {}) },
    }),
    writeAudit(db, actor, { accountId, action: `callback.${how}`, targetType: "lead", targetId: c.leadId, details: { callbackId: c.id, at: at.toISOString() } }),
    // The deal's next step says the confirmed time (seller views and the agent's context).
    db.update(dealStates).set({ nextStep: callbackNextStep(timeLocal, c.brief, true) }).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, c.leadId))),
  ]);
  const buyer = await tellBuyer(db, accountId, c, at, timezone, how, transport === undefined ? defaultTransport() : transport, now);
  return { ok: true, leadId: c.leadId, request: { ...c, at, timezone, status: "confirmed", changed: c.changed || how === "changed" }, buyer };
}

/**
 * Tells the buyer the confirmed or changed time, as an app message in the
 * conversation the request came from (lib/agent/app-message.ts kind
 * "callback"), through the existing send path on WhatsApp and the simulator.
 * Nothing is written when the lead opted out, the chat is closed or the
 * WhatsApp 24-hour window is closed.
 */
async function tellBuyer(
  db: Db, accountId: string, c: CallbackRequest, at: Date, timezone: string, how: "confirmed" | "changed", transport: TwilioTransport | null, now: Date,
): Promise<BuyerTold> {
  if (!c.conversationId) return { told: false, reason: "no_conversation" };
  const [row] = await db.select({ conv: conversations, lead: leads }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, c.conversationId), eq(conversations.accountId, accountId), eq(leads.accountId, accountId), eq(leads.id, c.leadId)));
  if (!row) return { told: false, reason: "no_conversation" };
  const { conv, lead } = row;
  if (lead.status === "opted_out") return { told: false, reason: "opted_out" };
  if (conv.status === "closed") return { told: false, reason: "closed" };
  if (conv.channel === "whatsapp" && !(await conversationWindow(db, accountId, conv.id, now)).open) return { told: false, reason: "window_closed" };
  const language = isLocale(conv.language) ? conv.language : "en";
  const body = t(how === "confirmed" ? "buyer.app.callback_confirmed" : "buyer.app.callback_changed", { time: buyerCallTime(at, timezone, language) }, language);
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(messages).values({ id, accountId, conversationId: conv.id, actor: "agent", body, language, createdAt: now }),
    q.insert(toolCalls).values({
      accountId, conversationId: conv.id, messageId: id, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: id, kind: "callback", callback_id: c.id, at: at.toISOString() }, outcome: "ok", createdAt: now,
    }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
  ]);
  if (conv.channel === "whatsapp" || conv.channel === SIMULATOR_CHANNEL) {
    await deliverText(db, transport, { accountId, conversationId: conv.id, messageId: id, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
  }
  return { told: true, messageId: id };
}
