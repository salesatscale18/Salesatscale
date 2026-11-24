/**
 * THINKING (pipeline proof): one buyer turn of the call answered by the text chat agent, exactly as in chat
 * (lib/channels/whatsapp.ts replyToBuyer → lib/agent/turn.ts runBuyerTurn with buyerMessageStored: tools first,
 * then one reply, its rows and cards stored by the chat turn, its model usage recorded by the chat turn).
 *
 * The only call into the chat lane, isolated here. One agent at a time (lib/voice/one-agent.ts): while this call's
 * session is live, runBuyerTurn's textTurnBlocked refuses every chat turn on the conversation (status "in_call"),
 * this call's own turns too. The agreed fix (chat lane, not in main yet): replyToBuyer / runBuyerTurn take an
 * optional `callSessionId`, passed through as textTurnBlocked's `exceptSessionId`, so only this call's own turns pass.
 */
import type { Db } from "@/db/types";
import type { LlmClient } from "@/lib/agent/llm";
import type { TurnResult } from "@/lib/agent/turn";
import { replyToBuyer } from "@/lib/channels/whatsapp";

export type CallTurnArgs = { accountId: string; conversationId: string; leadId: string; text: string; callSessionId: string };
/** The chat turn's outcome, as the engine needs it. */
export type CallTurnResult = TurnResult;
export type CallTurnFn = (db: Db, llm: LlmClient, a: CallTurnArgs) => Promise<CallTurnResult>;

/** The log name of this trigger (textTurnBlocked's log line, and the tests' stand-in for the exception). */
export const PIPELINE_TURN_TRIGGER = "pipeline call";

/**
 * Runs the chat turn for a buyer line this call already stored (the buyer row is the caller's: buyerMessageStored).
 * Transport null: a test-lab conversation sends nothing anywhere; the reply is the chat row it stores.
 */
export const runCallTurn: CallTurnFn = async (db, llm, a) => {
  const out = await replyToBuyer(db, llm, null, { accountId: a.accountId, conversationId: a.conversationId, leadId: a.leadId, text: a.text },
    // PIPELINE-HOOK: pass callSessionId once replyToBuyer accepts it
    { trigger: PIPELINE_TURN_TRIGGER });
  return out.turn;
};
