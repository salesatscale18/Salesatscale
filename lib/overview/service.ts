/**
 * Seller Overview (P9.2): the "Needs you" queue, period numbers and recent
 * activity. Everything is scoped by account and leaves out test leads.
 * Read-only: derived from leads, quotes, order forms, orders and lead events.
 */
import { cache } from "react";
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, sum } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  leadEvents, leads, orderForms, orders, quotes, quoteVersions, users,
  type ApprovalReason, type LeadEvent, type User,
} from "@/db/schema";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type LeadRef = { leadId: string; leadName: string; company: string | null };

/** One thing a person on the seller's team should act on. `at` is when it started needing them. */
export type NeedsYouItem = LeadRef & { id: string; at: Date } & (
  | { kind: "quote_approval"; quoteId: string; quoteNumber: number; version: number; reasons: ApprovalReason[] }
  | { kind: "human_handling" }
  | { kind: "bank_transfer"; quoteId: string; orderId: string; orderNumber: number; amountMinor: number; currency: string }
  | { kind: "payment_failed"; quoteId: string; orderId: string; orderNumber: number; amountMinor: number; currency: string }
  | { kind: "form_unsigned"; quoteId: string; formId: string; quoteNumber: number; openedAt: Date }
  | { kind: "form_expiring"; quoteId: string; formId: string; quoteNumber: number; expiresAt: Date }
);

export type NeedsYouKind = NeedsYouItem["kind"];

/** An opened form counts as "not signed" once it has waited this long. */
export const UNSIGNED_AFTER_MS = DAY_MS;
/** A form counts as "expiring" when its link ends within this window. */
export const EXPIRING_WITHIN_MS = DAY_MS;

const leadCols = { leadId: leads.id, leadName: leads.fullName, company: leads.company };

/** The "Needs you" queue for one account, newest first. */
export async function needsYou(db: Db, accountId: string, now: Date): Promise<NeedsYouItem[]> {
  const notTest = eq(leads.isTest, false);
  const [approvals, handed, orderRows, formRows] = await Promise.all([
    db
      .select({ ...leadCols, quote: quotes, version: quoteVersions })
      .from(quotes)
      .innerJoin(leads, eq(leads.id, quotes.leadId))
      .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
      .where(and(eq(quotes.accountId, accountId), eq(quotes.status, "awaiting_approval"), notTest)),
    db
      .select({ ...leadCols, at: leads.lastActivityAt })
      .from(leads)
      .where(and(eq(leads.accountId, accountId), eq(leads.status, "human_handling"), notTest)),
    db
      .select({ ...leadCols, order: orders })
      .from(orders)
      .innerJoin(leads, eq(leads.id, orders.leadId))
      .where(and(eq(orders.accountId, accountId), inArray(orders.paymentStatus, ["bank_transfer_expected", "failed"]), notTest)),
    db
      .select({ ...leadCols, form: orderForms, quoteNumber: quotes.number })
      .from(orderForms)
      .innerJoin(leads, eq(leads.id, orderForms.leadId))
      .innerJoin(quotes, eq(quotes.id, orderForms.quoteId))
      .where(
        and(
          eq(orderForms.accountId, accountId),
          inArray(orderForms.status, ["sent", "opened"]),
          isNull(orderForms.supersededById),
          isNull(orderForms.signedAt),
          gt(orderForms.expiresAt, now),
          ne(quotes.status, "cancelled"),
          notTest,
        ),
      ),
  ]);

  const items: NeedsYouItem[] = [];
  const ref = (r: LeadRef): LeadRef => ({ leadId: r.leadId, leadName: r.leadName, company: r.company });

  for (const r of approvals) {
    items.push({
      ...ref(r), kind: "quote_approval", id: `quote:${r.quote.id}`, at: r.version.createdAt,
      quoteId: r.quote.id, quoteNumber: r.quote.number, version: r.version.version, reasons: r.version.approvalReasons,
    });
  }
  for (const r of handed) items.push({ ...ref(r), kind: "human_handling", id: `lead:${r.leadId}`, at: r.at });
  for (const r of orderRows) {
    const o = r.order;
    const kind = o.paymentStatus === "failed" ? "payment_failed" : "bank_transfer";
    items.push({
      ...ref(r), kind, id: `${kind}:${o.id}`, at: o.updatedAt,
      quoteId: o.quoteId, orderId: o.id, orderNumber: o.number, amountMinor: o.amountDueMinor, currency: o.currency,
    });
  }
  for (const r of formRows) {
    const f = r.form;
    const base = { ...ref(r), quoteId: f.quoteId, formId: f.id, quoteNumber: r.quoteNumber };
    // A form that is both expiring and long unsigned shows once, as expiring (the more urgent).
    if (f.expiresAt.getTime() - now.getTime() <= EXPIRING_WITHIN_MS) {
      items.push({ ...base, kind: "form_expiring", id: `form:${f.id}`, at: new Date(f.expiresAt.getTime() - EXPIRING_WITHIN_MS), expiresAt: f.expiresAt });
    } else if (f.status === "opened" && f.openedAt && now.getTime() - f.openedAt.getTime() > UNSIGNED_AFTER_MS) {
      items.push({ ...base, kind: "form_unsigned", id: `form:${f.id}`, at: new Date(f.openedAt.getTime() + UNSIGNED_AFTER_MS), openedAt: f.openedAt });
    }
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
}

/** needsYou at the current time, shared by the layout (nav badge) and the Overview within one request. */
export const needsYouForRequest = cache((db: Db, accountId: string) => needsYou(db, accountId, new Date()));

/** Where each item's action goes, under the account base path (`/app/<slug>`). */
export function needsYouHref(base: string, item: NeedsYouItem): string {
  switch (item.kind) {
    case "human_handling":
      return `${base}/leads/${item.leadId}`;
    case "quote_approval":
      return `${base}/orders?tab=approval&quote=${item.quoteId}`;
    case "bank_transfer":
    case "payment_failed":
      return `${base}/orders?tab=orders&quote=${item.quoteId}`;
    default:
      return `${base}/orders?quote=${item.quoteId}`;
  }
}

// ---------------------------------------------------------------------------
// Period numbers
// ---------------------------------------------------------------------------

export const PERIODS = [7, 30] as const;
export type PeriodDays = (typeof PERIODS)[number];

/** `?period=` → 7 or 30 days (default 30). */
export function parsePeriod(raw: string | undefined): PeriodDays {
  return raw === "7" ? 7 : 30;
}

export function periodRange(days: PeriodDays, now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

export type OverviewKpis = {
  newLeads: number;
  quotesCreated: number;
  formsSent: number;
  formsSigned: number;
  paidOrders: number;
  /** Sum of one-time amounts of orders paid in the period, in the account currency's minor units. */
  paidRevenueMinor: number;
  /** Recurring amounts of those orders (per month). */
  paidRecurringMinor: number;
};

/**
 * What happened in (from, to]: each step counted by when it happened, not as
 * a cohort. Test leads are left out everywhere.
 */
export async function overviewKpis(db: Db, accountId: string, range: { from: Date; to: Date }): Promise<OverviewKpis> {
  const notTest = eq(leads.isTest, false);
  const inRange = (col: Parameters<typeof gt>[0]) => and(gt(col, range.from), lte(col, range.to));
  const [[l], [q], [fs], [sg], [pd]] = await Promise.all([
    db.select({ n: count() }).from(leads).where(and(eq(leads.accountId, accountId), notTest, inRange(leads.createdAt))),
    db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId))
      .where(and(eq(quotes.accountId, accountId), notTest, inRange(quotes.createdAt))),
    db.select({ n: count() }).from(orderForms).innerJoin(leads, eq(leads.id, orderForms.leadId))
      .where(and(eq(orderForms.accountId, accountId), notTest, inRange(orderForms.createdAt))),
    db.select({ n: count() }).from(orderForms).innerJoin(leads, eq(leads.id, orderForms.leadId))
      .where(and(eq(orderForms.accountId, accountId), notTest, eq(orderForms.status, "signed"), inRange(orderForms.signedAt))),
    db.select({ n: count(), oneTime: sum(orders.amountDueMinor), recurring: sum(orders.recurringMinor) }).from(orders)
      .innerJoin(leads, eq(leads.id, orders.leadId))
      .where(and(eq(orders.accountId, accountId), notTest, eq(orders.paymentStatus, "paid"), inRange(orders.paidAt))),
  ]);
  return {
    newLeads: l.n,
    quotesCreated: q.n,
    formsSent: fs.n,
    formsSigned: sg.n,
    paidOrders: pd.n,
    paidRevenueMinor: Number(pd.oneTime ?? 0),
    paidRecurringMinor: Number(pd.recurring ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export type RecentEvent = { event: LeadEvent; lead: { id: string; fullName: string; company: string | null }; user: User | null };

/** The latest lead events across the account, test leads left out. */
export async function recentActivity(db: Db, accountId: string, limit = 10): Promise<RecentEvent[]> {
  return db
    .select({ event: leadEvents, lead: { id: leads.id, fullName: leads.fullName, company: leads.company }, user: users })
    .from(leadEvents)
    .innerJoin(leads, eq(leads.id, leadEvents.leadId))
    .leftJoin(users, eq(users.id, leadEvents.actorUserId))
    .where(and(eq(leadEvents.accountId, accountId), eq(leads.isTest, false)))
    .orderBy(desc(leadEvents.createdAt), desc(leadEvents.id))
    .limit(limit);
}
