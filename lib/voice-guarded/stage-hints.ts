/**
 * Call wiring v2 (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS, lib/voice/settings.ts): what a quote needs, said
 * BEFORE the agent tries create_quote, in the stage block a call's tool result carries (the profile's `stageHints`,
 * after Classic's stage wording; never in the up-front instructions). Built from the quote-quantities guard's own
 * checks (lib/voice/quote-quantities.ts, read by the engine): stages 2 Understand, 3 Recommend and 4 Quote and close
 * (not while a quote waits for the team's approval).
 * - "Before create_quote: every quantity must be a number the buyer said or agreed to." Then, when the model already
 *   named items whose quantity is not grounded yet: "Not given yet: how many <items>. Ask that before you quote."
 * - For each item the catalog adds once per site (an installation): keep it, and do not offer to remove it unless
 *   the buyer asks (a test call offered to take the installation off).
 */
import type { QuoteNeeds } from "@/lib/voice/call-stage";

/** The stages before a quote, where what it needs is said. */
const QUOTE_STAGES = /^## Stage now: (2 Understand|3 Recommend|4 Quote and close)\b/m;
/** Stage 4 while a quote waits for the team: nothing to quote. */
const HELD = /waits for the seller's approval/;

export const QUOTE_NEEDS_LINE = "Before create_quote: every quantity must be a number the buyer said or agreed to.";

const listOf = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The lines for what a quote needs (pure). */
export function quoteNeedsLines(n: QuoteNeeds): string[] {
  const lines = [n.notGiven.length ? `${QUOTE_NEEDS_LINE} Not given yet: how many ${listOf(n.notGiven)}. Ask that before you quote.` : QUOTE_NEEDS_LINE];
  for (const item of n.perSiteAdded) lines.push(`${capital(item)} is added automatically for each site: keep it; do not offer to remove it unless the buyer asks.`);
  return lines;
}

/** The guarded profile's hook: the lines after a stage block of stages 2-4; none otherwise (and no database read). */
export async function guardedStageHints(block: string, needs: () => Promise<QuoteNeeds>): Promise<string[]> {
  if (!QUOTE_STAGES.test(block) || HELD.test(block)) return [];
  return quoteNeedsLines(await needs());
}
