/**
 * THINKING (pipeline proof): one buyer turn of the call answered by the text chat agent, exactly as in chat
 * (lib/channels/whatsapp.ts replyToBuyer → lib/agent/turn.ts runBuyerTurn with buyerMessageStored: tools first,
 * then one reply, its rows and cards stored by the chat turn, its model usage recorded by the chat turn).
 *
 * The only call into the chat lane, isolated here. One agent at a time (lib/voice/one-agent.ts): while this call's
 * session is live, textTurnBlocked refuses every chat turn on the conversation (status "in_call") except this call's
 * own: replyToBuyer / runBuyerTurn take `callSessionId`, passed through as textTurnBlocked's `exceptSessionId`.
 */
import type { Db } from "@/db/types";
import type { LlmClient } from "@/lib/agent/llm";
import type { TurnResult } from "@/lib/agent/turn";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { PIPELINE_CALL_CONTEXT_LINE, PIPELINE_CALL_REPLY_ARG_DESCRIPTION } from "./models";

export type CallTurnArgs = { accountId: string; conversationId: string; leadId: string; text: string; callSessionId: string };
/** The chat turn's outcome, as the engine needs it. */
export type CallTurnResult = TurnResult;
export type CallTurnFn = (db: Db, llm: LlmClient, a: CallTurnArgs) => Promise<CallTurnResult>;

/** The log name of this trigger (textTurnBlocked's log line, and the tests' stand-in for the exception). */
export const PIPELINE_TURN_TRIGGER = "pipeline call";

/**
 * Runs the chat turn for a buyer line this call already stored (the buyer row is the caller's: buyerMessageStored).
 * Transport null: a test-lab conversation sends nothing anywhere; the reply is the chat row it stores.
 * `replyArgDescription`: update_deal_state's spoken_reply description (models.ts PIPELINE_CALL_REPLY_ARG_DESCRIPTION,
 * PROVISIONAL), ready in `replyArg` for when replyToBuyer accepts `callReplyArgDescription` (the PIPELINE-HOOK line).
 */
export function makeCallTurn(contextLine: string = PIPELINE_CALL_CONTEXT_LINE, replyArgDescription: string = PIPELINE_CALL_REPLY_ARG_DESCRIPTION): CallTurnFn {
  const replyArg = callReplyArgOption(replyArgDescription);
  return async (db, llm, a) => {
    // Transport null: nothing is delivered anywhere. callSessionId: this call's own turn passes the one-agent block, and
    // the chat turn stamps its reply with the session (never spokenAtMs/answerMs: the engine sets those when it speaks).
    const options = callTurnOptions(a.callSessionId, contextLine);
    // PIPELINE-HOOK: pass callReplyArgDescription once replyToBuyer accepts it (the flip: `options` → `{ ...options, ...replyArg }`)
    void replyArg;
    const out = await replyToBuyer(db, llm, null, { accountId: a.accountId, conversationId: a.conversationId, leadId: a.leadId, text: a.text }, options);
    return out.turn;
  };
}

/**
 * replyToBuyer's future `callReplyArgDescription` option for a call turn: the description of update_deal_state's
 * optional spoken_reply argument (models.ts PIPELINE_CALL_REPLY_ARG_DESCRIPTION, PROVISIONAL wording); the property
 * is left out when the description is empty (off).
 */
export function callReplyArgOption(description: string): { callReplyArgDescription?: string } {
  const d = description.trim();
  return d ? { callReplyArgDescription: d } : {};
}

/**
 * replyToBuyer's options for a call turn: the trigger, this call's session and the call's context line
 * (models.ts PIPELINE_CALL_CONTEXT_LINE, PROVISIONAL wording); the property is left out when the line is empty (off).
 */
export function callTurnOptions(callSessionId: string, contextLine: string): { trigger: string; callSessionId: string; callContextLine?: string } {
  const line = contextLine.trim();
  return { trigger: PIPELINE_TURN_TRIGGER, callSessionId, ...(line ? { callContextLine: line } : {}) };
}

/** The call turn with the call's context line (the engine's default turn). */
export const runCallTurn: CallTurnFn = makeCallTurn();
