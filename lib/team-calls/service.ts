/**
 * Team calls (reach boards ReachChat and ReachSeller, owner-approved 21 Nov):
 *
 * - The agent's "a person" step (request_callback) posts the booking card in
 *   the chat (`offerBooking`): an app message of kind "booking" with the brief.
 * - The buyer books a slot on the card (`bookCall`), changes it or cancels it
 *   (`cancelCallByBuyer`). A booking is "callback.requested" with booked: true
 *   (lib/callbacks/rules), confirmed at once; a change is "callback.changed"
 *   with by: "buyer". The chat confirms it and a team_call SMS goes out.
 * - After the slot the seller logs the call on the Deal tab (`logTeamCall`):
 *   We spoke / No answer / Moved, the start, the length and a note, then a
 *   next step (hand back, take over, order form, chat link). The log is a lead
 *   event ("team_call.logged"); the agent reads the note in its context.
 *
 * No schema change: lead events, app messages and the existing tables. The
 * buyer's functions take the chat link's context (the token is the buyer's
 * credential); the seller's re-check the account role. Scoped by account id.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, dealStates, leadEvents, leads, messages, quotes, sellerAccounts, toolCalls, type Lead, type SellerAccount } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import type { AccountAccess } from "@/lib/accounts/service";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { handBack, takeOver } from "@/lib/agent/conversation";
import {
  CALLBACK_EVENT_TYPES, CALLBACK_EVENTS, CALL_NOTE_MAX, TEAM_CALL_MINUTES, callNeedsLog, callUpcoming, cleanBrief, currentCallbackOf, currentCallbacks,
  isCallNextStep, isCallOutcome, teamCallNextStep, type CallOutcome, type CallbackRequest,
} from "@/lib/callbacks/rules";
import { leadCallback, mayManageCallbacks } from "@/lib/callbacks/service";
import { deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { formatDueLocal, zonedInstant } from "@/lib/follow-ups/rules";
import { isLocale, t, type Locale } from "@/lib/i18n";
import { normalizePhone } from "@/lib/leads/rules";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { createOrderForm } from "@/lib/orders/service";
import { isWebChat } from "@/lib/simulator/rules";
import { offerOrderFormInChat, sendChatLink, type MaybeNudge } from "@/lib/sms/outbound";
import { nudgeBuyer, type NudgeDeps } from "@/lib/sms/service";
import { maskSmsPhone } from "@/lib/sms/thread";
import { isSimulatedLead } from "@/lib/simulator/rules";
import { isFictionalDemoLead } from "@/lib/demo/phones";
import { bookingSlots, isFreeSlot, validTimezone, type BookingSlot } from "./slots";
import { storedBuyerZone } from "./zone";

const DAY = 86_400_000;
/** How far back the account's bookings are read for taken slots (a booking is at most 7 days ahead). */
const TAKEN_LOOKBACK_MS = 37 * DAY;

/** The app message kind of the booking card, and of the chat line after a booking. */
export const BOOKING_KIND = "booking";
export const BOOKED_KIND = "booked";

const langOf = (l: string | null | undefined): Locale => (l && isLocale(l) ? l : "en");


/** The call time as the team_call SMS and the chat say it, in the buyer's zone: "Mon 23 Nov 15:30" (Hebrew "23.11 15:30"). */
export function smsCallTime(at: Date, timezone: string, lang: string): string {
  if (lang !== "he") return formatDueLocal(at, timezone);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  return `${g("day")}.${g("month")} ${g("hour")}:${g("minute")}`;
}

/** Writes an app message into a conversation and delivers it on its channel (as lib/callbacks tellBuyer does). */
async function appMessage(
  db: Db, accountId: string, conv: { id: string; channel: string }, body: string, language: string, result: Record<string, unknown>, now: Date,
): Promise<string> {
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(messages).values({ id, accountId, conversationId: conv.id, actor: "agent", body, language, createdAt: now }),
    q.insert(toolCalls).values({
      accountId, conversationId: conv.id, messageId: id, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: id, ...result }, outcome: "ok", createdAt: now,
    }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
  ]);
  if (conv.channel === "whatsapp" || isWebChat(conv.channel)) {
    await deliverText(db, null, { accountId, conversationId: conv.id, messageId: id, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
  }
  return id;
}

// ---------------------------------------------------------------------------
// The agent's request_callback: the booking card
// ---------------------------------------------------------------------------

export type OfferContext = { accountId: string; leadId: string; conversationId: string };
export type OfferResult =
  | { ok: true; messageId: string; replaced: boolean }
  | { ok: false; rule: string; extra: Record<string, unknown> };

/**
 * Posts the booking card in the chat: the buyer picks a time from the team's
 * free slots there. One per buyer: a new card replaces the earlier one (only
 * the latest card can book). Refused for an opted-out lead, a paused account,
 * a chat a person holds or that is closed, and an empty brief. The
 * conversation stays with the agent.
 */
export async function offerBooking(db: Db, ctx: OfferContext, input: { brief: unknown }, now = new Date()): Promise<OfferResult> {
  const [row] = await db.select({ lead: leads, conv: conversations, account: sellerAccounts }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, conversations.accountId))
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId), eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId)));
  if (!row) return { ok: false, rule: "Conversation not found", extra: {} };
  const { lead, conv, account } = row;
  if (lead.status === "opted_out") return { ok: false, rule: "Lead opted out", extra: { message: "Do not arrange a call. The buyer does not want to be contacted." } };
  if (account.status === "paused") return { ok: false, rule: "The seller's account is paused", extra: { message: "Do not promise a call. Say the team will be in touch." } };
  if (conv.status !== "open") return { ok: false, rule: "The agent is paused for this chat", extra: { message: "A person handles this chat now. Do not arrange a call yourself." } };
  const brief = cleanBrief(input.brief);
  if (!brief) return { ok: false, rule: "No brief", extra: { message: "Give a short brief: what the buyer wants to cover and what the person should have ready." } };
  const before = await latestBookingOffer(db, ctx.accountId, ctx.leadId);
  const lang = langOf(conv.language ?? lead.language);
  const messageId = await appMessage(db, ctx.accountId, conv, t("buyer.app.booking", { minutes: TEAM_CALL_MINUTES }, lang), lang, { kind: BOOKING_KIND, brief }, now);
  await db.insert(leadEvents).values({
    accountId: ctx.accountId, leadId: ctx.leadId, type: "team_call.offered", actor: "agent", createdAt: now,
    data: { conversationId: conv.id, messageId, brief, ...(before ? { replaces: before.messageId } : {}) },
  });
  return { ok: true, messageId, replaced: !!before };
}

export type BookingOffer = { messageId: string; conversationId: string; brief: string; at: Date };

/** The lead's latest booking card (any of its conversations), or null. */
export async function latestBookingOffer(db: Db, accountId: string, leadId: string): Promise<BookingOffer | null> {
  const [r] = await db.select({ messageId: toolCalls.messageId, conversationId: toolCalls.conversationId, result: toolCalls.result, at: toolCalls.createdAt })
    .from(toolCalls).innerJoin(conversations, eq(conversations.id, toolCalls.conversationId))
    .where(and(
      eq(toolCalls.accountId, accountId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId),
      eq(toolCalls.name, APP_MESSAGE_CALL), sql`${toolCalls.result}->>'kind' = ${BOOKING_KIND}`,
    ))
    .orderBy(desc(toolCalls.createdAt)).limit(1);
  if (!r?.messageId) return null;
  return { messageId: r.messageId, conversationId: r.conversationId, brief: String((r.result as { brief?: unknown } | null)?.brief ?? ""), at: r.at };
}

// ---------------------------------------------------------------------------
// The buyer's booking card
// ---------------------------------------------------------------------------

type BuyerCtx = { lead: Lead; account: SellerAccount };

/** Start times (ms) of the account's calls that are booked or confirmed and still ahead, except `exceptLeadId`'s own. */
export async function takenSlotTimes(db: Db, accountId: string, now: Date, exceptLeadId?: string): Promise<Set<number>> {
  const rows = await db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES]), gt(leadEvents.createdAt, new Date(now.getTime() - TAKEN_LOOKBACK_MS))));
  return new Set(currentCallbacks(rows).filter((c) => c.leadId !== exceptLeadId && callUpcoming(c, now)).map((c) => c.at.getTime()));
}

export type BookingView = {
  /** The latest booking card's message: the only card that books. */
  offerMessageId: string;
  lengthMin: number;
  /** The number the team will call, masked ("+972 50-•••-4567"). */
  phone: string | null;
  /** The market's zone: the buyer's browser zone is used when the page can read it. */
  timezone: string;
  slots: BookingSlot[];
  /** The buyer's booked call while it is ahead. */
  booked: { at: string; phone: string | null } | null;
};

/** What the booking card shows, or null when the agent posted none. */
export async function bookingView(db: Db, ctx: BuyerCtx, now = new Date()): Promise<BookingView | null> {
  const offer = await latestBookingOffer(db, ctx.account.id, ctx.lead.id);
  if (!offer) return null;
  const [contact, taken, current] = await Promise.all([
    leadContactSettings(db, ctx.account, ctx.lead.marketId),
    takenSlotTimes(db, ctx.account.id, now, ctx.lead.id),
    leadCallback(db, ctx.account.id, ctx.lead.id, now),
  ]);
  const booked = callUpcoming(current, now) && current.booked ? current : null;
  const callPhone = (c: CallbackRequest | null) => c?.phone ?? (isSimulatedLead(ctx.lead) ? null : ctx.lead.phone);
  const phone = callPhone(booked);
  return {
    offerMessageId: offer.messageId, lengthMin: TEAM_CALL_MINUTES, phone: phone ? maskSmsPhone(phone) : null, timezone: contact.timezone,
    slots: bookingSlots(contact.contactHours, contact.timezone, now, taken),
    booked: booked ? { at: booked.at.toISOString(), phone: phone ? maskSmsPhone(phone) : null } : null,
  };
}

export type BookResult =
  | { ok: true; at: string; changed: boolean; sms: MaybeNudge | null }
  | { ok: false; reason: "opted_out" | "no_offer" | "slot_taken" | "invalid_phone" | "invalid_time" | "account_paused" };

/**
 * The buyer books (or moves) the call on the booking card: `at` must be one of
 * the free slots, re-checked here. Writes the booking (confirmed at once), the
 * deal's next step, a line in the chat ("Booked…"), and the team_call SMS.
 */
export async function bookCall(
  db: Db, ctx: BuyerCtx, input: { at: unknown; phone?: unknown; timezone?: unknown }, deps: NudgeDeps = {}, now = new Date(),
): Promise<BookResult> {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, ctx.lead.id), eq(leads.accountId, ctx.account.id)));
  if (!lead || lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ctx.account.id));
  if (!account || account.status === "paused") return { ok: false, reason: "account_paused" };
  const at = typeof input.at === "string" ? new Date(input.at) : null;
  if (!at || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_time" };
  const offer = await latestBookingOffer(db, account.id, lead.id);
  if (!offer) return { ok: false, reason: "no_offer" };
  let phone: string | null = null;
  const rawPhone = typeof input.phone === "string" ? input.phone.trim().slice(0, 40) : "";
  if (rawPhone) {
    phone = normalizePhone(rawPhone, account.market);
    if (!phone) return { ok: false, reason: "invalid_phone" };
    if (phone === lead.phone) phone = null;
  }
  // The page sends the browser's zone; else the one stored for this buyer (RB3).
  const buyerTimezone = validTimezone(input.timezone) ?? await storedBuyerZone(db, account.id, lead.id);
  const [contact, taken, current] = await Promise.all([
    leadContactSettings(db, account, lead.marketId),
    takenSlotTimes(db, account.id, now, lead.id),
    leadCallback(db, account.id, lead.id, now),
  ]);
  const own = callUpcoming(current, now) ? current : null;
  if (!isFreeSlot(bookingSlots(contact.contactHours, contact.timezone, now, taken), at)) return { ok: false, reason: "slot_taken" };
  const tz = contact.timezone;
  const [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.id, offer.conversationId), eq(conversations.accountId, account.id), eq(conversations.leadId, lead.id)));
  if (own) {
    await db.insert(leadEvents).values({
      accountId: account.id, leadId: lead.id, type: CALLBACK_EVENTS.changed, actor: "buyer", createdAt: now,
      data: {
        callbackId: own.id, at: at.toISOString(), timezone: tz, previousAt: own.at.toISOString(), by: "buyer", conversationId: own.conversationId ?? offer.conversationId,
        ...(buyerTimezone ? { buyerTimezone } : {}), ...(phone ? { phone } : {}),
      },
    });
  } else {
    await db.insert(leadEvents).values({
      accountId: account.id, leadId: lead.id, type: CALLBACK_EVENTS.requested, actor: "buyer", createdAt: now,
      data: {
        callbackId: randomUUID(), at: at.toISOString(), timezone: tz, brief: offer.brief, conversationId: offer.conversationId, booked: true,
        durationMin: TEAM_CALL_MINUTES, ...(buyerTimezone ? { buyerTimezone } : {}), ...(phone ? { phone } : {}),
        ...(current ? { replaces: current.id } : {}),
      },
    });
  }
  await Promise.all([
    // The deal's next step says the booked call (a lead with no deal state yet gets one).
    db.insert(dealStates).values({ accountId: account.id, leadId: lead.id, nextStep: teamCallNextStep(formatDueLocal(at, tz)) })
      .onConflictDoUpdate({ target: dealStates.leadId, set: { nextStep: teamCallNextStep(formatDueLocal(at, tz)) }, where: eq(dealStates.accountId, account.id) }),
    db.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, lead.id), eq(leads.accountId, account.id))),
  ]);
  // The agent goes on: one line in the chat (no model call), which the agent sees in its history.
  let messageId: string | null = null;
  if (conv && conv.status !== "closed") {
    const lang = langOf(conv.language ?? lead.language);
    messageId = await appMessage(db, account.id, conv, t("buyer.app.booked", undefined, lang), lang, { kind: BOOKED_KIND, at: at.toISOString() }, now);
  }
  const lang = lead.language === "he" ? "he" : "en";
  // Never to a simulated buyer, a test lead or a fictional demo number (nothing is tried or recorded).
  const sms = isSimulatedLead(lead) || lead.isTest || isFictionalDemoLead(lead) ? null : await nudgeBuyer(db, { userId: null, actingAs: false }, {
    accountId: account.id, leadId: lead.id, kind: "team_call", messageId, time: smsCallTime(at, buyerTimezone ?? tz, lang), now,
  }, deps);
  return { ok: true, at: at.toISOString(), changed: !!own, sms };
}

/** The buyer cancels the booked call on the card (after the confirm step). The chat says so; the agent goes on. */
export async function cancelCallByBuyer(db: Db, ctx: BuyerCtx, now = new Date()): Promise<{ ok: boolean }> {
  const current = await leadCallback(db, ctx.account.id, ctx.lead.id, now);
  if (!callUpcoming(current, now) || !current.booked) return { ok: false };
  await db.insert(leadEvents).values({
    accountId: ctx.account.id, leadId: ctx.lead.id, type: CALLBACK_EVENTS.cancelled, actor: "buyer", createdAt: now,
    data: { callbackId: current.id, at: current.at.toISOString(), timezone: current.timezone, by: "buyer" },
  });
  await clearTeamCallNextStep(db, ctx.account.id, ctx.lead.id);
  if (current.conversationId) {
    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, current.conversationId), eq(conversations.accountId, ctx.account.id), eq(conversations.leadId, ctx.lead.id)));
    if (conv && conv.status !== "closed") {
      const lang = langOf(conv.language ?? ctx.lead.language);
      await appMessage(db, ctx.account.id, conv, t("buyer.app.booking_cancelled", undefined, lang), lang, { kind: BOOKED_KIND, cancelled: true }, now);
    }
  }
  return { ok: true };
}

export async function clearTeamCallNextStep(db: Db, accountId: string, leadId: string) {
  const [deal] = await db.select({ id: dealStates.id, nextStep: dealStates.nextStep }).from(dealStates).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, leadId)));
  if (deal && isCallNextStep(deal.nextStep)) await db.update(dealStates).set({ nextStep: null }).where(and(eq(dealStates.id, deal.id), eq(dealStates.accountId, accountId)));
}

// ---------------------------------------------------------------------------
// The seller logs the call (Deal tab › Team call)
// ---------------------------------------------------------------------------

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;

export const CALL_NEXT_STEPS = ["save", "agent", "seller", "order_form", "chat_link"] as const;
export type CallNextStep = (typeof CALL_NEXT_STEPS)[number];
export const isCallNextStepChoice = (v: unknown): v is CallNextStep => typeof v === "string" && (CALL_NEXT_STEPS as readonly string[]).includes(v);

export type LogInput = { outcome: unknown; started: unknown; lengthMin: unknown; note: unknown; next: unknown };
export type LogResult =
  | {
      ok: true; leadId: string; outcome: CallOutcome; next: CallNextStep;
      /** Send order form: "sent", or why not ("no_quote": open the quote editor). */
      orderForm?: "sent" | "no_quote" | string;
      sms?: MaybeNudge | null;
    }
  | { ok: false; reason: "forbidden" | "not_found" | "too_early" | "invalid_outcome" | "invalid_started" | "invalid_length" | "invalid_next" | "closed" | "opted_out" };

export const MAX_CALL_MINUTES = 240;

/** "HH:MM" → that time on the call's own day in the call's zone; null when not a time. */
function startedOn(c: CallbackRequest, hhmm: string): Date | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: c.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(c.at);
  const at = zonedInstant(c.timezone, day, hhmm);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Logs the call (or edits the log): how it went, when it started, its length
 * and a note the agent reads before it continues. Then the next step, which
 * always runs after the log is saved:
 * - We spoke: hand back to the agent (the buyer gets the chat link), I'm
 *   handling this deal (take over), Send order form (a ready quote's form in
 *   the chat with its SMS; without one, the quote editor), Send chat link.
 * - No answer: one SMS with the chat link and "pick a new time"; the call
 *   stays in Needs you until it is moved or cancelled.
 * - Moved: nothing more here; the card reopens the time.
 * Account admins only; audited; scoped by account.
 */
export async function logTeamCall(
  db: Db, a: Access, leadId: string, callbackId: string, input: LogInput, deps: NudgeDeps = {}, now = new Date(),
): Promise<LogResult> {
  if (!mayManageCallbacks(a)) return { ok: false, reason: "forbidden" };
  const accountId = a.account.id;
  const rows = await db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES])));
  const c = currentCallbackOf(rows);
  if (!c || c.id !== callbackId || c.status !== "confirmed") return { ok: false, reason: "not_found" };
  if (now.getTime() < c.at.getTime()) return { ok: false, reason: "too_early" };
  if (!isCallOutcome(input.outcome)) return { ok: false, reason: "invalid_outcome" };
  if (!isCallNextStepChoice(input.next)) return { ok: false, reason: "invalid_next" };
  const outcome = input.outcome;
  const next: CallNextStep = outcome === "spoke" ? input.next : "save";
  const startedRaw = typeof input.started === "string" ? input.started.trim() : "";
  const startedAt = startedRaw ? startedOn(c, startedRaw) : c.at;
  if (!startedAt) return { ok: false, reason: "invalid_started" };
  const lengthRaw = typeof input.lengthMin === "string" ? input.lengthMin.trim() : typeof input.lengthMin === "number" ? String(input.lengthMin) : "";
  let lengthMin: number | null = null;
  if (outcome === "spoke" || lengthRaw) {
    const n = Number(lengthRaw);
    if (!lengthRaw || !Number.isInteger(n) || n < 1 || n > MAX_CALL_MINUTES) return { ok: false, reason: "invalid_length" };
    lengthMin = n;
  }
  const note = (typeof input.note === "string" ? input.note : "").replace(/\r\n/g, "\n").trim().slice(0, CALL_NOTE_MAX);
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return { ok: false, reason: "not_found" };
  // The call's conversation, else the lead's latest.
  const [conv] = c.conversationId
    ? await db.select().from(conversations).where(and(eq(conversations.id, c.conversationId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)))
    : await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId))).orderBy(desc(conversations.createdAt)).limit(1);
  const actor: Actor = { userId: a.user.id, actingAs: a.actingAs };
  const earlier = c.log;
  await Promise.all([
    db.insert(leadEvents).values({
      accountId, leadId, type: CALLBACK_EVENTS.logged, actor: "human", actorUserId: a.user.id, createdAt: now,
      data: {
        callbackId: c.id, outcome, startedAt: startedAt.toISOString(), lengthMin, note, byUserId: a.user.id, at: c.at.toISOString(), timezone: c.timezone,
        conversationId: conv?.id ?? null, next, ...(earlier ? { edit: true } : {}),
        // The thread's "{who} called +972 50-•••-4567": masked, as everywhere outside the Deal tab card.
        ...(isSimulatedLead(lead) ? {} : { phoneMasked: maskSmsPhone(c.phone ?? lead.phone) }),
      },
    }),
    writeAudit(db, actor, { accountId, action: "team_call.logged", targetType: "lead", targetId: leadId, details: { callbackId: c.id, outcome, next } }),
  ]);

  if (outcome === "no_answer") {
    // One SMS per call: the chat link with "pick a new time" (the second named-time text).
    const sms = earlier?.outcome === "no_answer" || lead.isTest || isSimulatedLead(lead)
      ? null
      : await nudgeBuyer(db, actor, { accountId, leadId, kind: "named_time_retry", now }, deps);
    return { ok: true, leadId, outcome, next, sms };
  }
  if (outcome === "moved") return { ok: true, leadId, outcome, next };

  // We spoke: the call is done, so the deal's next step no longer says it.
  await clearTeamCallNextStep(db, accountId, leadId);
  if (next === "agent") {
    if (conv) {
      const r = await handBack(db, actor, accountId, conv.id, now);
      if (!r.ok && r.reason !== "not_found") return { ok: false, reason: r.reason };
      // handBack texts the chat link when it hands a held chat back; a chat the agent still has gets it here.
      if (r.ok && !r.changed && isWebChat(conv.channel) && !conv.isTest) return { ok: true, leadId, outcome, next, sms: await sendChatLink(db, actor, accountId, leadId, { ...deps, now }) };
    }
    return { ok: true, leadId, outcome, next };
  }
  if (next === "seller") {
    if (conv) {
      const r = await takeOver(db, actor, accountId, conv.id, now);
      if (!r.ok) return { ok: false, reason: r.reason === "not_found" ? "not_found" : r.reason };
    }
    return { ok: true, leadId, outcome, next };
  }
  if (next === "chat_link") return { ok: true, leadId, outcome, next, sms: await sendChatLink(db, actor, accountId, leadId, { ...deps, now }) };
  if (next === "order_form") {
    // The existing manual path: a ready quote's order form (Orders "Send order form"), else the quote editor.
    const [q] = await db.select({ id: quotes.id }).from(quotes)
      .where(and(eq(quotes.accountId, accountId), eq(quotes.leadId, leadId), inArray(quotes.status, ["draft", "sent"])))
      .orderBy(desc(quotes.createdAt)).limit(1);
    if (!q) return { ok: true, leadId, outcome, next, orderForm: "no_quote" };
    const f = await createOrderForm(db, accountId, { kind: "human", userId: a.user.id, actingAs: a.actingAs }, q.id, {}, now);
    if (!f.ok) return { ok: true, leadId, outcome, next, orderForm: f.reason };
    const posted = await offerOrderFormInChat(db, actor, accountId, f.form.leadId ?? leadId, f.url, { ...deps, now });
    return { ok: true, leadId, outcome, next, orderForm: "sent", sms: posted.sms };
  }
  return { ok: true, leadId, outcome, next };
}

/**
 * The agent's context line for the latest logged call of the lead (it reads
 * the note before it continues), or null. Only "We spoke" and "No answer".
 */
export function teamCallLogLine(c: CallbackRequest | null, timeLocal: (at: Date) => string): string | null {
  const log = c?.log;
  if (!c || !log || log.outcome === "moved") return null;
  if (log.outcome === "no_answer") return `The team called the buyer on ${timeLocal(log.startedAt)} and there was no answer. The buyer got a text message with a link to pick a new time.${log.note ? ` Note from the team: ${log.note}` : ""}`;
  return `The team spoke with the buyer on the phone on ${timeLocal(log.startedAt)}${log.lengthMin ? ` (${log.lengthMin} min)` : ""}.${log.note ? ` Note from the team, read it before you continue: ${log.note}` : ""}`;
}

/** The lead's call for the agent's context: its latest log (for the note) whether or not the call is still active. */
export async function leadCallForContext(db: Db, accountId: string, leadId: string): Promise<CallbackRequest | null> {
  const rows = await db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES])));
  return currentCallbackOf(rows);
}

/** The lead's call waiting for "Log the call", or null. */
export async function callToLog(db: Db, accountId: string, leadId: string, now = new Date()): Promise<CallbackRequest | null> {
  const c = await leadCallForContext(db, accountId, leadId);
  return callNeedsLog(c, now) ? c : null;
}
