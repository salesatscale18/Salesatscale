/**
 * Call turns only (runBuyerTurn with a valid callSessionId, the voice pipeline): "reply with bookkeeping".
 * When one model response holds the spoken reply and only bookkeeping tool calls, the turn runs the tools and
 * finishes with that reply, with no second model round, unless a tool result says something the reply must
 * reflect. Chat turns never use any of this. Pure: unit-tested in tests/unit/call-reply.test.ts.
 */
import type { ToolResult } from "./tools";

/**
 * Tools whose result never carries anything the buyer must hear, so a reply written next to them stands.
 * Only update_deal_state: it records what the buyer said; its result is an acknowledgement plus the stage block,
 * which the guard below checks. Every other tool's result carries words, numbers, links or an instruction for the
 * reply (search_catalog, check_fit, lookup_knowledge, create_quote, send_order_form, check_payment, request_callback,
 * schedule_follow_up: the time to confirm; ask_team: an answer already given, or how to word the promise;
 * hand_off_to_human and record_opt_out: a fixed next line), so they always get the normal next round.
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["update_deal_state"]);

/**
 * The keys of an update_deal_state result that are acknowledgements only. Any other key (rejected_placeholder,
 * message, objection_note, or a key added later) means the result tells the model something: normal next round.
 */
const ACK_KEYS: ReadonlySet<string> = new Set([
  "ok", "saved", "ignored_unknown", "kept_verified", "recorded", "recorded_as_asked", "objection_recorded", "still_needed_before_quote", "stage",
]);

/**
 * The stage block as compared before and after (lib/agent/core/stage.ts deriveStage instruction). Lines that only
 * list field progress the reply itself caused (what is still missing, what was asked and not answered, the
 * number of questions left) are left out; every other line, the stage title, the Do lines, Prices and Paused,
 * must be the same as the block the model last read, or the reply may be missing what the new block asks for.
 */
export function comparableStage(instruction: string): string {
  return instruction
    .split("\n")
    .filter((l) => !l.startsWith("Still missing for a quote:") && !l.startsWith("Asked and not answered:"))
    .map((l) => l.replace(/You have \d+ questions? left/, "You have N questions left"))
    .join("\n");
}

/**
 * Why a bookkeeping result needs the normal next round, or null when it only says "saved, nothing new to tell
 * you". `seenStage`: the stage block the model last read (the per-turn context, or an earlier result of this turn).
 */
export function bookkeepingNeedsRound(name: string, r: ToolResult, seenStage: string): string | null {
  if (!BOOKKEEPING_TOOLS.has(name)) return "not a bookkeeping tool";
  if (r.outcome !== "ok" || r.result.ok !== true) return `outcome ${r.outcome}`;
  const extra = Object.keys(r.result).filter((k) => !ACK_KEYS.has(k));
  if (extra.length) return `result carries ${extra.join(", ")}`;
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (nonEmpty(r.result.ignored_unknown)) return "unknown fields ignored";
  if (nonEmpty(r.result.kept_verified)) return "verified fields kept";
  if (typeof r.result.stage !== "string") return "no stage in the result";
  if (comparableStage(r.result.stage) !== comparableStage(seenStage)) return "stage block changed";
  return null;
}

/** The longest caller-supplied call context line (runBuyerTurn callContextLine). */
export const CALL_CONTEXT_LINE_MAX = 600;

/** The caller's call context line as one trimmed line, capped; empty when there is nothing to add. */
export function callContextLineOf(line: string | undefined | null): string {
  if (typeof line !== "string") return "";
  return line.replace(/\s+/g, " ").trim().slice(0, CALL_CONTEXT_LINE_MAX).trim();
}
