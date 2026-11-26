/**
 * Offers flow fixes (objection test of 26 Nov), pure parts: which standing
 * offer a create_quote without an offer id binds (standingOfferMatch), how
 * offerHistory treats a later check that found nothing, and the seller's trace
 * of an objection recorded with buyer_words.
 */
import { describe, expect, it } from "vitest";
import { offerHistory, standingOfferMatch, type MadeOfferEntry, type OfferCall, type OfferRecord } from "@/lib/agent/offer-records";
import { describeCall } from "@/lib/agent/trace";

const KITCHEN = [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }, { sku: "INST-1", qty: 1 }];
const rec = (more: Partial<OfferRecord> = {}): OfferRecord => ({
  id: "OF-aaaaaa", type: "general", kind: "discount", place: { n: 2, of: 2 }, reason: "decide_now", terms: "5% off the one-time charges.", short: "5% off",
  percentBp: 500, lines: KITCHEN, sites: 1, removedAutoAdd: [], currency: "ILS",
  before: { todayMinor: 385_860, recurringMinor: 10_620 }, after: { todayMinor: 366_567, recurringMinor: 10_620 }, recurringPeriod: "month",
  quoteId: "q1", quoteNumber: 1010, quoteVersion: 1, priceListId: "pl", catalogVersionId: "cv", expiresAt: "2099-01-01T00:00:00Z", tried: [],
  ...more,
});
const entry = (r: OfferRecord, outcome: MadeOfferEntry["outcome"] = "offered"): MadeOfferEntry => ({ record: r, outcome, acceptedQuoteId: null });
const want = (lines = KITCHEN.slice(0, 2), discountBp = 500) => ({ discountBp, quoteId: "q1", quoteVersion: 1, lines });

describe("standingOfferMatch", () => {
  it("one standing offer of that percent on the current quote: bound, with the left-out installation line restored", () => {
    expect(standingOfferMatch([entry(rec())], want())).toEqual({ record: rec(), lines: KITCHEN, restored: [{ sku: "INST-1", qty: 1 }] });
    expect(standingOfferMatch([entry(rec())], want(KITCHEN))).toMatchObject({ restored: [] });
    // A bigger request was made after it (needs approval): the offer still stands.
    expect(standingOfferMatch([entry(rec(), "needs_approval")], want())).not.toBeNull();
  });

  it("(c) two standing offers of that percent: no binding (refused as before)", () => {
    const two = [entry(rec()), entry(rec({ id: "OF-bbbbbb", type: "decide_now" }))];
    expect(standingOfferMatch(two, want())).toBeNull();
    // `valid` can leave one (the other no longer allowed by the seller's list): then it binds.
    expect(standingOfferMatch(two, want(), (r) => r.type === "general")).toMatchObject({ record: { id: "OF-aaaaaa" } });
  });

  it("no binding without an exact match: other percent, quote, version, outcome, or the valid check", () => {
    expect(standingOfferMatch([entry(rec())], want(undefined, 400))).toBeNull();
    expect(standingOfferMatch([entry(rec())], want(undefined, 0))).toBeNull();
    expect(standingOfferMatch([entry(rec())], { ...want(), quoteId: "q2" })).toBeNull();
    expect(standingOfferMatch([entry(rec())], { ...want(), quoteVersion: 2 })).toBeNull();
    for (const o of ["accepted", "not_taken", "expired"] as const) expect(standingOfferMatch([entry(rec(), o)], want())).toBeNull();
    expect(standingOfferMatch([entry(rec())], want(), () => false)).toBeNull();
  });

  it("never adds a paid item or changes a quantity; restores only for offers on the quote's own lines", () => {
    expect(standingOfferMatch([entry(rec())], want([{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }, { sku: "EXTRA", qty: 1 }]))).toBeNull();
    expect(standingOfferMatch([entry(rec())], want([{ sku: "SNS-200", qty: 5 }, { sku: "GW-10", qty: 1 }]))).toBeNull();
    // Codes are matched without case; split lines of one code add up.
    expect(standingOfferMatch([entry(rec())], want([{ sku: "sns-200", qty: 2 }, { sku: "SNS-200", qty: 2 }, { sku: "gw-10", qty: 1 }]))).toMatchObject({ restored: [{ sku: "INST-1", qty: 1 }] });
    // A more-units percent offer (its lines are a larger set than the quote): exact lines only.
    const more = rec({ type: "more_units", lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 1 }] });
    expect(standingOfferMatch([entry(more)], want([{ sku: "SNS-200", qty: 10 }]))).toBeNull();
    expect(standingOfferMatch([entry(more)], want([{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 1 }]))).toMatchObject({ restored: [] });
    // Smaller and volume offers carry no percent: never bound.
    expect(standingOfferMatch([entry(rec({ kind: "volume", percentBp: 500 }))], want())).toBeNull();
  });
});

describe("offerHistory: a later check that found nothing", () => {
  const offerCall = (r: OfferRecord, at: number): OfferCall => ({ name: "check_offer", input: {}, result: { ok: true, offer: { offer_id: r.id }, record: r }, outcome: "ok", at });
  const noneCall = (at: number): OfferCall => ({ name: "check_offer", input: {}, result: { ok: true, offer: null, record: { exhausted: true, quoteId: "q1", quoteNumber: 1010, tried: [] } }, outcome: "ok", at });

  it("leaves the offer standing; a later offer still replaces it", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    expect(offerHistory([offerCall(rec(), 1), noneCall(2), noneCall(3)], now).map((h) => h.outcome)).toEqual(["offered"]);
    const later = rec({ id: "OF-bbbbbb", type: "decide_now" });
    expect(offerHistory([offerCall(rec(), 1), noneCall(2), offerCall(later, 3)], now).map((h) => h.outcome)).toEqual(["not_taken", "offered"]);
  });
});

describe("trace of an objection", () => {
  it("(f) shows the buyer's words when the objection has no text (the record shape since O1)", () => {
    const input = { updates: [], objection: { play: "too_expensive", buyer_words: "more than we planned to spend", step: 1, attempt: false, status: "open" } };
    expect(describeCall("update_deal_state", input, { saved: [] }, "ok").sent).toBe("No field changes; objection: more than we planned to spend");
    // An older record with text keeps its text.
    expect(describeCall("update_deal_state", { updates: [], objection: { text: "too pricey" } }, { saved: [] }, "ok").sent).toBe("No field changes; objection: too pricey");
  });
});
