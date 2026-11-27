/**
 * Call wiring v2 (test calls; buyer calls when CALL_WIRING_V2_FOR_BUYER_CALLS is on, lib/voice/settings.ts): the
 * current step on EVERY tool result of a guarded call, not only on update_deal_state's. Before, the model saw the
 * stage only at the start of the connection and in update_deal_state results, so after create_quote it acted on the
 * block it last saw ("4 Quote and close: call create_quote now") although the quote was made.
 *
 * - The block is the one update_deal_state gives (loadStageFacts + deriveStage, in the call's wording), derived by
 *   the engine after the tool ran (lib/voice/engine.ts callStage).
 * - Full block when the stage or what is still missing for a quote changed since the last block THIS model
 *   connection received (a reconnect starts with none), else one short line: `unchanged: <N> <title>`.
 * - update_deal_state keeps its own block (never a second one); it counts as delivered.
 * - A result with a line to say (`say_this`: a ready quote's summary, a held quote's line) keeps its message first:
 *   when the block's "Do:" would have the agent say something now, the block is trimmed to its title and its
 *   "Moves on when" line, so the two never ask for different words.
 * - Not on end_call (the goodbye only), record_opt_out (the exact reply only) or hand_off_to_human (no more selling):
 *   their results ask for nothing but that.
 * Pure: the engine reads the database and decides when it applies.
 */

/** Tools whose result asks for one fixed thing: no stage block on them. */
export const STAGE_SKIP_TOOLS: ReadonlySet<string> = new Set(["end_call", "record_opt_out", "hand_off_to_human"]);

const TITLE = /## Stage now: ([^\n]+)/;
const MISSING = /Still missing for a quote: ([^\n]*)/;

/** The stage title of a block ("5 Order form"), or null when it has none. */
export function stageTitleOf(block: string): string | null {
  return TITLE.exec(block)?.[1]?.trim() ?? null;
}

/** The quote-needs line a profile adds (lib/voice-guarded/stage-hints.ts): what is not grounded yet is part of what is missing. */
const QUOTE_NEEDS = /^Before create_quote: [^\n]*$/m;

/**
 * What makes two blocks different for the model: the title and what is still missing for a quote (as stageKey), with
 * the quantities not given yet when the block says them.
 */
export function callStageKey(block: string): string {
  const missing = MISSING.exec(block)?.[1]?.trim() ?? "";
  const needs = QUOTE_NEEDS.exec(block)?.[0] ?? "";
  return `${stageTitleOf(block) ?? block}|${missing}${needs ? `|${needs}` : ""}`;
}

/**
 * What a quote still needs on this call (call wiring v2), from the quote-quantities guard's own checks: `known`, the
 * model named items for a quote; `notGiven`, those (not tied to sites) whose quantity the buyer has not given or
 * agreed to; `perSiteAdded`, the items the catalog adds once per site. Names as the agent says them.
 */
export type QuoteNeeds = { known: boolean; notGiven: string[]; perSiteAdded: string[] };

/** A "Do:" that asks the agent to say something now (it would compete with `say_this`). */
const SPEAK_NOW = /^Do: (tell|say|answer|recommend|react|this is your first)/m;

/** Whether the block's "Do:" asks for words of its own, next to a result that gives the words to say. */
export function conflictsWithSayThis(block: string): boolean {
  return SPEAK_NOW.test(block);
}

/** The block cut to its title and its "Moves on when" line. */
export function trimmedStage(block: string): string {
  const lines = block.split("\n");
  return lines.filter((l, i) => i === 0 || l.startsWith("Moves on when:")).join("\n");
}

/** The short form of a block the model already has. */
export const unchangedStage = (title: string) => `unchanged: ${title}`;

/**
 * The result with its stage, and the key it delivers. `own`: the tool already carries this block (update_deal_state).
 * `last`: the key this model connection last received (null: none).
 */
export function callStageResult(o: { forModel: Record<string, unknown>; block: string; title: string | null; own: boolean; last: string | null }): { forModel: Record<string, unknown>; key: string } {
  const key = callStageKey(o.block);
  if (o.own) return { forModel: o.forModel, key };
  const title = o.title ?? stageTitleOf(o.block) ?? "";
  if (key === o.last) return { forModel: { ...o.forModel, stage: unchangedStage(title) }, key };
  const block = typeof o.forModel.say_this === "string" && conflictsWithSayThis(o.block) ? trimmedStage(o.block) : o.block;
  return { forModel: { ...o.forModel, stage: block }, key };
}
