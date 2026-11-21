/**
 * Leads V2 list (UX L-3): what a row needs beyond the lead itself, read for
 * the listed leads in a fixed number of queries (no query per lead), every one
 * scoped by account id: the latest live quote (Deal value, Next step), the
 * latest order form and order, the next scheduled follow-up, and a confirmed
 * call still ahead (folded from the leads' call events, lib/callbacks/rules.ts),
 * and who took the chat over (the conversation's taken-over-by: Take over sets
 * it, not the lead's owner).
 */
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, followUps, leadEvents, orderFormStatus, orderForms, orders, paymentStatus, quoteVersions, quotes, users, type QuoteStatus, type User } from "@/db/schema";
import { CALLBACK_EVENT_TYPES, callUpcoming, currentCallbacks } from "@/lib/callbacks/rules";

type OrderFormStatus = (typeof orderFormStatus.enumValues)[number];
type PaymentStatus = (typeof paymentStatus.enumValues)[number];

export type LeadListFacts = {
  quote: {
    number: number; version: number; status: QuoteStatus; currency: string;
    oneTimeMinor: number; recurringMinor: number; recurringPeriod: string | null;
    /** A price is still missing (the quote waits for the seller to price it): no total to show yet. */
    toPrice: boolean;
  } | null;
  form: { status: OrderFormStatus; superseded: boolean; openedAt: Date | null; expiresAt: Date; quoteNumber: number } | null;
  order: { number: number; paymentStatus: PaymentStatus; amountMinor: number; currency: string } | null;
  followUp: { dueAt: Date; topic: string | null } | null;
  /** A booked team call (or a call the seller confirmed) whose slot has not ended. */
  call: { at: Date; brief: string; booked: boolean } | null;
  /**
   * The person who has the chat: the user who took over the lead's conversation
   * that a person now holds (conversations.taken_over_by_user_id, set by takeOver).
   * Null when nobody took it (a hand-off waiting for a person) or the agent has it.
   */
  handler: Pick<User, "id" | "firstName" | "lastName" | "email"> | null;
};

export const NO_FACTS: LeadListFacts = { quote: null, form: null, order: null, followUp: null, call: null, handler: null };

export async function leadListFacts(db: Db, accountId: string, leadIds: readonly string[], now = new Date()): Promise<Map<string, LeadListFacts>> {
  const out = new Map<string, LeadListFacts>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return out;
  const [qs, forms, ords, fus, calls, held] = await Promise.all([
    db.selectDistinctOn([quotes.leadId], {
      leadId: quotes.leadId, number: quotes.number, status: quotes.status, version: quotes.currentVersion,
      currency: quoteVersions.currency, oneTime: quoteVersions.oneTimeTotalMinor, recurring: quoteVersions.recurringTotalMinor,
      period: quoteVersions.recurringPeriod, reasons: quoteVersions.approvalReasons, approvedBy: quoteVersions.approvedByUserId,
    })
      .from(quotes)
      .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
      .where(and(eq(quotes.accountId, accountId), inArray(quotes.leadId, ids), notInArray(quotes.status, ["cancelled", "replaced"])))
      .orderBy(quotes.leadId, desc(quotes.createdAt)),
    db.selectDistinctOn([orderForms.leadId], {
      leadId: orderForms.leadId, status: orderForms.status, supersededById: orderForms.supersededById, openedAt: orderForms.openedAt,
      expiresAt: orderForms.expiresAt, quoteNumber: quotes.number, quoteStatus: quotes.status,
    })
      .from(orderForms)
      .innerJoin(quotes, eq(quotes.id, orderForms.quoteId))
      .where(and(eq(orderForms.accountId, accountId), inArray(orderForms.leadId, ids)))
      .orderBy(orderForms.leadId, desc(orderForms.createdAt)),
    db.selectDistinctOn([orders.leadId], { leadId: orders.leadId, number: orders.number, paymentStatus: orders.paymentStatus, amount: orders.amountDueMinor, currency: orders.currency })
      .from(orders)
      .where(and(eq(orders.accountId, accountId), inArray(orders.leadId, ids)))
      .orderBy(orders.leadId, desc(orders.createdAt)),
    db.selectDistinctOn([followUps.leadId], { leadId: followUps.leadId, dueAt: followUps.dueAt, topic: followUps.topic })
      .from(followUps)
      .where(and(eq(followUps.accountId, accountId), inArray(followUps.leadId, ids), eq(followUps.status, "scheduled")))
      .orderBy(followUps.leadId, asc(followUps.dueAt)),
    // The listed leads' call events in one query; each lead's current request is folded in memory.
    db.select({ type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data })
      .from(leadEvents)
      .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.leadId, ids), inArray(leadEvents.type, [...CALLBACK_EVENT_TYPES]))),
    // Who holds each lead's chat: the latest conversation a person took over (status human).
    db.selectDistinctOn([conversations.leadId], {
      leadId: conversations.leadId, id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email,
    })
      .from(conversations)
      .innerJoin(users, eq(users.id, conversations.takenOverByUserId))
      .where(and(eq(conversations.accountId, accountId), inArray(conversations.leadId, ids), eq(conversations.status, "human")))
      .orderBy(conversations.leadId, desc(conversations.updatedAt)),
  ]);
  const get = (id: string) => {
    let f = out.get(id);
    if (!f) out.set(id, (f = { ...NO_FACTS }));
    return f;
  };
  for (const q of qs) {
    get(q.leadId).quote = {
      number: q.number, version: q.version, status: q.status, currency: q.currency, oneTimeMinor: q.oneTime, recurringMinor: q.recurring,
      recurringPeriod: q.period, toPrice: q.reasons.some((r) => r.kind === "price_missing") && !q.approvedBy,
    };
  }
  for (const f of forms) {
    if (!f.leadId || f.quoteStatus === "cancelled") continue;
    get(f.leadId).form = { status: f.status, superseded: !!f.supersededById, openedAt: f.openedAt, expiresAt: f.expiresAt, quoteNumber: f.quoteNumber };
  }
  for (const o of ords) if (o.leadId) get(o.leadId).order = { number: o.number, paymentStatus: o.paymentStatus, amountMinor: o.amount, currency: o.currency };
  for (const u of fus) if (u.leadId) get(u.leadId).followUp = { dueAt: u.dueAt, topic: u.topic };
  for (const c of currentCallbacks(calls)) {
    if (callUpcoming(c, now)) get(c.leadId).call = { at: c.at, brief: c.brief, booked: c.booked };
  }
  for (const h of held) get(h.leadId).handler = { id: h.id, firstName: h.firstName, lastName: h.lastName, email: h.email };
  return out;
}
