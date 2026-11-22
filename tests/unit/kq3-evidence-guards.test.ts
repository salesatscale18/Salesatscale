/**
 * KQ3 (B, C), pure checks, modelled on the paid check of the Polar demo
 * (22 Nov): the playbook draft's "Too expensive" play fact told a café
 * chain's fridge failure from the call and credited it to the product facts
 * note, which does not contain it.
 * - B: an evidence quote must be in the cited source's text; else it moves to
 *   the one other source that has it, or is dropped; PDF page quotes are kept
 *   unverified.
 * - C: play facts and objections built on what stage 1 kept back as one
 *   customer's are dropped, and so are play facts backed only by calls.
 */
import { describe, expect, it } from "vitest";
import {
  cleanEvidence, guardCustomerSpecific, noEvidenceCheck, normalizeQuote, parseFactsOutput, parsePlaybookOutput, quotesOverlap, verifyQuote,
  type CleanSuggestion, type CorpusIndex, type CustomerNote,
} from "@/lib/pipeline/validate";

const NOTE = "00000000-0000-4000-8000-0000000000a1";
const CALL = "00000000-0000-4000-8000-0000000000c1";
const DECK = "00000000-0000-4000-8000-0000000000d1";
const WEB = "00000000-0000-4000-8000-0000000000e1";

const NOTE_TEXT = [
  "Polar Demo sells wireless temperature monitoring for restaurants and food businesses.",
  "One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.",
  "The monthly monitoring plan (per gateway) includes the app and all alerts.",
  "Installation takes about 1 hour per site.",
].join("\n");
const CALL_TURNS: [string, string, string][] = [
  ["00:14", "Rep", "Great. How do you check the fridges today?"],
  ["00:19", "Buyer", "The shift manager writes the temperature on a paper sheet, morning and evening. Sometimes they forget."],
  ["00:47", "Buyer", "Last summer a fridge in Ramat Gan died on a Friday night. We threw away about 6,000 shekels of stock and closed the kitchen for half a day."],
  ["01:12", "Buyer", "We already pay for an alarm company."],
  ["01:16", "Rep", "I understand. But an alarm covers doors, not temperature. It won't tell you the fridge is at 9 degrees."],
  ["01:29", "Rep", "One per fridge or freezer, and one gateway per site. How many fridges does each café have?"],
  ["01:35", "Buyer", "About five each, so fifteen in total."],
  ["01:58", "Rep", "Normally 250 per site, but for three sites I can waive the installation fee."],
];
const DECK_PAGES: [string, string][] = [
  ["p.1", "פולאר דמו – ניטור טמפרטורה אלחוטי למקררים"],
  ["p.2", "לפני: גיליון נייר, בדיקה פעמיים ביום. אחרי: התראה בוואטסאפ תוך 15 דקות."],
];

const idx = (doc = false): CorpusIndex => new Map([
  [NOTE, { kind: "text", title: "Polar Demo – product facts", locators: new Set(["note"]), sections: [{ locator: "note", text: normalizeQuote(NOTE_TEXT) }] }],
  [CALL, { kind: "call", title: "Discovery call – café chain, 3 sites", locators: new Set(CALL_TURNS.map(([l]) => l)), sections: CALL_TURNS.map(([locator, heading, t]) => ({ locator, heading, text: normalizeQuote(t) })) }],
  [DECK, { kind: "file", title: "Polar deck.pdf", locators: new Set(["p.1", "p.2", "p.3"]), sections: DECK_PAGES.map(([locator, t]) => ({ locator, text: normalizeQuote(t) })), ...(doc ? { document: true } : {}) }],
]);
const ev = (source_id: string, locator: string, quote: string) => ({ source_id, locator, quote });
const STORY = "We threw away about 6,000 shekels of stock and closed the kitchen for half a day.";

describe("B: the quote must be in the cited source", () => {
  it("keeps a quote found in its section, whatever the case, spacing and punctuation", () => {
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: "the monthly monitoring plan, per gateway, includes the APP and all alerts" }, idx()))
      .toEqual({ sourceId: NOTE, locator: "note", how: "ok" });
    // Hebrew, with other punctuation.
    expect(verifyQuote({ sourceId: DECK, locator: "p.2", quote: "לפני - גיליון נייר; בדיקה פעמיים ביום" }, idx())?.how).toBe("ok");
    // Parts skipped with an ellipsis: each part must be there.
    expect(verifyQuote({ sourceId: CALL, locator: "00:47", quote: "a fridge in Ramat Gan died … closed the kitchen" }, idx())?.how).toBe("ok");
    // Whole words only.
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: "up to 3" }, idx())).toBeNull();
  });

  it("corrects the locator when the quote is in another section of the same source", () => {
    expect(verifyQuote({ sourceId: CALL, locator: "00:14", quote: "We already pay for an alarm company." }, idx()))
      .toEqual({ sourceId: CALL, locator: "01:12", how: "relocated" });
  });

  it("credits the café story to the call when the model credited it to the product facts note", () => {
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: STORY }, idx()))
      .toEqual({ sourceId: CALL, locator: "00:47", how: "reattributed" });
  });

  it("drops a quote found nowhere, or in more than one other source", () => {
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: "A fridge failure cost one café chain about 6,000 ILS" }, idx())).toBeNull();
    const two: CorpusIndex = new Map([...idx(), [WEB, { kind: "website", title: "Site", locators: new Set(["/"]), sections: [{ locator: "/", text: normalizeQuote("One per fridge or freezer, and one gateway per site.") }] }]]);
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: "one gateway per site" }, two)).toBeNull();
    expect(verifyQuote({ sourceId: NOTE, locator: "note", quote: " … " }, idx())).toBeNull();
  });

  it("keeps a PDF page quote missing from the text as unverified, only for a source read as pages and a page locator", () => {
    const words = "Trusted by 120 kitchens";
    expect(verifyQuote({ sourceId: DECK, locator: "p.3", quote: words }, idx(true))).toEqual({ sourceId: DECK, locator: "p.3", how: "unverified" });
    expect(verifyQuote({ sourceId: DECK, locator: "p.3", quote: words }, idx(false))).toBeNull();
    const out = cleanEvidence([ev(DECK, "p.3", words)], idx(true));
    expect(out).toEqual([{ sourceId: DECK, locator: "p.3", quote: words, unverified: true }]);
  });

  it("does not check sources without section texts (an index made by hand)", () => {
    const bare: CorpusIndex = new Map([[NOTE, { kind: "text", title: "N", locators: new Set(["note"]) }]]);
    expect(cleanEvidence([ev(NOTE, "note", "anything")], bare)).toHaveLength(1);
  });

  it("cleanEvidence counts what it did and dedupes after moving evidence", () => {
    const check = noEvidenceCheck();
    const out = cleanEvidence([
      ev(NOTE, "note", STORY), // -> call 00:47
      ev(CALL, "00:47", "Last summer a fridge in Ramat Gan died"), // same place: deduplicated
      ev(CALL, "00:14", "an alarm covers doors, not temperature"), // -> 01:16
      ev(NOTE, "note", "Sensors last ten years."), // nowhere
    ], idx(), check);
    expect(out.map((e) => `${e.sourceId === CALL ? "call" : "note"} ${e.locator}`)).toEqual(["call 00:47", "call 01:16"]);
    expect(check).toEqual({ relocated: 1, reattributed: 1, unverified: 0, notFound: 1 });
  });

  it("facts: a fact whose only quote is found nowhere is dropped; counts are in the result", () => {
    const r = parseFactsOutput({ facts: [
      { topic: "Product", statement: "One GW-10 gateway handles up to 30 sensors.", language: "en", evidence: [ev(NOTE, "note", "handles up to 30 sensors")] },
      { topic: "Proof", statement: "Sensors last ten years.", language: "en", evidence: [ev(NOTE, "note", "Sensors last ten years.")] },
      { topic: "Company", statement: "A café chain lost 6,000 shekels.", language: "en", customer_specific: true, evidence: [ev(NOTE, "note", STORY)] },
    ] }, idx());
    expect(r.facts.map((f) => f.statement)).toEqual(["One GW-10 gateway handles up to 30 sensors."]);
    expect(r.dropped.noEvidence).toBe(1);
    expect(r.evidenceCheck).toEqual({ relocated: 0, reattributed: 1, unverified: 0, notFound: 1 });
    // The customer note is kept with the corrected source and the evidence words.
    expect(r.customerSpecific).toEqual([{ sourceId: CALL, locator: "00:47", note: "A café chain lost 6,000 shekels.", quote: STORY }]);
  });

  it("playbook items: wrong credit fixed, invented quotes dropped, counts returned", () => {
    const r = parsePlaybookOutput({
      play_content: [
        { play: "too_expensive", content: "A fridge failure cost one café chain about 6,000 ILS. The plan includes the app and all alerts.", evidence: [ev(NOTE, "note", STORY), ev(NOTE, "note", "includes the app and all alerts")] },
        { play: "proof", content: "Used by 500 restaurants.", evidence: [ev(NOTE, "note", "Used by 500 restaurants")] },
      ],
    }, idx());
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].evidence.map((e) => e.sourceId)).toEqual([CALL, NOTE]);
    expect(r.dropped).toBe(1);
    expect(r.evidenceCheck).toEqual({ relocated: 0, reattributed: 1, unverified: 0, notFound: 1 });
  });
});

describe("C: one customer's material never reaches plays", () => {
  // What stage 1 kept back on the real call (00:47 with the fact's quote; 01:35 and 01:58 notes only).
  const notes: CustomerNote[] = [
    { sourceId: CALL, locator: "00:47", note: "Café chain's fridge failure and 6,000 shekel loss kept back as one customer's story.", quote: STORY },
    { sourceId: CALL, locator: "01:35", note: "This buyer's fifteen fridges across three cafés kept back as customer-specific." },
    { sourceId: CALL, locator: "01:58", note: "Installation waiver offered to this buyer in the call kept back as a deal term." },
  ];
  const parse = (input: unknown) => parsePlaybookOutput(input, idx()).suggestions;

  it("quotes overlap when one holds the other or they share five words in a row", () => {
    expect(quotesOverlap("about 6,000 shekels of stock", STORY)).toBe(true);
    expect(quotesOverlap("Last summer a fridge died and we threw away about 6,000 shekels of stock", STORY)).toBe(true);
    expect(quotesOverlap("about 6,000 ILS of stock", STORY)).toBe(false);
    expect(quotesOverlap("", STORY)).toBe(false);
    // A quote cut at the limit ends in a partial word.
    expect(quotesOverlap("We threw away about 6,000 shekels of sto…", STORY)).toBe(true);
  });

  it("drops the real 'Too expensive' play fact (after B moved its story to the call), keeps the objection and a general play fact", () => {
    const suggestions = parse({
      objections: [{ objection: "We already pay for an alarm company.", answer: "An alarm covers doors, not temperature.", outcome: "", evidence: [ev(CALL, "01:12", "We already pay for an alarm company."), ev(CALL, "01:16", "an alarm covers doors, not temperature")] }],
      play_content: [
        { play: "too_expensive", content: "A fridge failure cost one café chain about 6,000 ILS of stock plus half a day of kitchen closure. The monitoring plan includes the app and all alerts.", evidence: [ev(NOTE, "note", STORY), ev(NOTE, "note", "includes the app and all alerts")] },
        { play: "right_size", content: "One GW-10 gateway handles up to 30 sensors within about 50 m indoors.", evidence: [ev(NOTE, "note", "handles up to 30 sensors within about 50 m indoors")] },
      ],
    });
    const g = guardCustomerSpecific(suggestions, notes, idx());
    expect(g.suggestions.map((s) => s.payload.kind)).toEqual(["objection", "play_content"]);
    expect(g.dropped).toEqual([{
      kind: "play_content", reason: "customer_specific", sourceId: CALL, locator: "00:47",
      text: "A fridge failure cost one café chain about 6,000 ILS of stock plus half a day of kitchen closure. The monitoring plan includes the app and all alerts.",
    }]);
  });

  it("drops an objection answered with a customer's figures (same call turn), and a play fact backed only by a buyer's words in calls", () => {
    const suggestions = parse({
      objections: [{ objection: "How many sensors would we need?", answer: "Fifteen sensors for your three cafés.", outcome: "", evidence: [ev(CALL, "01:35", "fifteen in total")] }],
      play_content: [
        // The buyer's own routine, told in one call: that customer's situation.
        { play: "existing_solution", content: "Shift managers write temperatures on a paper sheet and sometimes forget.", evidence: [ev(CALL, "00:19", "writes the temperature on a paper sheet")] },
        // The rep's own general words in a call: the seller's argument, kept.
        { play: "right_size", content: "One sensor per fridge or freezer and one gateway per site.", evidence: [ev(CALL, "01:29", "One per fridge or freezer, and one gateway per site.")] },
      ],
      limits: [{ rule: "Installation is free from 3 sites", setting: "other", evidence: [ev(CALL, "01:58", "waive the installation fee")] }],
    });
    const g = guardCustomerSpecific(suggestions, notes, idx());
    // Limits are not play material: they always wait for the seller's approval.
    expect(g.suggestions.map((s) => s.payload.kind)).toEqual(["limit", "play_content"]);
    expect(g.dropped.map((d) => [d.kind, d.reason, d.locator])).toEqual([["objection", "customer_specific", "01:35"], ["play_content", "buyer_words", "00:19"]]);
    // A buyer's turn next to a document: the document makes it general.
    const mixed = parse({ play_content: [{ play: "value", content: "Paper logs are forgotten; sensors alert by WhatsApp.", evidence: [ev(CALL, "00:19", "Sometimes they forget"), ev(NOTE, "note", "includes the app and all alerts")] }] });
    expect(guardCustomerSpecific(mixed, notes, idx()).dropped).toEqual([]);
  });

  it("in a document, only an overlapping quote counts (a page holds more than one customer's story)", () => {
    const docNotes: CustomerNote[] = [
      { sourceId: DECK, locator: "p.2", note: "One customer's story.", quote: "לפני: גיליון נייר, בדיקה פעמיים ביום." },
      { sourceId: DECK, locator: "p.1", note: "No quote kept." },
    ];
    const item = (quote: string, locator: string): CleanSuggestion => ({ payload: { kind: "play_content", play: "value", content: "x" }, evidence: [{ sourceId: DECK, locator, quote }] });
    const g = guardCustomerSpecific([item("גיליון נייר, בדיקה פעמיים ביום", "p.2"), item("התראה בוואטסאפ תוך 15 דקות", "p.2"), item("ניטור טמפרטורה אלחוטי", "p.1")], docNotes, idx());
    expect(g.dropped.map((d) => d.locator)).toEqual(["p.2"]);
    expect(g.suggestions).toHaveLength(2);
  });
});
