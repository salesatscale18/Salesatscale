/**
 * Call wiring v2 (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS, lib/voice/settings.ts), owner, 27 Nov 2026: the quote
 * flow on a call. Recommend first; prices come only from the quote; straight to create_quote (it checks the fit
 * itself), with new facts saved in the same step. A buyer who asks the price before a quote exists gets no number:
 * the agent says in one short sentence that it will give the exact price in a moment, asks the one thing still
 * missing (or confirms the set), then quotes.
 *
 * Nothing here edits lib/agent or lib/voice-classic: the guarded profile swaps whole sentences in ITS OWN output (the
 * call-worded stage block of a tool result, and the guarded up-front instructions of a test call). A sentence that is
 * not there (another playbook, another version of the text) is simply not swapped; tests pin that every swap applies
 * to the golden inputs. Buyer calls get none of it while the constant is off.
 */

export type Swap = { readonly from: string; readonly to: string };

/** "Say you will give the exact price in a moment" (the words the owner asked for), shared by the swaps below. */
const PRICE_IN_A_MOMENT = "give no number before the quote: say in one short sentence that you will give the exact price in a moment, ask the one thing still missing (or confirm the set), then call create_quote";

/** Sentences of the stage block (call wording, lib/agent/core/stage.ts through classicStageText) swapped on a call. */
export const STAGE_SWAPS: readonly Swap[] = [
  {
    // 2 Understand, price asked.
    from: "Do: answer the price now with a number or range from search_catalog, say in a few words what it depends on, then ask only what the quote cannot be made without.",
    to: "Do: give no number yet: say in one short sentence that you will give the exact price in a moment, then ask only the one thing the quote still cannot be made without (or confirm the set), then call create_quote.",
  },
  {
    // "Prices: not yet" (stages 1-3, and the instructions' own stage block).
    from: "If the buyer asks the price, call update_deal_state with price_asked true, then answer with a number or range from search_catalog.",
    to: `If the buyer asks the price, call update_deal_state with price_asked true and ${PRICE_IN_A_MOMENT}.`,
  },
  {
    // 4 Quote and close, nothing missing.
    from: "Do: call create_quote now (check_fit first).",
    to: "Do: call create_quote now. Do not call check_fit first: create_quote checks the fit itself. Save new facts with update_deal_state in the same step.",
  },
];

/** The prices line before a quote exists (stages 2-4): prices only from the quote. */
export const PRICES_ALLOWED_LINE = "Prices: allowed. Take every number from the tools.";
export const PRICES_FROM_QUOTE_LINE = "Prices: only from create_quote. State no price and no total before the quote is made.";

/** Added to the 3 Recommend block on a call. */
export const RECOMMEND_LINE = "Present one set in plain words, no prices, and ask if it fits. You have no prices yet.";
/** Added to a 4 Quote and close block that still asks for something first (its Do line has no "call create_quote now"). */
export const QUOTE_STRAIGHT_LINE = "Then call create_quote. Do not call check_fit first: create_quote checks the fit itself. Save new facts with update_deal_state in the same step.";

/** Sentences of the guarded up-front instructions swapped on a test call (the stage swaps apply there too). */
export const INSTRUCTION_SWAPS: readonly Swap[] = [
  {
    // GPT tool rules (lib/voice-guarded/instructions.ts GPT_TOOL_RULES).
    from: "- Order: call dependent tools in order: first save the details with update_deal_state, then check_fit, then create_quote.",
    to: "- Order: call dependent tools in order: first save the details with update_deal_state, then create_quote (it checks the fit itself: no check_fit before it).",
  },
  {
    // Core design, "4. Quote and close".
    from: "call update_deal_state with recommendation_confirmed true, then check_fit and create_quote, all in the same turn.",
    to: "call update_deal_state with recommendation_confirmed true and create_quote, in the same turn (create_quote checks the fit itself: no check_fit before it).",
  },
  {
    // "The buyer asks the price early".
    from: "call update_deal_state with price_asked true, then answer at once in one or two plain sentences: the total for what they described, or the entry price and what it depends on, from search_catalog. Before the quantities are known, word it as a \"from\" price (for example \"from <price> per <unit>\"). No list of items. Then carry on.",
    to: `call update_deal_state with price_asked true and ${PRICE_IN_A_MOMENT}. No list of items.`,
  },
  {
    from: "- Before recommending products, look them up with search_catalog; check combinations with check_fit before quoting.",
    to: "- Before recommending products, look them up with search_catalog (it gives no prices on a call); create_quote checks combinations itself.",
  },
  {
    from: "Never state a price, total or discount you did not get from search_catalog, check_fit, check_offer or create_quote.",
    to: "On a call, state a price, total or discount only from create_quote or check_offer, never before the quote is made.",
  },
  {
    // The card "Price asked early".
    from: "Do: 1) Answer at once with a real number or range, in one or two plain sentences, no list. 2) Say in a few words what it depends on. 3) Ask the one question that makes it exact.",
    to: "Do: 1) Give no number before the quote: say in one short sentence that you will give the exact price in a moment. 2) Ask the one question that makes it exact (or confirm the set). 3) Then call create_quote.",
  },
  {
    from: "Example: \"It starts at <price>, and the total depends on <what drives it>. How many <units> do you need?\"",
    to: "Example: \"I'll give you the exact price in a moment. How many <units> do you need?\"",
  },
];

/** Applies each swap whose sentence is there (every occurrence). */
export function applySwaps(text: string, swaps: readonly Swap[]): string {
  let out = text;
  for (const s of swaps) if (out.includes(s.from)) out = out.split(s.from).join(s.to);
  return out;
}

/** The swaps that would apply to this text (tests: every one on the golden inputs). */
export const swapsFound = (text: string, swaps: readonly Swap[]) => swaps.filter((s) => text.includes(s.from));

/** The up-front instructions of a test call (call wiring v2): the instruction and stage swaps. */
export function quoteFlowInstructions(instructions: string): string {
  return applySwaps(applySwaps(instructions, INSTRUCTION_SWAPS), STAGE_SWAPS);
}

const STAGE = /^## Stage now: ([^\n]+)/;
const HELD = /waits for the seller's approval/;

/**
 * A call-worded stage block on a tool result (call wiring v2): the stage swaps; before a quote exists (stages 2-4,
 * not while one waits for approval) prices only from the quote; Recommend: present one set, no prices; Quote and
 * close: straight to create_quote. Returns the block and the lines to add after it.
 */
export function quoteFlowStage(block: string): { block: string; lines: string[] } {
  const title = STAGE.exec(block)?.[1] ?? "";
  let out = applySwaps(block, STAGE_SWAPS);
  const beforeQuote = /^(2 Understand|3 Recommend|4 Quote and close)\b/.test(title) && !HELD.test(block);
  if (beforeQuote) out = out.split("\n").map((l) => (l === PRICES_ALLOWED_LINE ? PRICES_FROM_QUOTE_LINE : l)).join("\n");
  const lines: string[] = [];
  if (title.startsWith("3 Recommend")) lines.push(RECOMMEND_LINE);
  if (title.startsWith("4 Quote and close") && beforeQuote && !out.includes("Do not call check_fit first")) lines.push(QUOTE_STRAIGHT_LINE);
  return { block: out, lines };
}
