import { describe, expect, it } from "vitest";
import { matchingOfferNext, offerNextLine, standingOfferNext } from "@/lib/voice-guarded/offer-next";
import { missingFactsOf, refusedQuoteMessage } from "@/lib/voice/engine";
import { withoutInternalIds } from "@/lib/voice/result-ids";
import { OFFER_NONE_MESSAGE } from "@/lib/agent/tools";

const ID = "9da6f888-1c2b-4c1e-9d6e-0a1b2c3d4e5f";
const TERMS = "5% off the one-time charges. Recurring charges are not discounted.";
const none = { ok: true, quote: "Q-1013 v1", offer: null, standing_offer: { id: "OF-cf90ef", terms: TERMS, quote: "Q-1012 v1" }, message: OFFER_NONE_MESSAGE };
const refused = {
  ok: false, refused: true, rule: "Discount not from an offer", missing: ["offer"],
  matching_offer: { id: "OF-cf90ef", terms: TERMS, quote: "Q-1012 v1", lines: [{ sku: "SENSOR", qty: 6 }] }, message: "m",
};

describe("offerNextLine (call wiring v2, test calls): the next action from standing_offer / matching_offer", () => {
  it("check_offer with nothing more and a standing offer: use that offer, make no new one", () => {
    expect(offerNextLine("check_offer", none)).toBe(
      "An earlier offer still stands on Q-1012 v1. If the buyer accepts it, call create_quote with offer OF-cf90ef; do not make a new offer. Its terms: 5% off the one-time charges. Recurring charges are not discounted.",
    );
    expect(offerNextLine("check_offer", none)).toBe(standingOfferNext({ id: "OF-cf90ef", terms: TERMS, quote: "Q-1012 v1" }));
  });

  it("create_quote 'Discount not from an offer' with a matching offer: the quote again with its id and lines", () => {
    expect(offerNextLine("create_quote", refused)).toBe(
      "Call create_quote again with offer OF-cf90ef and that offer's lines; do not change the lines. Its terms: 5% off the one-time charges. Recurring charges are not discounted.",
    );
    expect(offerNextLine("create_quote", refused)).toBe(matchingOfferNext({ id: "OF-cf90ef", terms: TERMS, quote: "Q-1012 v1" }));
  });

  it("no line without the field, on another tool or outcome, or when a field is not an app reference", () => {
    const { standing_offer: _s, ...noStanding } = none;
    void _s;
    expect(offerNextLine("check_offer", noStanding)).toBeNull();
    expect(offerNextLine("check_offer", { ...none, offer: { offer_id: "OF-1" } })).toBeNull();
    const { matching_offer: _m, ...noMatching } = refused;
    void _m;
    expect(offerNextLine("create_quote", noMatching)).toBeNull();
    expect(offerNextLine("create_quote", { ...refused, rule: "Offer first" })).toBeNull();
    expect(offerNextLine("send_order_form", { ...none, ...refused })).toBeNull();
    expect(offerNextLine("check_offer", { ...none, standing_offer: { id: ID, terms: TERMS, quote: "Q-1" } })).toBeNull();
    expect(offerNextLine("check_offer", { ...none, standing_offer: { id: "OF-1", terms: "", quote: "Q-1" } })).toBeNull();
  });

  it("the internal-id stripper keeps the line, the OF- offer id and the Q- number (a uuid still goes)", () => {
    const out = withoutInternalIds({ ...refused, quote_id: ID, next: offerNextLine("create_quote", refused) });
    expect(out.quote_id).toBeUndefined();
    expect(out.matching_offer).toEqual(refused.matching_offer);
    expect(String(out.next)).toContain("offer OF-cf90ef");
    const s = withoutInternalIds({ ...none, next: offerNextLine("check_offer", none) });
    expect(s.standing_offer).toEqual(none.standing_offer);
    expect(String(s.next)).toContain("on Q-1012 v1");
  });
});

describe("missingFactsOf (K4): an offer id is not a fact to save", () => {
  it("'Discount not from an offer' keeps its own message; other refusals with missing facts get the K4 message", () => {
    expect(missingFactsOf(refused)).toEqual([]);
    expect(missingFactsOf({ rule: "Before-quote fields missing", missing: ["Sites", "Business type"] })).toEqual(["Sites", "Business type"]);
    expect(refusedQuoteMessage(missingFactsOf({ rule: "Before-quote fields missing", missing: ["Sites"] }))).toMatch(/^No quote was made: Sites not saved yet\./);
    expect(missingFactsOf({ rule: "x" })).toEqual([]);
  });
});
