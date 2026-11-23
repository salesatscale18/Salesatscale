/**
 * "Classic + guards" (test lab engine "guarded", owner, 23 Nov 2026): today's voice engine (lib/voice/engine.ts) run
 * with the Classic (20 Nov) model side. Toward the model it is Classic: the 20 Nov voice block and tables with
 * Classic's reconciliations (lib/voice-classic/instructions.ts), Classic's tools and session fields, Classic's
 * result shaping (the full update_deal_state result with its stage block), notes, injected lines and opener, no
 * language notes, and transcripts stored as said (no cleaner). Added, each silent until it fires:
 * - K1 the order form only after the buyer's yes (Current's guard and refusal);
 * - K2 a number the buyer stated is not lowered on an ambiguous yes;
 * - K3 an auto-added line comes off only when the buyer asked;
 * - K4 a refused quote: what is missing, and no total;
 * - K5/K6 a created quote: a short spoken summary, every amount in words (say_this);
 * - K7 the hand-off asks first and keeps the call (Current's lines and result);
 * - K8 recording as Current (the rule in the voice block, the notice in the opener once per conversation);
 * - K12 order_form_status offered.
 * Everything else (the opener's wait for the browser, one agent at a time, heartbeat, stale close, end-of-call
 * writes, the provider close handling, backpressure, logs, Gemini and the GPT realtime models) is the engine's own.
 * The instruction lines added: lib/voice-guarded/instructions.ts guardedAddedLines.
 */
import type { VoiceProfile } from "@/lib/voice/engine";
import { realtimeTools as currentRealtimeTools, ORDER_FORM_STATUS_TOOL, type SchemaFamily } from "@/lib/voice/tool-schema";
import { realtimeTools as classicRealtimeTools } from "@/lib/voice-classic/tool-schema";
import { classicStageText } from "@/lib/voice-classic/instructions";
import { voiceToolResultMessage as classicResultMessage } from "@/lib/voice-classic/voice-block";
import { GUARDED_ENGINE } from "@/lib/voice-classic/engine-choice";
import { loadGuardedInstructions } from "./instructions";
import { loadQuoteSummary } from "./quote-summary";

/** The model's tools: Classic's (today's tools and Classic's end_call, the 20 Nov descriptions), plus order_form_status (K12, Current's). */
export function guardedTools(family: SchemaFamily) {
  return [...classicRealtimeTools(family), ...currentRealtimeTools(family, [ORDER_FORM_STATUS_TOOL])];
}

/**
 * create_quote's message on a guarded call when the quote is ready (K5, owner: the walkthrough, shortened). It
 * replaces the tool's chat message ("Do not repeat the lines or totals"), which the summary contradicts.
 */
export function guardedQuoteMessage(quote: string): string {
  return `The quote${quote ? ` ${quote}` : ""} is in the chat. Say say_this now, as written, every amount exactly as given there (never worked out again from digits); then add only your closing question.`;
}

export const GUARDED_PROFILE: VoiceProfile = {
  engine: GUARDED_ENGINE,
  loadInstructions: loadGuardedInstructions,
  tools: guardedTools,
  // T4: what was said and transcribed is stored and shown as is.
  clean: (text) => text,
  stageText: (stage) => classicStageText(stage),
  resultMessage: classicResultMessage,
  quoteMessage: guardedQuoteMessage,
  quoteSummary: loadQuoteSummary,
};
