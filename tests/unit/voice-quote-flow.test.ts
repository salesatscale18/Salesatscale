/**
 * Call wiring v2, A4 (test calls): the quote flow on a call. Recommend first, prices only from the quote, straight to
 * create_quote. Pure parts: search_catalog with no money, the stage block swaps and lines, the up-front sentence
 * swaps (every one found in the golden inputs), and buyer calls' instructions unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveStage, NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import { buildVoiceInstructions as classicInstructions, classicStageText, expectedCallLanguages as classicLanguages } from "@/lib/voice-classic/instructions";
import { GPT_TOOL_RULES, guardedInstructions } from "@/lib/voice-guarded/instructions";
import {
  applySwaps, INSTRUCTION_SWAPS, PRICES_FROM_QUOTE_LINE, QUOTE_STRAIGHT_LINE, quoteFlowInstructions, quoteFlowStage, RECOMMEND_LINE, STAGE_SWAPS, swapsFound,
} from "@/lib/voice-guarded/quote-flow";
import { fitRefusedMessage, searchForCall, SEARCH_PRICES_FOR_CALL } from "@/lib/voice/engine";
import { callWiringV2For } from "@/lib/voice/settings";

const input = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/voice-classic/input.json"), "utf8"));
const playbook = { fields: [{ key: "sites", label: "Number of sites", stage: "before_quote" }, { key: "biz", label: "Business type", stage: "before_quote" }], outcomes: { orderForm: true, meeting: false }, questionBudget: 3 } as never;
const block = (fields: Record<string, { value: string }>, quote: "none" | "ready" | "awaiting_approval" = "none") =>
  classicStageText(deriveStage({ ...NO_STAGE_FACTS, quote, playbook, fields: fields as never, agentMessages: 3 }).instruction);

describe("A4 (a): search_catalog on a call gives no money", () => {
  const result = {
    ok: true, currency: "ILS", prices_include_tax: false, price_basis: "Prices are before VAT; VAT 18% is added on the quote.",
    items: [
      { sku: "SNS-200", name: "Wireless fridge sensor", plain_name: "wireless fridge sensor", sold_here: true, one_time_price: "₪590.00", recurring_price: null, volume_prices: ["one-time from 10: ₪550.00"], priced_by_seller_from_qty: 50, value: "An alert the moment a fridge leaves its range, from ₪590 each.", availability: null },
      { sku: "OLD", name: "Old", plain_name: "old", sold_here: false, note: "Not sold in this buyer's market. Do not offer it." },
    ],
  };
  it("no prices, volume prices, currency, price basis or money figure in an item's text; where prices come from", () => {
    const out = searchForCall(result);
    expect(out).toEqual({
      ok: true,
      items: [
        { sku: "SNS-200", name: "Wireless fridge sensor", plain_name: "wireless fridge sensor", sold_here: true, value: "An alert the moment a fridge leaves its range, from (price on the quote) each.", availability: null },
        { sku: "OLD", name: "Old", plain_name: "old", sold_here: false, note: "Not sold in this buyer's market. Do not offer it." },
      ],
      prices: SEARCH_PRICES_FOR_CALL,
    });
    expect(JSON.stringify(out)).not.toMatch(/[₪$€£]|\bILS\b|\d[\d,]*\.\d{2}/);
    expect(SEARCH_PRICES_FOR_CALL).toBe("not shown on a call: prices come only from create_quote");
    // Prices still withheld by the tool: the same answer.
    expect(searchForCall({ ok: true, items: [], prices: "withheld until the buyer confirms the recommendation or asks for the price" })).toEqual({ ok: true, items: [], prices: SEARCH_PRICES_FOR_CALL });
  });
  it("a set that does not fit: create_quote's refusal says why and what to do", () => {
    expect(fitRefusedMessage(["Wireless fridge sensor needs one Site gateway per site."])).toBe(
      "No quote was made: the set does not fit (Wireless fridge sensor needs one Site gateway per site.). Change the lines so it fits (add what is missing, in the quantities the buyer gave or agreed to) and call create_quote again. Do not mention this check to the buyer.",
    );
  });
});

describe("A4 (b): the stage block on a call", () => {
  it("2 Understand, price asked: no number from search_catalog; the exact price in a moment, the one thing missing, then create_quote", () => {
    const b = block({ sites: { value: "2" }, _price_asked: { value: "yes" } });
    expect(b).toContain(STAGE_SWAPS[0].from);
    const { block: out, lines } = quoteFlowStage(b);
    expect(out).not.toContain("search_catalog");
    expect(out).toContain("Do: give no number yet: say in one short sentence that you will give the exact price in a moment, then ask only the one thing the quote still cannot be made without (or confirm the set), then call create_quote. Drop every question that only helps the pitch.");
    expect(out).toContain(`\n${PRICES_FROM_QUOTE_LINE}`);
    expect(lines).toEqual([]);
  });
  it("3 Recommend: one set, no prices; the price question gets no number", () => {
    const b = block({ sites: { value: "2" }, biz: { value: "x" } });
    expect(b).toContain(STAGE_SWAPS[1].from);
    const { block: out, lines } = quoteFlowStage(b);
    expect(out).not.toContain("number or range from search_catalog");
    expect(out).toContain("If the buyer asks the price, call update_deal_state with price_asked true and give no number before the quote: say in one short sentence that you will give the exact price in a moment, ask the one thing still missing (or confirm the set), then call create_quote.");
    expect(lines).toEqual([RECOMMEND_LINE]);
    expect(RECOMMEND_LINE).toBe("Present one set in plain words, no prices, and ask if it fits. You have no prices yet.");
  });
  it("4 Quote and close: straight to create_quote, no check_fit first, facts saved in the same step", () => {
    const b = block({ sites: { value: "2" }, biz: { value: "x" }, _recommendation_confirmed: { value: "yes" } });
    expect(b).toContain(STAGE_SWAPS[2].from);
    const { block: out, lines } = quoteFlowStage(b);
    expect(out).toContain("Do: call create_quote now. Do not call check_fit first: create_quote checks the fit itself. Save new facts with update_deal_state in the same step. Do not ask whether to prepare a quote.");
    expect(out).not.toContain("check_fit first)");
    expect(out).toContain(`\n${PRICES_FROM_QUOTE_LINE}`);
    expect(lines).toEqual([]);
    // Something still to ask first: the straight-to-quote line after the block.
    const asking = quoteFlowStage(block({ sites: { value: "2" }, _recommendation_confirmed: { value: "yes" } }));
    expect(asking.lines).toEqual([QUOTE_STRAIGHT_LINE]);
  });
  it("a quote made or waiting for approval: prices as before, nothing added", () => {
    for (const quote of ["ready", "awaiting_approval"] as const) {
      const b = block({ sites: { value: "2" }, biz: { value: "x" } }, quote);
      expect(quoteFlowStage(b)).toEqual({ block: b, lines: [] });
    }
  });
});

describe("A4 (c): the up-front instructions of a test call", () => {
  for (const c of input.cases) {
    it(`${c.id}: every instruction swap applies; no check_fit-before-quote, no early from-price, no price from search_catalog left`, () => {
      const classic = classicInstructions({ ...c, expectedLanguages: classicLanguages(c.language, c.seller.languages) });
      const buyer = guardedInstructions(classic, { gptToolRules: true });
      expect(swapsFound(buyer, INSTRUCTION_SWAPS)).toEqual(INSTRUCTION_SWAPS);
      const test = guardedInstructions(classic, { gptToolRules: true, quoteFlow: true });
      expect(test).toBe(quoteFlowInstructions(buyer));
      for (const s of [...INSTRUCTION_SWAPS, ...STAGE_SWAPS]) expect(test).not.toContain(s.from);
      expect(test).not.toMatch(/then check_fit|check_fit before quoting|"from" price|number or range from search_catalog|did not get from search_catalog/);
      // Only the swapped sentences differ: the same lines, in the same order.
      expect(test.split("\n")).toHaveLength(buyer.split("\n").length);
      // Buyer calls (the constant off): exactly as before (tests/unit/voice-current-unchanged.test.ts pins the hashes).
      expect(guardedInstructions(classic, { gptToolRules: true, quoteFlow: false })).toBe(buyer);
    });
  }
  it("the GPT tool rules: one line swapped on a test call", () => {
    expect(applySwaps(GPT_TOOL_RULES, INSTRUCTION_SWAPS)).toBe(GPT_TOOL_RULES.replace(
      "- Order: call dependent tools in order: first save the details with update_deal_state, then check_fit, then create_quote.",
      "- Order: call dependent tools in order: first save the details with update_deal_state, then create_quote (it checks the fit itself: no check_fit before it).",
    ));
  });
  it("the loader applies them on test calls only", () => {
    expect(callWiringV2For(true)).toBe(true);
    expect(callWiringV2For(false)).toBe(false);
  });
});
