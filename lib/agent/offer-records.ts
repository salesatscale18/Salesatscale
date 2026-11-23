/**
 * Offers made on a deal (offers plan part 2): each offer is the result of an ok
 * check_offer tool call (`result.record`), so no table is needed. Read from the
 * lead's stored tool calls (chat and voice) plus the calls of the turn still
 * running (TurnMemo), because tool calls are stored at the end of a turn.
 *
 * Outcomes are inferred, never stored: accepted = a create_quote that carried
 * the offer id; expired = past the quote's valid-until; needs your approval = a
 * held quote (no offer) made after the latest offer; not taken = a later offer
 * was asked for; else offered.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, toolCalls } from "@/db/schema";
import type { OfferOutcome } from "./offers";
import { isOfferType, type OfferType } from "./offer-settings";

/** A stored or in-turn tool call, as the offer history reads it. */
export type OfferCall = { name: string; input: Record<string, unknown>; result: Record<string, unknown>; outcome: string; at: number };

/** What a check_offer call stores for the app (`result.record`): the binding, the figures and what was tried before. */
export type OfferRecord = {
  id: string;
  type: OfferType;
  kind: "discount" | "volume" | "smaller";
  /** Its place among the active offers in the seller's order. */
  place: { n: number; of: number };
  /** The trade the buyer named, or "next" (the next in the seller's order). */
  reason: OfferType | "next";
  /** Plain terms (English), for the agent and the seller's card. */
  terms: string;
  /** The chip when agent steps are hidden ("3% if signed within 7 days"). */
  short: string;
  percentBp: number;
  units?: number;
  lines: { sku: string; qty: number }[];
  sites?: number;
  removedAutoAdd: string[];
  spokenOnly?: boolean;
  currency: string;
  before: { todayMinor: number; recurringMinor: number };
  after: { todayMinor: number; recurringMinor: number };
  recurringPeriod: string | null;
  quoteId: string;
  quoteNumber: number;
  quoteVersion: number;
  priceListId: string;
  catalogVersionId: string;
  /** ISO time: the quote's valid-until when the offer was made. */
  expiresAt: string;
  /** Active offers before it that were skipped or already made, with why. */
  tried: { type: OfferType; n: number; state: OfferOutcome | "skipped"; reason?: string }[];
};

/** A check_offer call that found nothing more to offer. */
export type NoOfferRecord = { exhausted: true; quoteId: string; quoteNumber: number; tried: OfferRecord["tried"] };

export function offerRecordOf(result: Record<string, unknown> | null | undefined): OfferRecord | null {
  const r = result?.record as Partial<OfferRecord> | undefined;
  return r && typeof r.id === "string" && isOfferType(r.type) && typeof r.percentBp === "number" && Array.isArray(r.lines) ? (r as OfferRecord) : null;
}

/** The offer id a create_quote result carries. */
export function quoteOfferId(result: Record<string, unknown> | null | undefined): string | null {
  const o = result?.offer as { id?: unknown } | null | undefined;
  return o && typeof o.id === "string" ? o.id : null;
}

/** Ok check_offer and create_quote calls of a lead, oldest first, from every conversation of the lead. Scoped by account. */
export async function leadOfferCalls(db: Db, accountId: string, leadId: string): Promise<OfferCall[]> {
  const rows = await db.select({ name: toolCalls.name, input: toolCalls.input, result: toolCalls.result, outcome: toolCalls.outcome, at: toolCalls.createdAt, seq: toolCalls.sequence })
    .from(toolCalls).innerJoin(conversations, eq(conversations.id, toolCalls.conversationId))
    .where(and(
      eq(toolCalls.accountId, accountId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId),
      inArray(toolCalls.name, ["check_offer", "create_quote"]), eq(toolCalls.outcome, "ok"),
    ))
    .orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
  return rows.map((r) => ({ name: r.name, input: r.input, result: r.result, outcome: r.outcome, at: r.at.getTime() }));
}

export type MadeOfferEntry = { record: OfferRecord; outcome: OfferOutcome; acceptedQuoteId: string | null };

/**
 * Every offer made, oldest first, with its inferred outcome (pure). `calls`:
 * ok check_offer and create_quote calls, oldest first.
 */
export function offerHistory(calls: readonly OfferCall[], now: Date): MadeOfferEntry[] {
  const accepted = new Map<string, string | null>();
  for (const c of calls) {
    if (c.name !== "create_quote" || c.outcome !== "ok") continue;
    const id = quoteOfferId(c.result);
    if (id) accepted.set(id, typeof c.result.quote_id === "string" ? c.result.quote_id : null);
  }
  const offers = calls.map((c, i) => ({ c, i, record: c.name === "check_offer" ? offerRecordOf(c.result) : null }));
  const made = offers.filter((x): x is typeof x & { record: OfferRecord } => !!x.record);
  const lastOffer = made.at(-1);
  return made.map((x) => {
    const later = calls.slice(x.i + 1);
    let outcome: OfferOutcome;
    if (accepted.has(x.record.id)) outcome = "accepted";
    else if (Date.parse(x.record.expiresAt) < now.getTime()) outcome = "expired";
    else if (x === lastOffer && later.some((c) => c.name === "create_quote" && c.result.status === "awaiting_seller_approval" && !quoteOfferId(c.result))) outcome = "needs_approval";
    else if (later.some((c) => c.name === "check_offer")) outcome = "not_taken";
    else outcome = "offered";
    return { record: x.record, outcome, acceptedQuoteId: accepted.get(x.record.id) ?? null };
  });
}

/** The highest percent offered so far (0 when none was a percent): above it, a discount without an offer is an approval request. */
export function highestOfferedBp(history: readonly MadeOfferEntry[]): number {
  return Math.max(0, ...history.map((h) => h.record.percentBp));
}

/** The stored offer with this id among the calls, newest first (null when it is not this lead's). */
export function findOffer(calls: readonly OfferCall[], id: string): OfferRecord | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const r = calls[i].name === "check_offer" ? offerRecordOf(calls[i].result) : null;
    if (r && r.id.toUpperCase() === id.trim().toUpperCase()) return r;
  }
  return null;
}
