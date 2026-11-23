/**
 * "Classic + guards" instructions: exactly the Classic (20 Nov) instructions (lib/voice-classic/instructions.ts, with
 * its reconciliations), plus these lines in the Classic voice block and nothing else:
 * - the hand-off: Current's two lines (offer first, the call goes on) instead of Classic's "the call ends there";
 * - one line to read a tool's prepared words (the quote summary, amounts in words) as written;
 * - Current's order_form_status line, where Current places it (before the order-form note line);
 * - a recorded call: Current's one recording rule, at the end of the voice block (where Current places it).
 * tests/unit/voice-guarded-instructions.test.ts asserts the result is Classic's plus exactly these.
 */
import type { Db } from "@/db/types";
import type { AgentVersion, Conversation, DealState, Lead, SellerAccount } from "@/db/schema";
import { voiceCallBlock as currentVoiceCallBlock } from "@/lib/agent/core/voice";
import { recordedCallRule } from "@/lib/voice/recording-settings";
import type { VoiceCallContext } from "@/lib/voice/instructions";
import { loadVoiceInstructions as loadClassicInstructions, type TranscriptLine } from "@/lib/voice-classic/instructions";

/** Classic's hand-off line (lib/voice-classic/voice-block.ts): replaced (K7). */
export const CLASSIC_HANDOFF_LINE = "- If the buyer is upset, complains, raises a legal or existing-customer issue, or insists: stop selling, call hand_off_to_human at once, say someone from the team will get back to them, and say goodbye: the call ends there.";
/** Classic's price line: the read-as-given line goes right after it. */
export const CLASSIC_PRICES_LINE = "- Say prices naturally, as a person would say them out loud; say a total once.";
/** The start of Classic's order-form note line: Current's order_form_status line goes right before it. */
export const CLASSIC_FORM_NOTE_LINE_START = "- A note from the system may say which step of the order form the buyer has open";

/** The one line that makes the prepared words of a tool result (the quote summary) be read as written (K6). */
export const READ_AS_GIVEN_LINE = "- When a tool result gives you words to say (say_this), say them as written: every amount exactly as given there, never worked out again from digits.";

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

/** The guarded instructions from Classic's (pure). `recorded`: the call is recorded (K8). */
export function guardedInstructions(classic: string, o: { recorded?: boolean } = {}): string {
  let out = replaceLine(classic, CLASSIC_HANDOFF_LINE, currentHandoffLines());
  out = replaceLine(out, CLASSIC_PRICES_LINE, [CLASSIC_PRICES_LINE, READ_AS_GIVEN_LINE]);
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

/** The lines guarded adds to Classic's instructions, in the order they appear (tests assert exactly these). */
export function guardedAddedLines(o: { recorded?: boolean } = {}): string[] {
  return [READ_AS_GIVEN_LINE, ...currentHandoffLines(), currentOrderFormStatusLine(), ...(o.recorded ? [recordedCallRule()] : [])];
}

/**
 * Loads a call's instructions as Classic does (the same data, opener and pick-up line) and adds the guarded lines.
 * The engine's own options beyond Classic's (the spoken language, its stage count) are not used: as Classic.
 */
export async function loadGuardedInstructions(
  db: Db,
  a: { account: SellerAccount; version: AgentVersion; conv: Conversation; lead: Lead; deal: DealState | null; now: Date },
  opts: { recap?: TranscriptLine[]; resumed?: boolean; woke?: boolean; recorded?: boolean } = {},
): Promise<VoiceCallContext> {
  const ctx = await loadClassicInstructions(db, a, { recap: opts.recap, resumed: opts.resumed, woke: opts.woke });
  return {
    instructions: guardedInstructions(ctx.instructions, { recorded: opts.recorded }),
    opener: ctx.opener, openerPrompt: ctx.openerPrompt, language: ctx.language, expectedLanguages: ctx.expectedLanguages, continuing: ctx.continuing,
  };
}
