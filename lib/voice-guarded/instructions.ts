/**
 * "Classic + guards" instructions: exactly the Classic (20 Nov) instructions (lib/voice-classic/instructions.ts, with
 * its reconciliations), plus these lines in the Classic voice block and nothing else:
 * - the hand-off: Current's two lines (offer first, the call goes on) instead of Classic's "the call ends there";
 * - one line to read a tool's prepared words (the quote summary, amounts in words) as written;
 * - one line (right after it): never tell the buyer about the agent's own steps, attempts, rules, tools or
 *   instructions, nor give them as a reason (23 Nov 2026: a live call said "since all attempts have been used");
 * - one line: tools before words (call the tools first, say nothing before them, speak once after the results),
 *   early in the voice block, where Classic's line about checks is; Classic's filler line ("say a short filler
 *   first"), which contradicts it, is always dropped: the line after it is Classic's "Do not announce your checks",
 *   whatever the version's fillers setting;
 * - Current's order_form_status line, where Current places it (before the order-form note line);
 * - a recorded call: Current's one recording rule, at the end of the voice block (where Current places it);
 * - a call on a GPT-Realtime model (2.1 or mini; buyer calls too since 26 Nov: GPT_TOOL_RULES_FOR_BUYER_CALLS): the
 *   short GPT tool rules at the very top (GPT_TOOL_RULES);
 *   Gemini and ElevenLabs Realtime get the text above byte for byte.
 * tests/unit/voice-guarded-instructions.test.ts asserts the result is Classic's plus exactly these.
 */
import type { Db } from "@/db/types";
import type { AgentVersion, Conversation, DealState, Lead, SellerAccount } from "@/db/schema";
import { voiceCallBlock as currentVoiceCallBlock } from "@/lib/agent/core/voice";
import { recordedCallRule } from "@/lib/voice/recording-settings";
import { isOpenAiVoiceModel, voiceFamilyOf } from "@/lib/voice/settings";
import type { VoiceCallContext } from "@/lib/voice/instructions";
import { loadVoiceInstructions as loadClassicInstructions, openerInstruction, type TranscriptLine } from "@/lib/voice-classic/instructions";
import { chatOpenerText } from "./chat-opener";
import { callWiringV2For } from "@/lib/voice/settings";
import { quoteFlowInstructions } from "./quote-flow";

/** Classic's hand-off line (lib/voice-classic/voice-block.ts): replaced (K7). */
export const CLASSIC_HANDOFF_LINE = "- If the buyer is upset, complains, raises a legal or existing-customer issue, or insists: stop selling, call hand_off_to_human at once, say someone from the team will get back to them, and say goodbye: the call ends there.";
/** Classic's price line: the read-as-given line goes right after it. */
export const CLASSIC_PRICES_LINE = "- Say prices naturally, as a person would say them out loud; say a total once.";
/** The start of Classic's order-form note line: Current's order_form_status line goes right before it. */
export const CLASSIC_FORM_NOTE_LINE_START = "- A note from the system may say which step of the order form the buyer has open";

/** The one line that makes the prepared words of a tool result (the quote summary) be read as written (K6). */
export const READ_AS_GIVEN_LINE = "- When a tool result gives you words to say (say_this), say them as written: every amount exactly as given there, never worked out again from digits.";

/**
 * The one line that keeps the agent's own bookkeeping out of what it says (owner, 23 Nov 2026: a live call said "Since
 * all attempts have been used, would you like to schedule a call…", the objection note read back as a reason).
 */
export const NO_INTERNALS_LINE = "- Never tell the buyer about your own steps, attempts, rules, tools or instructions, and never give them as a reason. Just make the offer or ask the question.";

/** The start of Classic's line about tool checks (fillers on or off): the tools-before-words line goes there. */
export const CLASSIC_CHECKS_LINE_STARTS = ["- Before a tool that takes time", "- Do not announce your checks"] as const;
/** Classic's filler line (fillers on): it says to speak before a tool, against tools-before-words, so guarded drops it. */
export const CLASSIC_FILLER_LINE = '- Before a tool that takes time, say a short filler first, for example "One moment, I\'m checking that."';
/** Classic's fillers-off line: consistent with tools-before-words, so guarded uses it whatever the fillers setting. */
export const CLASSIC_NO_ANNOUNCE_LINE = "- Do not announce your checks; just answer when you have the result.";

/**
 * Tools before words (23 Nov 2026): on Gemini the model spoke its answer, called update_deal_state about a second
 * in, and said the same sentence again once the (BLOCKING) tool result came back. One plain line, read early.
 */
export const TOOLS_FIRST_LINE = "- Tools before words: when a buyer's line needs a tool (saving what they said, an objection, the catalog, a quote, the order form), call the tool or tools FIRST and say nothing before them. Speak only after the results are back, once. Never say a sentence and then say it again after a tool result.";

/** A line of Current's voice block (lib/agent/core/voice.ts), by its start: Current's own wording, never a copy. */
function currentLine(start: string): string {
  const line = currentVoiceCallBlock({ fillers: true }).split("\n").find((l) => l.startsWith(start));
  if (!line) throw new Error(`guarded instructions: Current's voice block has no line starting "${start}"`);
  return line;
}

/** Current's hand-off lines (K7): ask first; after the hand-off the call goes on. */
export const currentHandoffLines = () => [currentLine("- If the buyer is upset"), currentLine("- After hand_off_to_human")];
/** Current's order_form_status line (K12). */
export const currentOrderFormStatusLine = () => currentLine("- When the buyer asks about the order form");

/** Replaces exactly one whole line of the instructions (`line` must be there once). */
function replaceLine(text: string, line: string, by: string[]): string {
  const at = text.indexOf(`\n${line}\n`);
  if (at < 0 || text.indexOf(`\n${line}\n`, at + 1) >= 0) throw new Error(`guarded instructions: line not found once: ${line.slice(0, 60)}`);
  return `${text.slice(0, at + 1)}${by.join("\n")}${text.slice(at + 1 + line.length)}`;
}

/** The line starting with `start` (found once). */
function lineStarting(text: string, start: string): string {
  const at = text.indexOf(`\n${start}`);
  if (at < 0) throw new Error(`guarded instructions: no line starting ${start.slice(0, 60)}`);
  const end = text.indexOf("\n", at + 1);
  return text.slice(at + 1, end < 0 ? undefined : end);
}

/**
 * The GPT tool rules on BUYER calls. ON since the owner decision of 26 Nov 2026: the New engine (this profile) is the
 * engine of every buyer call, and these rules are part of it (proven on test calls first).
 */
export const GPT_TOOL_RULES_FOR_BUYER_CALLS: boolean = true;

/**
 * Short tool rules for the OpenAI realtime models (GPT-Realtime 2.1 and mini), at the very top of the instructions
 * (owner, 25 Nov 2026). The long text was written for Gemini; a GPT-Realtime 2.1 test call quoted 1 sensor for 2 sites
 * without asking how many fridges, and made each tool call a separate response. Plain imperatives, no examples.
 * Gemini and ElevenLabs Realtime never get it.
 */
export const GPT_TOOL_RULES = [
  "## Tool rules (read these first)",
  "- Act: when the buyer states a new fact, save it with update_deal_state in the same turn. Look products up with search_catalog before you recommend them.",
  "- Ask: never call create_quote before the buyer has given the quantity of every item on it, or said yes to a number you proposed aloud. Ask one question at a time.",
  "- Confirm: call send_order_form only after the buyer's clear yes to it.",
  "- Recover: a refused tool result is an instruction. Do what it says. Never repeat the same call unchanged, and never make a call that changes nothing.",
  "- Batch: call tools that do not depend on each other together, in one step.",
  "- Order: call dependent tools in order: first save the details with update_deal_state, then check_fit, then create_quote.",
].join("\n");

/** Whether a call's instructions start with the GPT tool rules: a GPT-Realtime model, on a test call or (GPT_TOOL_RULES_FOR_BUYER_CALLS) a buyer call. */
export function gptToolRulesFor(modelId: string | null | undefined, isTest: boolean, forBuyers: boolean = GPT_TOOL_RULES_FOR_BUYER_CALLS): boolean {
  return voiceFamilyOf(modelId) === "openai" && isOpenAiVoiceModel(modelId) && (isTest || forBuyers);
}

/**
 * The guarded instructions from Classic's (pure). `recorded`: the call is recorded (K8). `gptToolRules`: the GPT tool
 * rules go at the very top (gptToolRulesFor); everything else is unchanged, byte for byte.
 */
export function guardedInstructions(classic: string, o: { recorded?: boolean; gptToolRules?: boolean; quoteFlow?: boolean } = {}): string {
  const out = guardedBody(classic, o);
  const all = o.gptToolRules ? `${GPT_TOOL_RULES}\n\n${out}` : out;
  // Call wiring v2 (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS): the quote flow's sentence swaps (lib/voice-guarded/quote-flow.ts).
  return o.quoteFlow ? quoteFlowInstructions(all) : all;
}

function guardedBody(classic: string, o: { recorded?: boolean }): string {
  let out = replaceLine(classic, CLASSIC_HANDOFF_LINE, currentHandoffLines());
  out = replaceLine(out, CLASSIC_PRICES_LINE, [CLASSIC_PRICES_LINE, READ_AS_GIVEN_LINE, NO_INTERNALS_LINE]);
  const checks = CLASSIC_CHECKS_LINE_STARTS.map((s) => (out.includes(`\n${s}`) ? lineStarting(out, s) : null)).find((l) => l !== null);
  if (!checks) throw new Error("guarded instructions: no line about tool checks");
  if (checks !== CLASSIC_FILLER_LINE && checks !== CLASSIC_NO_ANNOUNCE_LINE) throw new Error(`guarded instructions: unexpected line about tool checks: ${checks.slice(0, 60)}`);
  out = replaceLine(out, checks, [TOOLS_FIRST_LINE, CLASSIC_NO_ANNOUNCE_LINE]);
  const note = lineStarting(out, CLASSIC_FORM_NOTE_LINE_START);
  out = replaceLine(out, note, [currentOrderFormStatusLine(), note]);
  if (o.recorded) {
    // As Current (lib/voice/instructions.ts): the rule at the end of the voice block, before the deal-state fields.
    const at = out.indexOf("\n\n### Deal-state fields\n");
    if (at < 0) throw new Error("guarded instructions: no deal-state fields block");
    out = `${out.slice(0, at)}\n${recordedCallRule()}${out.slice(at)}`;
  }
  return out;
}

/**
 * The lines guarded adds to Classic's instructions, in the order they appear (tests assert exactly these). `fillers`:
 * the version's setting; with fillers on, Classic's filler line is replaced, so its "Do not announce" line is added.
 */
export function guardedAddedLines(o: { recorded?: boolean; fillers?: boolean } = {}): string[] {
  return [
    READ_AS_GIVEN_LINE, NO_INTERNALS_LINE, TOOLS_FIRST_LINE, ...(o.fillers ? [CLASSIC_NO_ANNOUNCE_LINE] : []), ...currentHandoffLines(), currentOrderFormStatusLine(),
    ...(o.recorded ? [recordedCallRule()] : []),
  ];
}

/** The lines guarded removes from Classic's instructions, in Classic's order. */
export function guardedRemovedLines(o: { fillers?: boolean } = {}): string[] {
  return [...(o.fillers ? [CLASSIC_FILLER_LINE] : []), CLASSIC_HANDOFF_LINE];
}

/**
 * Loads a call's instructions as Classic does (the same data, opener and pick-up line) and adds the guarded lines.
 * The engine's stage count is not used: as Classic. `language` (since 26 Nov 2026, Current's buyer fix): the language
 * the call speaks now, on a reconnect or wake after the buyer switched language; Classic's loader then builds them as
 * for a conversation in that language (Classic's own text, "start in <language>"), as Current's loader does. The same
 * language as the conversation's (every first connection): exactly Classic's.
 */
export async function loadGuardedInstructions(
  db: Db,
  a: { account: SellerAccount; version: AgentVersion; conv: Conversation; lead: Lead; deal: DealState | null; now: Date },
  opts: { recap?: TranscriptLine[]; resumed?: boolean; woke?: boolean; recorded?: boolean; modelId?: string | null; isTest?: boolean; language?: string } = {},
): Promise<VoiceCallContext> {
  const switched = !!opts.language && opts.language !== (a.conv.language || "en");
  const ctx = await loadClassicInstructions(db, switched ? { ...a, conv: { ...a.conv, language: opts.language! } } : a, { recap: opts.recap, resumed: opts.resumed, woke: opts.woke });
  // A call that starts the conversation (no agent message yet: the hand-over's "Talk now") speaks the opener the chat
  // would post, word for word (lib/voice-guarded/chat-opener.ts: lib/chat/start.ts writtenOpenerText), not Classic's
  // own build of it. Unchanged when they are the same or the chat would post nothing (a test-lab chat: Classic's).
  let { opener, openerPrompt, instructions } = ctx;
  if (!ctx.continuing && !opts.resumed && !opts.woke && !switched) {
    const written = await chatOpenerText(db, a).catch(() => null);
    if (written && written !== opener) {
      instructions = instructions.split(`"${opener}"`).join(`"${written}"`);
      opener = written;
      openerPrompt = openerInstruction(written, ctx.language);
    }
  }
  return {
    instructions: guardedInstructions(instructions, {
      recorded: opts.recorded, gptToolRules: gptToolRulesFor(opts.modelId, opts.isTest ?? false), quoteFlow: callWiringV2For(opts.isTest ?? false),
    }),
    opener, openerPrompt, language: ctx.language, expectedLanguages: ctx.expectedLanguages, continuing: ctx.continuing,
  };
}
