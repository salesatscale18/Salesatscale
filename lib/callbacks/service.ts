/**
 * Calls with a person (O6; reach boards): the reads for the agent's context,
 * the lead page and Needs you, and the seller's Change time and Cancel. The
 * buyer books the call in the chat (lib/team-calls/service.ts: the agent's
 * request_callback posts the booking card); `requestCallback` and
 * `confirmCallback` are the older flow (the agent recorded a time, the seller
 * confirmed it), kept for calls already in the data and the demo seed: the
 * agent no longer calls it and the lead page has no Confirm. Every function is scoped by account. The chat never pauses: the
 * conversation stays with the agent until the call. Rules and the stored
 * shape (lead events): lib/callbacks/rules.ts.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { auditLog, conversations, dealStates, leadEvents, leads, messages, sellerAccounts, toolCalls } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import type { AccountAccess } from "@/lib/accounts/service";
import { isWithinContactHours, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { formatBuyerLocal, formatDueLocal, isoInZone, zonedInstant } from "@/lib/follow-ups/rules";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { defaultTransport, type TwilioTransport } from "@/lib/channels/twilio";
import { isSimulatedLead, isWebChat } from "@/lib/simulator/rules";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { isLocale, t } from "@/lib/i18n";
import { handBack, takeOver } from "@/lib/agent/conversation";
import { nudgeBuyer } from "@/lib/sms/service";
import { storedBuyerZone } from "@/lib/team-calls/zone";
import {
  buyerCallTime, CALLBACK_EVENT_TYPES, CALLBACK_EVENTS, callNeedsLog, checkCallTime, cleanBrief, currentCallbackOf, currentCallbacks, isCallNextStep, parseCallTime,
  teamCallNextStep, type CallbackRequest,
} from "./rules";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// The agent's tool
// ---------------------------------------------------------------------------

/** buyer_named_time: the buyer named this time themselves (true), or the agent proposed it (false or absent). */
export type CallbackInput = { time: unknown; brief: unknown; buyer_named_time?: unknown };
export type CallbackContext = { accountId: string; leadId: string; conversationId: string };

export type CallbackResult =
  /** timeLocal: the short form for seller views ("Fri 20 Nov 12:30"); timeForBuyer: the long form the agent tells the buyer. */
  | { ok: true; request: CallbackRequest; timeLocal: string; timeForBuyer: string; replaced: boolean }
  | { ok: false; rule: string; extra: Record<string, unknown> };

/** The deal's next step for a call request: "Call requested Wed 18 Nov 10:00: pricing for 3 sites". */
export const callbackNextStep = (timeLocal: string, brief: string, confirmed = false) =>
  `Call ${confirmed ? "confirmed" : "requested"} ${timeLocal}${brief ? `: ${brief}` : ""}`;

/**
 * Records the call the buyer agreed to. One per lead: a new request replaces
 * the earlier one. Refused for an opted-out lead, a paused account, a chat a
 * person holds or that is closed, an unreadable time, a time in the past or
 * less than 15 minutes or more than 30 days ahead, and a time the agent
 * proposed outside the lead's contact hours (the result then offers the
 * nearest allowed time). A time the buyer named is accepted at any hour
 * (owner, 20 Nov 2026); the request records that, so the call card can say so.
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
  // RB4: times the agent tells the buyer are in the buyer's own zone when it is stored, else the market's.
  const buyerTz = (await storedBuyerZone(db, ctx.accountId, ctx.leadId)) ?? tz;
  const brief = cleanBrief(input.brief);
  if (!brief) return { ok: false, rule: "No brief", extra: { message: "Give a short brief: what the buyer wants to cover and what the person should have ready." } };
  const at = parseCallTime(input.time, tz);
  if (!at) {
    return { ok: false, rule: "Invalid time", extra: { message: `Give time as an ISO date-time with the offset of ${tz}, e.g. ${isoInZone(now, tz)}, or as a local date and time, e.g. ${isoInZone(now, tz).slice(0, 16)}.` } };
  }
  const buyerNamed = input.buyer_named_time === true;
  const check = checkCallTime(contact.contactHours, tz, at, now, { buyerNamed });
  if (!check.ok) {
    const rule = { past: "Time is in the past", too_soon: "Time is less than 15 minutes ahead", too_far: "Time is more than 30 days ahead", outside_hours: "Outside contact hours" }[check.why];
    return {
      ok: false, rule,
      extra: check.nearest
        ? {
            suggested_time: isoInZone(check.nearest, tz), suggested_local: formatBuyerLocal(check.nearest, buyerTz), contact_hours: summarizeContactHours(contact.contactHours),
            message: `Not requested. Offer the buyer ${formatBuyerLocal(check.nearest, buyerTz)} instead (in their own wording); when they agree, call request_callback with suggested_time.`,
          }
        : {
            contact_hours: summarizeContactHours(contact.contactHours),
            message: buyerNamed ? "Not requested: ask the buyer for another time within the next 30 days." : "Not requested: ask the buyer for another time within the next 30 days and within contact hours.",
          },
    };
  }

  // Only a time the buyer named can be outside contact hours (checkCallTime): kept for the call card's note.
  const outsideContactHours = !isWithinContactHours(contact.contactHours, tz, at);
  const named = { buyerNamedTime: buyerNamed, ...(outsideContactHours ? { outsideContactHours: true } : {}) };
  const before = await leadCallback(db, ctx.accountId, ctx.leadId, now);
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(leadEvents).values({
      id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: CALLBACK_EVENTS.requested, actor: "agent", createdAt: now,
      data: { callbackId: id, at: at.toISOString(), timezone: tz, brief, conversationId: ctx.conversationId, ...named, ...(before ? { replaces: before.id } : {}) },
    }),
    q.insert(auditLog).values({
      accountId: ctx.accountId, actorUserId: null, action: "callback.requested", targetType: "lead", targetId: ctx.leadId,
      details: { callbackId: id, at: at.toISOString(), ...named, ...(before ? { replaces: before.id } : {}) },
    }),
  ]);
  const request = (await leadCallback(db, ctx.accountId, ctx.leadId, now))!;
  return { ok: true, request, timeLocal: formatDueLocal(at, tz), timeForBuyer: formatBuyerLocal(at, buyerTz), replaced: !!before };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A confirmed call stays on the lead page and in the agent's context until this long after its time. */
export const CONFIRMED_SHOWN_MS = 2 * HOUR;
/** How far back Needs you looks for requests: 30 days ahead at most, plus a week. */
const LOOKBACK_MS = 37 * DAY;

/**
 * A call still on the lead page: an older request the agent recorded (still
 * waiting; its time can be set with Change time), a confirmed or booked call
 * that has not passed yet, or one waiting for "Log the call" (callNeedsLog).
 */
export const isActiveCallback = (c: CallbackRequest | null, now: Date): c is CallbackRequest =>
  !!c && (c.status === "requested" || c.at.getTime() + CONFIRMED_SHOWN_MS > now.getTime() || callNeedsLog(c, now));

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
  return (await callbackNeeds(db, accountId, now)).filter((c) => c.status === "requested");
}

/**
 * Calls whose slot has ended and that wait for "Log the call" (callNeedsLog, the same condition
 * as callbackAfterCall), for Needs you › Calls (reach boards). Gone once the call is logged as
 * "We spoke", moved to a new time or cancelled.
 */
export async function finishedCallbacks(db: Db, accountId: string, now: Date): Promise<CallbackNeed[]> {
  return (await callbackNeeds(db, accountId, now)).filter((c) => callNeedsLog(c, now));
}

/** Each lead's current call request with the lead's name (not test leads, not closed leads). */
async function callbackNeeds(db: Db, accountId: string, now: Date): Promise<CallbackNeed[]> {
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
    .map((c) => ({ ...c, leadName: lead.get(c.leadId)!.leadName, company: lead.get(c.leadId)!.company, marketId: lead.get(c.leadId)!.marketId }));
}

// ---------------------------------------------------------------------------
// The seller confirms or changes the time
// ---------------------------------------------------------------------------

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;

/** Every member of a seller account is its admin today; a platform admin acting as one may act too. */
export const mayManageCallbacks = (a: Pick<Access, "role">) => a.role === "seller_admin" || a.role === "platform_admin";

export type BuyerTold = { told: true; messageId: string } | { told: false; reason: "no_conversation" | "closed" | "opted_out" | "window_closed" };
type TellHow = "confirmed" | "changed" | "cancelled";
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
      data: { callbackId: c.id, at: at.toISOString(), timezone, conversationId: c.conversationId, ...(how === "changed" ? { previousAt: c.at.toISOString(), by: "team" } : {}) },
    }),
    writeAudit(db, actor, { accountId, action: `callback.${how}`, targetType: "lead", targetId: c.leadId, details: { callbackId: c.id, at: at.toISOString() } }),
    // The deal's next step says the confirmed time (seller views and the agent's context).
    db.update(dealStates).set({ nextStep: c.booked ? teamCallNextStep(timeLocal) : callbackNextStep(timeLocal, c.brief, true) }).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, c.leadId))),
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
  db: Db, accountId: string, c: CallbackRequest, at: Date, timezone: string, how: TellHow, transport: TwilioTransport | null, now: Date,
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
  // Every time shown to the buyer is in the buyer's own zone (spec 8): their browser's when they booked, else the one
  // stored when they opened the chat (RB4), else the market's.
  const buyerZone = c.buyerTimezone ?? (await storedBuyerZone(db, accountId, c.leadId)) ?? timezone;
  const body = how === "cancelled"
    ? t("buyer.app.callback_cancelled", undefined, language)
    : t(how === "confirmed" ? "buyer.app.callback_confirmed" : "buyer.app.callback_changed", { time: buyerCallTime(at, buyerZone, language) }, language);
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(messages).values({ id, accountId, conversationId: conv.id, actor: "agent", body, language, createdAt: now }),
    q.insert(toolCalls).values({
      accountId, conversationId: conv.id, messageId: id, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: id, kind: "callback", callback_id: c.id, at: at.toISOString(), ...(how === "cancelled" ? { cancelled: true } : {}) }, outcome: "ok", createdAt: now,
    }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
  ]);
  if (conv.channel === "whatsapp" || isWebChat(conv.channel)) {
    await deliverText(db, transport, { accountId, conversationId: conv.id, messageId: id, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
  }
  // A real buyer's web chat: a new time also goes out as the team_call SMS (board ReachSms), in the buyer's zone.
  if (how !== "cancelled" && isWebChat(conv.channel) && !conv.isTest && !lead.isTest && !isSimulatedLead(lead)) {
    await nudgeBuyer(db, { userId: null, actingAs: false }, {
      accountId, leadId: lead.id, kind: "team_call", messageId: id, now,
      time: language === "he" ? buyerCallTime(at, buyerZone, "he") : formatDueLocal(at, buyerZone),
    });
  }
  return { told: true, messageId: id };
}

// ---------------------------------------------------------------------------
// The seller cancels the call, and answers "How did the call go?" (UX, O6 follow-up)
// ---------------------------------------------------------------------------

/** The deal's next step was the call (callbackNextStep, teamCallNextStep): it goes back to none, so "Stage now" is as without the call. */
async function clearCallNextStep(db: Db, accountId: string, leadId: string) {
  const [deal] = await db.select({ id: dealStates.id, nextStep: dealStates.nextStep }).from(dealStates).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, leadId)));
  if (deal && isCallNextStep(deal.nextStep)) await db.update(dealStates).set({ nextStep: null }).where(and(eq(dealStates.id, deal.id), eq(dealStates.accountId, accountId)));
}

export type CancelCallbackResult =
  | { ok: true; leadId: string; buyer: BuyerTold }
  | { ok: false; reason: "forbidden" | "not_found" };

/**
 * Cancels the lead's call request (requested or confirmed): records
 * "callback.cancelled", so the request is closed everywhere (lead page, Needs
 * you, the agent's context); clears the deal's next step when it was the call;
 * and tells the buyer in one app message ("We need to move our call…").
 * Account admins only; audited.
 */
export async function cancelCallback(db: Db, a: Access, leadId: string, callbackId: string, transport?: TwilioTransport | null, now = new Date()): Promise<CancelCallbackResult> {
  if (!mayManageCallbacks(a)) return { ok: false, reason: "forbidden" };
  const accountId = a.account.id;
  const c = await leadCallback(db, accountId, leadId, now);
  if (!c || c.id !== callbackId) return { ok: false, reason: "not_found" };
  await Promise.all([
    db.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId, type: CALLBACK_EVENTS.cancelled, actor: "human", actorUserId: a.user.id, createdAt: now,
      data: { callbackId: c.id, at: c.at.toISOString(), timezone: c.timezone },
    }),
    writeAudit(db, { userId: a.user.id, actingAs: a.actingAs }, { accountId, action: "callback.cancelled", targetType: "lead", targetId: leadId, details: { callbackId: c.id } }),
    clearCallNextStep(db, accountId, leadId),
  ]);
  const buyer = await tellBuyer(db, accountId, c, c.at, c.timezone, "cancelled", transport === undefined ? defaultTransport() : transport, now);
  return { ok: true, leadId, buyer };
}

/**
 * The confirmed call whose slot has ended and that waits for "Log the call"
 * (callNeedsLog). Null when there is none, or it was logged as "We spoke" or
 * answered the older way.
 */
export async function callbackAfterCall(db: Db, accountId: string, leadId: string, now = new Date()): Promise<CallbackRequest | null> {
  const rows = await db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES])));
  const c = currentCallbackOf(rows);
  return callNeedsLog(c, now) ? c : null;
}

export type AfterCallChoice = "agent" | "seller";
export type AfterCallResult =
  | { ok: true; leadId: string; choice: AfterCallChoice }
  | { ok: false; reason: "forbidden" | "not_found" | "closed" | "opted_out" };

/**
 * "How did the call go?": "agent" keeps the chat with the agent, or hands it
 * back when a person holds it; "seller" takes the conversation over with the
 * same service as Take over, so the agent pauses. Records the choice, which
 * removes the prompt. Account admins only, scoped by account.
 */
export async function answerAfterCall(db: Db, a: Access, leadId: string, callbackId: string, choice: AfterCallChoice, now = new Date()): Promise<AfterCallResult> {
  if (!mayManageCallbacks(a)) return { ok: false, reason: "forbidden" };
  const accountId = a.account.id;
  const c = await callbackAfterCall(db, accountId, leadId, now);
  if (!c || c.id !== callbackId) return { ok: false, reason: "not_found" };
  const actor: Actor = { userId: a.user.id, actingAs: a.actingAs };
  // The call's conversation, else the lead's latest.
  const [conv] = c.conversationId
    ? await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, c.conversationId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)))
    : await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId))).orderBy(desc(conversations.createdAt)).limit(1);
  if (conv) {
    const r = choice === "seller" ? await takeOver(db, actor, accountId, conv.id, now) : await handBack(db, actor, accountId, conv.id, now);
    // The agent may stay on a closed or opted-out chat: nothing to hand back. Taking it over needs it open.
    if (!r.ok && (choice === "seller" || r.reason === "not_found")) return { ok: false, reason: r.reason };
  }
  await Promise.all([
    db.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId, type: choice === "agent" ? CALLBACK_EVENTS.afterAgent : CALLBACK_EVENTS.afterSeller, actor: "human", actorUserId: a.user.id, createdAt: now,
      data: { callbackId: c.id, at: c.at.toISOString(), timezone: c.timezone, conversationId: conv?.id ?? null },
    }),
    writeAudit(db, actor, { accountId, action: `callback.after_${choice}`, targetType: "lead", targetId: leadId, details: { callbackId: c.id } }),
    // The call is over: the deal's next step no longer says it.
    clearCallNextStep(db, accountId, leadId),
  ]);
  return { ok: true, leadId, choice };
}
