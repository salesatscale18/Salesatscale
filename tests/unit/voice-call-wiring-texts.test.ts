/**
 * Call wiring v2 (A3), pure parts: the site-count rule for catalogs with no site data, the stage block's quote-needs
 * lines, and the guards' refusal texts (English and Hebrew; the buyer-call texts unchanged).
 */
import { describe, expect, it } from "vitest";
import { quantityAskLine, quantityNotGiven, ungroundedQuoteLine } from "@/lib/voice/quote-quantities";
import { removalKeepLine, removalNotAsked, smallerQuoteHold, smallerQuoteNotAsked } from "@/lib/voice/engine";
import { guardedStageHints, QUOTE_NEEDS_LINE, quoteNeedsLines } from "@/lib/voice-guarded/stage-hints";
import { GUARDED_PROFILE, GUARDED_SILENT_PROFILE } from "@/lib/voice-guarded/profile";

const run = (o: { qty: number; buyer: string[]; sites: number | null; siteFallback?: boolean; perSite?: string[]; call?: { role: string; text: string }[] }) => ungroundedQuoteLine({
  lines: [{ sku: "PKG", qty: o.qty }], buyerLines: o.buyer, callLines: o.call ?? [], sites: o.sites, refusedAt: null,
  perSiteSkus: new Set(o.perSite ?? []), ...(o.siteFallback === undefined ? {} : { siteFallback: o.siteFallback }),
});

describe("A3 (c): a catalog with no site data", () => {
  it("buyer calls (default): the site count grounds every item, as before", () => {
    expect(run({ qty: 1, buyer: ["We have one location."], sites: 1 })).toBeNull();
    expect(run({ qty: 2, buyer: ["We have two cafés."], sites: 2 })).toBeNull();
  });
  it("call wiring v2: the site count grounds no item by itself", () => {
    expect(run({ qty: 1, buyer: ["We have one location."], sites: 1, siteFallback: false })).toEqual({ sku: "PKG", qty: 1 });
    expect(run({ qty: 2, buyer: ["We have two sites."], sites: 2, siteFallback: false })).toEqual({ sku: "PKG", qty: 2 });
  });
  it("call wiring v2: a buyer number, a product with the site count, an agreed number still ground", () => {
    expect(run({ qty: 12, buyer: ["We have two cafés with 12 fridges."], sites: 2, siteFallback: false })).toBeNull();
    expect(run({ qty: 6, buyer: ["We have two sites, three in each."], sites: 2, siteFallback: false })).toBeNull();
    expect(run({ qty: 1, buyer: ["We have one location."], sites: 1, siteFallback: false, call: [{ role: "agent", text: "I'd quote one. Shall I go ahead with one?" }, { role: "buyer", text: "Yes, go ahead." }] })).toBeNull();
  });
  it("a catalog with site data: unchanged either way (only its per-site items take the site count)", () => {
    for (const siteFallback of [true, false]) {
      expect(run({ qty: 2, buyer: ["two sites"], sites: 2, perSite: ["PKG"], siteFallback })).toBeNull();
      expect(run({ qty: 2, buyer: ["two sites"], sites: 2, perSite: ["HUB"], siteFallback })).toEqual({ sku: "PKG", qty: 2 });
    }
  });
});

describe("A3 (a): what a quote needs, in the stage block", () => {
  it("the rule; the items not given yet; the per-site item to keep", () => {
    expect(quoteNeedsLines({ known: false, notGiven: [], perSiteAdded: [] })).toEqual([QUOTE_NEEDS_LINE]);
    expect(quoteNeedsLines({ known: true, notGiven: ["wireless fridge sensor"], perSiteAdded: ["installation"] })).toEqual([
      "Before create_quote: every quantity must be a number the buyer said or agreed to. Not given yet: how many wireless fridge sensor. Ask that before you quote.",
      "Installation is added automatically for each site: keep it; do not offer to remove it unless the buyer asks.",
    ]);
    expect(quoteNeedsLines({ known: true, notGiven: ["a", "b", "c"], perSiteAdded: [] })[0]).toContain("how many a, b and c.");
  });
  it("only in stages 2-4 (not while a quote waits for approval), and no read otherwise", async () => {
    let reads = 0;
    const needs = async () => { reads++; return { known: false, notGiven: [], perSiteAdded: [] }; };
    for (const title of ["2 Understand", "3 Recommend", "4 Quote and close"]) expect(await guardedStageHints(`## Stage now: ${title}\nDo: x.`, needs)).toEqual([QUOTE_NEEDS_LINE]);
    expect(reads).toBe(3);
    for (const block of ["## Stage now: 1 Open\nDo: x.", "## Stage now: 5 Order form\nDo: x.", "## Stage now: 6 After\nDo: x.", "## Stage now: 4 Quote and close\nThe quote waits for the seller's approval: you asked the team."]) {
      expect(await guardedStageHints(block, needs)).toEqual([]);
    }
    expect(reads).toBe(3);
  });
  it("the guarded profiles carry the hook", () => {
    expect(GUARDED_PROFILE.stageHints).toBe(guardedStageHints);
    expect(GUARDED_SILENT_PROFILE.stageHints).toBe(guardedStageHints);
  });
});

describe("A3 (b): the refusal texts", () => {
  it("buyer calls: the texts as before", () => {
    expect(removalNotAsked(["INST-1"]).message).toBe("The buyer did not ask to remove INST-1. The quote stays as it is. If it helps, offer that option in one short sentence and make the new quote only when the buyer agrees.");
    expect(smallerQuoteNotAsked("1 site").message).toBe("No quote was made: the buyer has not asked for a quote for 1 site. The current quote stays as it is. If a smaller start may help, first ask in one short question whether to prepare a quote for 1 site, and make it only when the buyer says yes.");
    expect(quantityNotGiven("sensor", "en").message).toBe("No quote was made: the buyer has not said how many sensor they need. Ask the buyer that one question now, in one short sentence, and wait for the answer. If they cannot say, propose a number aloud and get their yes before you quote.");
  });
  it("test calls: keep the line, never offer; nothing to mention to the buyer; same rules and shape", () => {
    expect(removalKeepLine(["installation"], true, "en")).toEqual({
      rule: "Removal not asked",
      message: "No quote was made: keep the installation line. It is required for each site. Do not offer to remove it and do not mention this to the buyer; make the same quote again with that line.",
    });
    expect(removalKeepLine(["setup"], false, "en").message).toContain("It is part of this order.");
    expect(removalKeepLine(["התקנה"], true, "he").message).toBe("לא נוצרה הצעת מחיר: השאר את השורה של התקנה. היא נדרשת לכל סניף. אל תציע להוריד אותה ואל תזכיר את זה לקונה; צור שוב את אותה הצעת מחיר עם השורה הזאת.");
    expect(smallerQuoteHold("1 site", "en").rule).toBe("Smaller quote not asked");
    expect(smallerQuoteHold("1 site", "en").message).toMatch(/^No quote was made; do not mention this to the buyer\. .*Do not offer a smaller quote on your own\./);
    expect(smallerQuoteHold("1 site", "he").message).toMatch(/^לא נוצרה הצעת מחיר; אל תזכיר את זה לקונה\./);
    expect(quantityNotGiven("sensor", "en", { v2: true })).toEqual({ rule: "Quantity not given", message: quantityAskLine("sensor", "en") });
    expect(quantityAskLine("sensor", "en")).toBe("No quote was made; do not mention this to the buyer. The buyer has not said how many sensor they need. Ask only that, in one short question in your own words, and wait for the answer. If they cannot say, suggest a number and wait for their yes before you call create_quote again.");
    expect(quantityAskLine("חיישן", "he")).toMatch(/^לא נוצרה הצעת מחיר; אל תזכיר את זה לקונה\. הקונה עוד לא אמר כמה חיישן הוא צריך\./);
    // No offer wording in any of them.
    for (const m of [removalKeepLine(["installation"], true, "en").message, quantityAskLine("sensor", "en")]) expect(m).not.toMatch(/offer that option|If it helps/);
  });
});
