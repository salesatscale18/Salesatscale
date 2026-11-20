/**
 * Leads V2 list (UX L-3): what a row needs beyond the lead itself, read for
 * the listed leads in a fixed number of queries (no query per lead), every one
 * scoped by account id: the latest live quote (Deal value, Next step), the
 * latest order form and order, and the next scheduled follow-up.
 */
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { followUps, orderFormStatus, orderForms, orders, paymentStatus, quoteVersions, quotes, type QuoteStatus } from "@/db/schema";

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
};

export const NO_FACTS: LeadListFacts = { quote: null, form: null, order: null, followUp: null };

export async function leadListFacts(db: Db, accountId: string, leadIds: readonly string[]): Promise<Map<string, LeadListFacts>> {
  const out = new Map<string, LeadListFacts>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return out;
  const [qs, forms, ords, fus] = await Promise.all([
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
  return out;
}
