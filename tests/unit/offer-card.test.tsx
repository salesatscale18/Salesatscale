/**
 * The seller-only offer card (board OfferTool): states inferred from the calls
 * that followed, the place, the reason, tried-before with skipped reasons, the
 * accepted quote link, and the folded chip when agent steps are hidden.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { offerCardsByMessage } from "@/lib/agent/offer-card";
import { OfferCards } from "@/components/sas/offer-card";
import type { OfferRecord } from "@/lib/agent/offer-records";

const at = (s: string) => new Date(`2026-11-23T${s}:00Z`);
const record = (over: Partial<OfferRecord>): OfferRecord => ({
  id: "OF-aaaaaa", type: "decide_now", kind: "discount", place: { n: 3, of: 4 }, reason: "next",
  terms: "8% off the one-time charges if the buyer signs within 7 days, while the new quote is valid.", short: "8% if signed within 7 days",
  percentBp: 800, lines: [{ sku: "SNS-200", qty: 8 }], removedAutoAdd: [], currency: "ILS",
  before: { todayMinor: 771_720, recurringMinor: 21_240 }, after: { todayMinor: 709_982, recurringMinor: 21_240 }, recurringPeriod: "month",
  quoteId: "q1", quoteNumber: 1001, quoteVersion: 1, priceListId: "pl", catalogVersionId: "cv", expiresAt: "2026-11-30T10:00:00Z",
  tried: [{ type: "smaller_start", n: 1, state: "skipped", reason: "doesn't fit: no smaller set named" }, { type: "more_units", n: 2, state: "not_taken" }],
  ...over,
});
const check = (rec: OfferRecord) => ({ name: "check_offer", input: { quote: "Q-1001", reason: "next" }, result: { ok: true, offer: { offer_id: rec.id }, record: rec }, outcome: "ok" });

describe("offer cards in a thread", () => {
  const now = new Date("2026-11-24T10:00:00Z");

  it("offered, then accepted with the quote that carries it", () => {
    const offered = offerCardsByMessage([{ message: { id: "m1", createdAt: at("10:00") }, calls: [check(record({}))] }], now).get("m1")![0];
    expect(offered).toMatchObject({ title: "Offer · Decide now", place: "offer 3 of 4 in your order", reason: "Too expensive in general", state: "offered", before: "₪7,717.20", after: "₪7,099.82", recurringNote: "recurring unchanged" });
    expect(offered.tried).toEqual(["1 · A smaller first step (doesn't fit: no smaller set named)", "2 · More units (not taken)"]);
    const thread = [
      { message: { id: "m1", createdAt: at("10:00") }, calls: [check(record({}))] },
      { message: { id: "m2", createdAt: at("10:05") }, calls: [{ name: "create_quote", input: { offer: "OF-aaaaaa" }, result: { quote: "Q-1002 v1", quote_id: "q2", status: "ready", offer: { id: "OF-aaaaaa", trade: "decide_now" } }, outcome: "ok" }] },
    ];
    const card = offerCardsByMessage(thread, now).get("m1")![0];
    expect(card).toMatchObject({ state: "accepted", acceptedQuote: { id: "q2", number: 1002 } });
    const html = renderToStaticMarkup(<OfferCards cards={[card]} folded={false} quoteHref={(id) => `/app/acme/orders?quote=${id}`} />);
    expect(html).toContain('data-status="offer.accepted"');
    expect(html).toContain("Offer accepted · quote Q-1002 carries these terms");
    expect(html).toContain('href="/app/acme/orders?quote=q2"');
    expect(html).toContain("Only you see this.");
    expect(html).toContain("<s class=\"sas-offer__old\">₪7,717.20</s>");
  });

  it("not taken when a later offer was asked for; expired after the quote's date; needs your approval after a held quote", () => {
    const a = record({ id: "OF-aaaaaa" });
    const b = record({ id: "OF-bbbbbb", type: "general", short: "5% off", place: { n: 4, of: 4 } });
    const thread = [
      { message: { id: "m1", createdAt: at("10:00") }, calls: [check(a)] },
      { message: { id: "m2", createdAt: at("10:05") }, calls: [check(b), { name: "create_quote", input: {}, result: { quote: "Q-1003 v1", quote_id: "q3", status: "awaiting_seller_approval" }, outcome: "ok" }] },
    ];
    const cards = offerCardsByMessage(thread, now);
    expect(cards.get("m1")![0].state).toBe("not_taken");
    expect(cards.get("m2")![0].state).toBe("needs_approval");
    expect(offerCardsByMessage(thread, new Date("2026-12-05T00:00:00Z")).get("m1")![0].state).toBe("expired");
  });

  it("folds to a chip when agent steps are hidden; nothing more to offer has its own card", () => {
    const cards = offerCardsByMessage([
      { message: { id: "m1", createdAt: at("10:00") }, calls: [check(record({}))] },
      { message: { id: "m2", createdAt: at("10:05") }, calls: [{ name: "check_offer", input: { reason: "next" }, result: { ok: true, offer: null, record: { exhausted: true, quoteId: "q1", quoteNumber: 1001, tried: [] } }, outcome: "ok" }] },
    ], now);
    expect(renderToStaticMarkup(<OfferCards cards={cards.get("m1")!} folded />)).toContain("Offer: 8% if signed within 7 days");
    expect(cards.get("m2")![0]).toMatchObject({ title: "No more offers", state: null });
  });
});
