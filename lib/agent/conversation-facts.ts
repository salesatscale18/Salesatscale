/**
 * The facts of a conversation as data (owner decision 3, 27 Nov, agreed with the Voice session): the buyer's
 * latest live quotes, the offers made on them and how each stands, and the order form. One builder for chat and
 * calls: the chat turn renders it into its per-turn context (renderConversationFacts), the voice call reads the
 * same data. Plain facts only: labels and values, no instructions.
 *
 * - Quotes: the lead's live quotes (not cancelled or replaced), newest first, at most MAX_FACT_QUOTES, each at its
 *   current version with its lines (code, name, quantity, line price), totals and valid-until (the quote market's
 *   date). A quote held for the seller's approval is marked `held`: its figures are data, never figures a reply may
 *   state (conversationFactsFigures keeps them apart).
 * - Offers: every offer made on the lead (check_offer results), oldest first, with its outcome (offer-records.ts
 *   offerHistory: offered, accepted, not taken, expired, needs approval).
 * - Order form: the lead's latest order form that was not replaced, with its quote and status, and the order.
 * Reads only; every read is scoped by account.
 */
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { catalogItems, conversations, leads, markets, orderForms, orders, quoteLines, quoteVersions, quotes, sellerAccounts, type QuoteStatus } from "@/db/schema";
import { formatMoney } from "@/lib/domain/money";
import { localDateIso } from "@/lib/format";
import { marketTimezone } from "@/lib/markets/settings";
import { sentDraftQuoteIds } from "@/lib/quotes/service";
import { leadOfferCalls, offerHistory } from "./offer-records";
import type { OfferOutcome } from "./offers";

/** At most this many live quotes in the facts, newest first. */
export const MAX_FACT_QUOTES = 3;

export type FactQuoteLine = {
  code: string;
  name: string;
  qty: number;
  charge: "one-time" | "monthly" | "yearly";
  /** The line's price as the quote states it (its total for the quantity), or null while the seller has to price it. */
  price: string | null;
};

export type FactQuote = {
  /** "Q-1012" */
  number: string;
  version: number;
  /** "sent": the buyer has it; "ready": made, not sent yet; "awaiting_approval": held for the seller's approval. */
  status: "sent" | "ready" | "awaiting_approval";
  /** Held for the seller's approval: its figures may not be stated yet. */
  held: boolean;
  currency: string;
  lines: FactQuoteLine[];
  totals: {
    /** The one-time total including VAT (null while a line is still to be priced). */
    todayIncludingVat: string | null;
    /** The recurring total including VAT, with its period (null when there are no recurring lines). */
    recurringIncludingVat: string | null;
    /** The discount on the one-time charges, in percent (0 = none). */
    discountPercent: number;
  };
  /** "YYYY-MM-DD" in the quote market's time zone. */
  validUntil: string;
};

export type FactOffer = {
  /** "OF-1a2b3c" */
  id: string;
  /** The offer's plain terms, as check_offer gave them. */
  terms: string;
  /** The quote it was made on: "Q-1012 v1". */
  quote: string;
  outcome: OfferOutcome;
};

export type FactOrderForm = {
  /** The quote it is for: "Q-1012 v2". */
  quote: string;
  status: "sent" | "opened" | "signed" | "link_expired";
  /** For a quote version that is no longer the latest live quote's current one. */
  outdated: boolean;
  /** The order exists (signed) and whether it is paid. */
  signed: boolean;
  paid: boolean;
};

export type ConversationFacts = {
  quotes: FactQuote[];
  offers: FactOffer[];
  orderForm: FactOrderForm | null;
};

export const NO_FACTS: ConversationFacts = { quotes: [], offers: [], orderForm: null };

const chargeOf = (chargeType: string, period: string | null): FactQuoteLine["charge"] =>
  chargeType === "one_time" ? "one-time" : period === "year" ? "yearly" : "monthly";

/** The facts of a conversation (its lead's quotes, offers and order form). NO_FACTS when it is not this account's. */
export async function conversationFacts(db: Db, accountId: string, conversationId: string): Promise<ConversationFacts> {
  const [conv] = await db.select({ leadId: conversations.leadId }).from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!conv) return NO_FACTS;
  return leadFacts(db, accountId, conv.leadId);
}

/** The facts of a lead (every conversation of the lead: quotes and offers belong to the lead). */
export async function leadFacts(db: Db, accountId: string, leadId: string): Promise<ConversationFacts> {
  const [live, calls, [form], [order], [account], [ofLead]] = await Promise.all([
    db.select({ q: quotes, v: quoteVersions }).from(quotes)
      .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion), eq(quoteVersions.accountId, accountId)))
      .where(and(eq(quotes.accountId, accountId), eq(quotes.leadId, leadId), notInArray(quotes.status, ["cancelled", "replaced"])))
      .orderBy(desc(quotes.number)).limit(MAX_FACT_QUOTES),
    leadOfferCalls(db, accountId, leadId),
    db.select({ status: orderForms.status, quoteId: orderForms.quoteId, number: quotes.number, version: quoteVersions.version })
      .from(orderForms)
      .innerJoin(quotes, and(eq(quotes.id, orderForms.quoteId), eq(quotes.accountId, accountId)))
      .innerJoin(quoteVersions, and(eq(quoteVersions.id, orderForms.quoteVersionId), eq(quoteVersions.accountId, accountId)))
      .where(and(eq(orderForms.accountId, accountId), eq(orderForms.leadId, leadId), isNull(orderForms.supersededById)))
      .orderBy(desc(orderForms.createdAt)).limit(1),
    db.select({ paymentStatus: orders.paymentStatus }).from(orders)
      .where(and(eq(orders.accountId, accountId), eq(orders.leadId, leadId))).orderBy(desc(orders.createdAt)).limit(1),
    db.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ market: markets }).from(markets).innerJoin(leads, eq(leads.marketId, markets.id))
      .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId), eq(markets.accountId, accountId))),
  ]);
  const zoneOf = new Map<string | null, string>();
  const tz = async (marketId: string | null): Promise<string> => {
    if (!account) return "UTC";
    if (zoneOf.has(marketId)) return zoneOf.get(marketId)!;
    const market = marketId === null
      ? null
      : ofLead?.market.id === marketId
        ? ofLead.market
        : (await db.select().from(markets).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId))))[0] ?? null;
    const zone = marketTimezone(account, market);
    zoneOf.set(marketId, zone);
    return zone;
  };

  const versionIds = live.map((r) => r.v.id);
  const lineRows = versionIds.length
    ? await db.select().from(quoteLines).where(and(eq(quoteLines.accountId, accountId), inArray(quoteLines.quoteVersionId, versionIds))).orderBy(quoteLines.sortOrder)
    : [];
  const itemIds = [...new Set(lineRows.map((l) => l.catalogItemId).filter((x): x is string => !!x))];
  const plain = new Map((itemIds.length
    ? await db.select({ id: catalogItems.id, plainName: catalogItems.plainName }).from(catalogItems).where(and(eq(catalogItems.accountId, accountId), inArray(catalogItems.id, itemIds)))
    : []).map((i) => [i.id, i.plainName?.trim() || null]));
  // Drafts the app already sent show as sent (lib/quotes/service.ts sentDraftQuoteIds).
  const sent = await sentDraftQuoteIds(db, accountId, live.map((r) => ({ id: r.q.id, number: r.q.number, status: r.q.status as QuoteStatus, currentVersion: r.q.currentVersion })));

  const quoteFacts: FactQuote[] = [];
  for (const { q, v } of live) {
    const money = (m: number, period?: "month" | "year") => formatMoney(m, v.currency, period ? { period } : {});
    const lines = lineRows.filter((l) => l.quoteVersionId === v.id).map((l): FactQuoteLine => ({
      code: l.sku,
      name: (l.catalogItemId ? plain.get(l.catalogItemId) : null) ?? l.name,
      qty: l.qty,
      charge: chargeOf(l.chargeType, l.period),
      price: l.lineTotalMinor === null ? null : money(l.lineTotalMinor, l.chargeType === "one_time" ? undefined : l.period === "year" ? "year" : "month"),
    }));
    const held = q.status === "awaiting_approval";
    const complete = lines.every((l) => l.price !== null);
    quoteFacts.push({
      number: `Q-${q.number}`, version: v.version,
      status: held ? "awaiting_approval" : q.status === "sent" || sent.has(q.id) ? "sent" : "ready",
      held, currency: v.currency, lines,
      totals: {
        todayIncludingVat: complete ? money(v.oneTimeTotalMinor) : null,
        recurringIncludingVat: v.recurringTotalMinor > 0 ? money(v.recurringTotalMinor, v.recurringPeriod === "year" ? "year" : "month") : null,
        discountPercent: v.discountBp / 100,
      },
      validUntil: localDateIso(v.validUntil, await tz(v.marketId)),
    });
  }

  const offers: FactOffer[] = offerHistory(calls, new Date()).map((h) => ({
    id: h.record.id, terms: h.record.terms, quote: `Q-${h.record.quoteNumber} v${h.record.quoteVersion}`, outcome: h.outcome,
  }));

  const latest = live[0];
  const orderForm: FactOrderForm | null = form
    ? {
        quote: `Q-${form.number} v${form.version}`,
        status: form.status,
        outdated: !latest || latest.q.id !== form.quoteId || latest.q.currentVersion !== form.version,
        signed: !!order,
        paid: order?.paymentStatus === "paid",
      }
    : null;
  return { quotes: quoteFacts, offers, orderForm };
}

const STATUS_TEXT: Record<FactQuote["status"], string> = {
  sent: "sent to the buyer",
  ready: "ready, not sent yet",
  awaiting_approval: "waiting for the seller's approval",
};
const OUTCOME_TEXT: Record<OfferOutcome, string> = {
  offered: "open",
  needs_approval: "open; a larger discount waits for the seller's approval",
  accepted: "accepted",
  not_taken: "not taken (a later offer followed)",
  expired: "expired",
};
const FORM_TEXT: Record<FactOrderForm["status"], string> = {
  sent: "sent, not opened yet",
  opened: "opened, not signed yet",
  signed: "signed",
  link_expired: "link expired",
};

/**
 * The facts as plain text (pure): labels and values only, no instructions. "" when there is nothing (no quote, no
 * offer, no order form). A quote held for approval shows its lines without prices and no totals.
 */
export function renderConversationFacts(f: ConversationFacts): string {
  const out: string[] = [];
  if (f.quotes.length) {
    out.push("Quotes (newest first):");
    for (const q of f.quotes) {
      out.push(`- ${q.number} v${q.version}. Status: ${STATUS_TEXT[q.status]}.${q.held ? "" : ` Valid until: ${q.validUntil}.`}`);
      out.push(`  Lines: ${q.lines.map((l) => `${l.qty} × ${l.code} (${l.name}), ${l.charge}${q.held ? "" : `: ${l.price ?? "priced by the seller"}`}`).join("; ")}.`);
      if (q.held) out.push("  Totals: not final until the seller approves.");
      else {
        const t = [
          `today ${q.totals.todayIncludingVat ?? "to be priced by the seller"} including VAT`,
          q.totals.recurringIncludingVat ? `recurring ${q.totals.recurringIncludingVat} including VAT` : "",
          q.totals.discountPercent > 0 ? `discount ${q.totals.discountPercent}% off the one-time charges` : "",
        ].filter(Boolean);
        out.push(`  Totals: ${t.join("; ")}.`);
      }
    }
  }
  if (f.offers.length) {
    out.push("Offers made (oldest first):");
    for (const o of f.offers) out.push(`- ${o.id} on ${o.quote}: ${o.terms} Outcome: ${OUTCOME_TEXT[o.outcome]}.`);
  }
  if (f.orderForm) {
    const o = f.orderForm;
    out.push(`Order form: for ${o.quote}, ${FORM_TEXT[o.status]}${o.outdated ? "; for an earlier quote or version" : ""}.${o.signed ? ` Order: signed, ${o.paid ? "paid" : "not paid yet"}.` : ""}`);
  }
  return out.length ? `## Facts of this conversation\n${out.join("\n")}` : "";
}

/**
 * The facts' figures for the reply figure check (pure): `allowed`, what a reply may restate (quotes not held, the
 * offers' terms); `held`, the figures of quotes held for the seller's approval, which stay withheld.
 */
export function conversationFactsFigures(f: ConversationFacts): { allowed: unknown[]; held: unknown[] } {
  const figures = (q: FactQuote) => ({ lines: q.lines.map((l) => l.price), totals: q.totals });
  return {
    allowed: [...f.quotes.filter((q) => !q.held).map(figures), ...f.offers.map((o) => o.terms)],
    held: f.quotes.filter((q) => q.held).map(figures),
  };
}
