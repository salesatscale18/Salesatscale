/**
 * Seller Overview (P9.2): the "Needs you" queue, period numbers and recent
 * activity. Everything is scoped by account and leaves out test leads.
 * Read-only: derived from leads, quotes, order forms, orders and lead events.
 */
import { cache } from "react";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sum } from "drizzle-orm";
import type { Db } from "@/db/types";
import { failedFollowUps, failedFollowUpWhere } from "@/lib/follow-ups/schedule";
import { requestedCallbacks } from "@/lib/callbacks/service";
import { marketKey, marketWhere } from "@/lib/markets/selection";
import { priceListVersions } from "@/lib/pricing/price-lists";
import {
  followUps, leadEvents, leads, orderForms, orders, quotes, quoteVersions, users,
  type ApprovalReason, type LeadEvent, type Market, type User,
} from "@/db/schema";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** `marketId` is the lead's market (null = the home market), for the market filter and the market cards. */
type LeadRef = { leadId: string; leadName: string; company: string | null; marketId: string | null };

/** One thing a person on the seller's team should act on. `at` is when it started needing them. */
export type NeedsYouItem = LeadRef & { id: string; at: Date } & (
  | { kind: "quote_approval"; quoteId: string; quoteNumber: number; version: number; reasons: ApprovalReason[] }
  | { kind: "human_handling" }
  | { kind: "bank_transfer"; quoteId: string; orderId: string; orderNumber: number; amountMinor: number; currency: string }
  | { kind: "payment_failed"; quoteId: string; orderId: string; orderNumber: number; amountMinor: number; currency: string }
  | { kind: "form_unsigned"; quoteId: string; formId: string; quoteNumber: number; openedAt: Date }
  | { kind: "form_expiring"; quoteId: string; formId: string; quoteNumber: number; expiresAt: Date }
  | { kind: "follow_up_failed"; followUpId: string; dueAt: Date; reason: string | null }
  /** O6: the agent took a time for a call; the seller confirms or changes it. `timezone` is the zone the time was set in. */
  | { kind: "callback_requested"; callbackId: string; callAt: Date; timezone: string; brief: string }
);

export type NeedsYouKind = NeedsYouItem["kind"];

/** An opened form counts as "not signed" once it has waited this long. */
export const UNSIGNED_AFTER_MS = DAY_MS;
/** A form counts as "expiring" when its link ends within this window. */
export const EXPIRING_WITHIN_MS = DAY_MS;

const leadCols = { leadId: leads.id, leadName: leads.fullName, company: leads.company, marketId: leads.marketId };

/*
 * The four sources of "Needs you". `needsYou` (full items) and `needsYouCount`
 * (the nav badge) share these filters so the count always equals the list length.
 */
const notTest = eq(leads.isTest, false);
const approvalWhere = (accountId: string) => and(eq(quotes.accountId, accountId), eq(quotes.status, "awaiting_approval"), notTest);
const handedWhere = (accountId: string) => and(eq(leads.accountId, accountId), eq(leads.status, "human_handling"), notTest);
const orderWhere = (accountId: string) =>
  and(eq(orders.accountId, accountId), inArray(orders.paymentStatus, ["bank_transfer_expected", "failed"]), notTest);
/** Open, unsigned, unexpired forms of live quotes (before the expiring / long-unsigned split). */
const openFormWhere = (accountId: string, now: Date) =>
  and(
    eq(orderForms.accountId, accountId),
    inArray(orderForms.status, ["sent", "opened"]),
    isNull(orderForms.supersededById),
    isNull(orderForms.signedAt),
    gt(orderForms.expiresAt, now),
    ne(quotes.status, "cancelled"),
    notTest,
  );

/** The "Needs you" queue for one account, newest first. Selects only the columns it shows (never the form snapshot). */
export async function needsYou(db: Db, accountId: string, now: Date): Promise<NeedsYouItem[]> {
  const [approvals, handed, orderRows, formRows, failedRows] = await Promise.all([
    db
      .select({
        ...leadCols,
        quote: { id: quotes.id, number: quotes.number },
        version: { version: quoteVersions.version, createdAt: quoteVersions.createdAt, approvalReasons: quoteVersions.approvalReasons },
      })
      .from(quotes)
      .innerJoin(leads, eq(leads.id, quotes.leadId))
      .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
      .where(approvalWhere(accountId)),
    db
      .select({ ...leadCols, at: leads.lastActivityAt })
      .from(leads)
      .where(handedWhere(accountId)),
    db
      .select({
        ...leadCols,
        order: {
          id: orders.id, quoteId: orders.quoteId, number: orders.number, paymentStatus: orders.paymentStatus,
          amountDueMinor: orders.amountDueMinor, currency: orders.currency, updatedAt: orders.updatedAt,
        },
      })
      .from(orders)
      .innerJoin(leads, eq(leads.id, orders.leadId))
      .where(orderWhere(accountId)),
    db
      .select({
        ...leadCols,
        form: { id: orderForms.id, quoteId: orderForms.quoteId, status: orderForms.status, expiresAt: orderForms.expiresAt, openedAt: orderForms.openedAt },
        quoteNumber: quotes.number,
      })
      .from(orderForms)
      .innerJoin(leads, eq(leads.id, orderForms.leadId))
      .innerJoin(quotes, eq(quotes.id, orderForms.quoteId))
      .where(openFormWhere(accountId, now)),
    // An agreed follow-up that could not be sent (lib/follow-ups): someone should write to the buyer.
    failedFollowUps(db, accountId, now),
  ]);
  // A call request waiting for the seller (lib/callbacks, O6).
  const callbacks = await requestedCallbacks(db, accountId, now);

  const items: NeedsYouItem[] = [];
  const ref = (r: LeadRef): LeadRef => ({ leadId: r.leadId, leadName: r.leadName, company: r.company, marketId: r.marketId });

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
  for (const r of failedRows) {
    const f = r.followUp;
    items.push({
      leadId: f.leadId, leadName: r.leadName, company: r.company, marketId: r.marketId, kind: "follow_up_failed", id: `follow_up:${f.id}`, at: f.updatedAt,
      followUpId: f.id, dueAt: f.dueAt, reason: f.reason,
    });
  }
  for (const c of callbacks) {
    items.push({
      leadId: c.leadId, leadName: c.leadName, company: c.company, marketId: c.marketId, kind: "callback_requested", id: `callback:${c.id}`, at: c.requestedAt,
      callbackId: c.id, callAt: c.at, timezone: c.timezone, brief: c.brief,
    });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
}

/** needsYou at the current time, cached per request (the Overview list). */
export const needsYouForRequest = cache((db: Db, accountId: string) => needsYou(db, accountId, new Date()));

/**
 * How many items `needsYou` would return, as counts only (no rows, no
 * snapshot). Forms count when they are expiring within EXPIRING_WITHIN_MS or
 * were opened more than UNSIGNED_AFTER_MS ago, matching needsYou's split.
 */
export async function needsYouCount(db: Db, accountId: string, now: Date): Promise<number> {
  const expiringBy = new Date(now.getTime() + EXPIRING_WITHIN_MS);
  const openedBefore = new Date(now.getTime() - UNSIGNED_AFTER_MS);
  const [[a], [h], [o], [f], [u]] = await Promise.all([
    db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId))
      .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
      .where(approvalWhere(accountId)),
    db.select({ n: count() }).from(leads).where(handedWhere(accountId)),
    db.select({ n: count() }).from(orders).innerJoin(leads, eq(leads.id, orders.leadId)).where(orderWhere(accountId)),
    db.select({ n: count() }).from(orderForms)
      .innerJoin(leads, eq(leads.id, orderForms.leadId))
      .innerJoin(quotes, eq(quotes.id, orderForms.quoteId))
      .where(
        and(
          openFormWhere(accountId, now),
          or(
            lte(orderForms.expiresAt, expiringBy),
            and(eq(orderForms.status, "opened"), isNotNull(orderForms.openedAt), lt(orderForms.openedAt, openedBefore)),
          ),
        ),
      ),
    db.select({ n: count() }).from(followUps).innerJoin(leads, eq(leads.id, followUps.leadId)).where(failedFollowUpWhere(accountId, now)),
  ]);
  // Call requests are folded from lead events (lib/callbacks), so they are counted from the same read as the list.
  const c = (await requestedCallbacks(db, accountId, now)).length;
  return a.n + h.n + o.n + f.n + u.n + c;
}

/** needsYouCount at the current time, cached per request (the nav badge in the layout). */
export const needsYouCountForRequest = cache((db: Db, accountId: string) => needsYouCount(db, accountId, new Date()));

/** Where each item's action goes, under the account base path (`/app/<slug>`). */
export function needsYouHref(base: string, item: NeedsYouItem): string {
  switch (item.kind) {
    case "human_handling":
    case "follow_up_failed":
    case "callback_requested":
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
  /**
   * Sum of one-time amounts of orders paid in the period, in minor units. Only
   * meaningful with one currency: amounts are never added across currencies,
   * so read `paidByCurrency` wherever orders can be in several.
   */
  paidRevenueMinor: number;
  /** Recurring amounts of those orders (per month). Same caveat. */
  paidRecurringMinor: number;
  /** Paid orders of the period per currency (sorted by currency code): one line each on the "Paid revenue" tile. */
  paidByCurrency: CurrencyTotal[];
};

export type CurrencyTotal = { currency: string; oneTimeMinor: number; recurringMinor: number };

/** Simulated buyers (buyer simulator, leads.buyer_ref) are left out of the numbers unless the seller asks for them. */
export type SimulatedFilter = { includeSimulated?: boolean };
/** Overview filters: simulated buyers, and the market switcher's choice (null or missing = all markets; by the lead's market). */
export type OverviewFilter = SimulatedFilter & { market?: Pick<Market, "id" | "isHome"> | null };
const realOnly = (opts: SimulatedFilter) => and(eq(leads.isTest, false), opts.includeSimulated ? undefined : isNull(leads.buyerRef))!;

/**
 * What happened in (from, to]: each step counted by when it happened, not as
 * a cohort. Test leads are left out everywhere; simulated buyers unless `includeSimulated`.
 */
export async function overviewKpis(db: Db, accountId: string, range: { from: Date; to: Date }, opts: OverviewFilter = {}): Promise<OverviewKpis> {
  const notTest = and(realOnly(opts), marketWhere(leads.marketId, opts.market ?? null))!;
  const inRange = (col: Parameters<typeof gt>[0]) => and(gt(col, range.from), lte(col, range.to));
  const [[l], [q], [fs], [sg], pd] = await Promise.all([
    db.select({ n: count() }).from(leads).where(and(eq(leads.accountId, accountId), notTest, inRange(leads.createdAt))),
    db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId))
      .where(and(eq(quotes.accountId, accountId), notTest, inRange(quotes.createdAt))),
    db.select({ n: count() }).from(orderForms).innerJoin(leads, eq(leads.id, orderForms.leadId))
      .where(and(eq(orderForms.accountId, accountId), notTest, inRange(orderForms.createdAt))),
    db.select({ n: count() }).from(orderForms).innerJoin(leads, eq(leads.id, orderForms.leadId))
      .where(and(eq(orderForms.accountId, accountId), notTest, eq(orderForms.status, "signed"), inRange(orderForms.signedAt))),
    db.select({ currency: orders.currency, n: count(), oneTime: sum(orders.amountDueMinor), recurring: sum(orders.recurringMinor) }).from(orders)
      .innerJoin(leads, eq(leads.id, orders.leadId))
      .where(and(eq(orders.accountId, accountId), notTest, eq(orders.paymentStatus, "paid"), inRange(orders.paidAt)))
      .groupBy(orders.currency),
  ]);
  const paidByCurrency = pd
    .map((r) => ({ currency: r.currency, oneTimeMinor: Number(r.oneTime ?? 0), recurringMinor: Number(r.recurring ?? 0) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    newLeads: l.n,
    quotesCreated: q.n,
    formsSent: fs.n,
    formsSigned: sg.n,
    paidOrders: pd.reduce((n, r) => n + r.n, 0),
    paidRevenueMinor: paidByCurrency.reduce((n, r) => n + r.oneTimeMinor, 0),
    paidRecurringMinor: paidByCurrency.reduce((n, r) => n + r.recurringMinor, 0),
    paidByCurrency,
  };
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export type RecentEvent = { event: LeadEvent; lead: { id: string; fullName: string; company: string | null }; user: User | null };

/** The latest lead events across the account, test leads left out (simulated buyers unless `includeSimulated`). */
export async function recentActivity(db: Db, accountId: string, limit = 10, opts: OverviewFilter = {}): Promise<RecentEvent[]> {
  return db
    .select({ event: leadEvents, lead: { id: leads.id, fullName: leads.fullName, company: leads.company }, user: users })
    .from(leadEvents)
    .innerJoin(leads, eq(leads.id, leadEvents.leadId))
    .leftJoin(users, eq(users.id, leadEvents.actorUserId))
    .where(and(eq(leadEvents.accountId, accountId), realOnly(opts), marketWhere(leads.marketId, opts.market ?? null)))
    .orderBy(desc(leadEvents.createdAt), desc(leadEvents.id))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Market cards ("Your markets")
// ---------------------------------------------------------------------------

/** Lead statuses that are finished: everything else is an open lead. */
export const CLOSED_LEAD_STATUSES = ["won", "lost", "opted_out"] as const;

/**
 * Open leads (not won, lost or opted out) per market id, test leads left out
 * (simulated buyers unless `includeSimulated`). Leads without a market count
 * for the home market. Markets without open leads are missing (read as 0).
 */
export async function openLeadsByMarket(db: Db, accountId: string, homeMarketId: string, opts: SimulatedFilter = {}): Promise<Map<string, number>> {
  const rows = await db
    .select({ marketId: leads.marketId, n: count() })
    .from(leads)
    .where(and(eq(leads.accountId, accountId), realOnly(opts), notInArray(leads.status, [...CLOSED_LEAD_STATUSES])))
    .groupBy(leads.marketId);
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = marketKey(r.marketId, homeMarketId);
    out.set(k, (out.get(k) ?? 0) + r.n);
  }
  return out;
}

/** Each market's share of the "Needs you" items, per market id (items of leads without a market count for the home market). */
export function needsYouByMarket(items: readonly Pick<NeedsYouItem, "marketId">[], homeMarketId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    const k = marketKey(it.marketId, homeMarketId);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * The currency a market sells in: its price list's (the live version, else the
 * newest one not archived, as the market's settings read it), else `fallback`
 * (the account currency). Overview's "Paid revenue" shows 0 in it when the
 * market has nothing paid yet (W6: £0.00 for the UK, not ₪0.00).
 */
export async function marketCurrency(db: Db, accountId: string, market: Pick<Market, "priceListLineageId">, fallback: string): Promise<string> {
  if (!market.priceListLineageId) return fallback;
  const versions = await priceListVersions(db, accountId, market.priceListLineageId);
  const list = versions.find((v) => v.status === "live") ?? versions.find((v) => v.status !== "archived");
  return list?.currency ?? fallback;
}
