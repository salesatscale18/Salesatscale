/**
 * One voice call (live voice). The engine knows nothing about WebSockets: the
 * transport (a route handler) feeds it the browser's messages and audio and
 * forwards what it `send`s. It owns the realtime model connection, runs the
 * agent's REAL tools (lib/agent/tools.ts runTool, the same code as chat),
 * stores the call's transcript as conversation messages with their tool calls
 * (exactly like lib/agent/turn.ts, so the trace, describeCall and the scenario
 * checks work unchanged), enforces the call limits and prices the call.
 *
 * Every end path closes the model connection: a paid socket is never left open.
 * All database work runs through one serial queue, so messages keep their order.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, leads, messages, quoteLines, quotes, quoteVersions, sellerAccounts, toolCalls, voiceSessions,
  type AgentVersion, type Conversation, type Lead, type SellerAccount, type VoiceEndBy, type VoiceEndDetail, type VoiceEndReason, type VoiceSession,
} from "@/db/schema";
import { readDealState } from "@/lib/agent/service";
import { formatMoney } from "@/lib/domain/money";
import { isLocale } from "@/lib/i18n";
import { writtenByAgent } from "@/lib/agent/core/stage";
import { latestBookingOffer } from "@/lib/team-calls/service";
import { voiceCallEndedLine } from "@/lib/agent/thread-markers";
import { runTool, type ToolContext, type ToolResult, type TurnMemo } from "@/lib/agent/tools";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { voiceStageText, voiceToolResultMessage } from "@/lib/agent/core/voice";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { RealtimeUsageAccumulator, voiceCallCost, type VoiceCallTimes, type VoiceCallUsageRecord } from "@/lib/ai/models";
import type { ClientMessage, ServerMessage, VoiceErrorCode, VoiceState } from "./protocol";
import { systemClock, type Clock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig, type RealtimeToolDef, type TimerHandle } from "./realtime";
import { isSpokenOptOut, maskCardNumbers, maskPartialDigits } from "./safety";
import { languageNameEn, loadVoiceInstructions, RECAP_LINES, type TranscriptLine, type VoiceCallContext } from "./instructions";
import { callVoice, isProvenVoiceModel, maxCallSeconds, MODEL_DEFAULT_VOICE, resolveVoiceSettings, turnTakingFor, versionModelId } from "./settings";
import { realtimeTools, schemaFamilyOf, toolLabel, VOICE_TOOL_NAMES, type SchemaFamily } from "./tool-schema";
import { CALL_RULES } from "./call-rules";
import { orderFormAgreed, smallerQuoteAgreed, smallerQuoteParts } from "./form-agreement";
import { EnergyVad, PcmRing, type VadOptions } from "./vad";
import { pcmDurationMs } from "./protocol";
import { FormContextNotes, orderFormStatus } from "./form-context";
import { cleanTranscript, transcriptWords } from "./transcript-clean";
import { clip, consoleVoiceLog, errorSummary, textPrint, voiceLine, type VoiceLog } from "./log";
import { CallRecorder, recordingPrefix, recordingStoreFor, type RecordingStore } from "./recording";
import { limitFinishSec } from "./socket-limits";
import { recordingNoticeText, resolveRecordingSettings, withRecordingNotice } from "./recording-settings";
import type { Speaker } from "@/lib/voice-pipeline/speaker";
import { PIPELINE_TIMING, PIPELINE_VOICE_NAME } from "@/lib/voice-pipeline/models";
import { spokenForm, splitSentences } from "@/lib/voice-pipeline/spoken";
import { SpeechPlayer, type SpeechJob } from "@/lib/voice-rt-eleven/player";
import { rtRealtimeCost, rtSpeakCost } from "@/lib/voice-rt-eleven/cost";
import { medianOf, type RtElevenUsage } from "@/lib/voice-rt-eleven/summary";

/** Timings of a call. Defaults are the product's; tests shorten them. */
export type VoiceLimits = {
  /** Seconds left in the hosting function: the call ends before it. */
  deadlineSec?: number | null;
  /** Env for VOICE_MAX_CALL_SECONDS (default process.env). */
  env?: Record<string, string | undefined>;
  /** Warn this many seconds before the time limit. */
  limitWarnSec?: number;
  /** Standby and stop rules (lib/voice/call-rules.ts CALL_RULES has the product values). */
  standbyAfterQuietMs?: number;
  standbyIdleEndMs?: number;
  preRollMs?: number;
  wakeBufferMaxMs?: number;
  wakeConnectMs?: number;
  falseWakeMs?: number;
  falseWakesBeforeRaise?: number;
  maxThresholdBoost?: number;
  minWakeGapMs?: number;
  /** The standby speech detector (lib/voice/vad.ts). */
  vad?: VadOptions;
  /** One reconnect must succeed within this. */
  reconnectMs?: number;
  /** After a hand-off or opt-out, the agent may finish its sentence for this long. */
  endGraceMs?: number;
  /** How often `{t:'stats'}` goes out. */
  statsEveryMs?: number;
  /** How often the live row gets the call's provisional duration and usage (the heartbeat; lib/voice/service.ts stale close). */
  heartbeatMs?: number;
  /** The browser said it will send `{t:"ready"}` when it can play (auth `waitAudio`): the opening line waits for it. */
  waitForClientAudio?: boolean;
  /** The longest the opening line waits for the browser's `ready`. */
  clientReadyMs?: number;
};

/** A call of at least this long is warned LIMIT_WARN_LONG_SEC before its time limit (owner, 23 Nov 2026). */
export const LIMIT_WARN_LONG_FROM_SEC = 120;
export const LIMIT_WARN_LONG_SEC = 60;

/** Seconds before the time limit the call is warned: 60 on a call of two minutes or more, else `shortWarnSec` (45). */
export function limitWarnSecFor(maxSec: number, shortWarnSec: number): number {
  return maxSec >= LIMIT_WARN_LONG_FROM_SEC ? LIMIT_WARN_LONG_SEC : shortWarnSec;
}

/** end_call after the goodbye was spoken: the call ends this long after the result, unless the turn ends first. */
const END_AFTER_GOODBYE_MS = 2_500;

/** The usage record of a call that never connected (no tokens): it still carries endDetail. */
const EMPTY_USAGE = {
  audioInTokens: 0, audioOutTokens: 0, textInTokens: 0, textOutTokens: 0, cachedInTokens: 0,
  usageCostMicros: 0, durationCostMicros: 0, basis: "none" as const, usageEvents: 0, firstSnapshot: null, lastSnapshot: null,
};

/**
 * The heartbeat: while a call is live, its row gets the provisional duration and usage this often. When the hosting
 * function goes away without running the close path (the 21 Nov 2026 production call 1c240beb: "socket accepted",
 * "model connected", never "ended"), the stale close ends the row at its last heartbeat (lib/voice/service.ts).
 */
export const VOICE_HEARTBEAT_MS = 20_000;

const DEFAULTS = {
  limitWarnSec: 45, reconnectMs: 8_000, endGraceMs: 6_000, statsEveryMs: 5_000, heartbeatMs: VOICE_HEARTBEAT_MS,
  // The opening line waits at most 3 s for the browser's `ready` (only for a browser that announced it).
  waitForClientAudio: false, clientReadyMs: 3_000,
  standbyAfterQuietMs: CALL_RULES.standbyAfterQuietMs, standbyIdleEndMs: CALL_RULES.standbyIdleEndMs, preRollMs: CALL_RULES.preRollMs,
  wakeBufferMaxMs: CALL_RULES.wakeBufferMaxMs, wakeConnectMs: CALL_RULES.wakeConnectMs, falseWakeMs: CALL_RULES.falseWakeMs,
  falseWakesBeforeRaise: CALL_RULES.falseWakesBeforeRaise, maxThresholdBoost: CALL_RULES.maxThresholdBoost, minWakeGapMs: CALL_RULES.minWakeGapMs,
  vad: { ...CALL_RULES.vad } as VadOptions,
};

type WakeEntry = VoiceCallTimes["wakeLog"][number];

export type VoiceEngineDeps = {
  db: Db;
  model: RealtimeModel;
  sessionId: string;
  /** To the browser: a protocol message (JSON) or agent audio (binary, PCM16 24 kHz). */
  send: (msg: ServerMessage | Uint8Array) => void;
  clock?: Clock;
  limits?: VoiceLimits;
  /** One-line operational logs (default: console). */
  log?: VoiceLog;
  /** Called once when the call starts ending, with the work that stores it: the host keeps running until it settles. */
  onEnding?: (work: Promise<unknown>) => void;
  /** Tests: where the call records to (null: not recorded, with the reason). Default: lib/voice/recording.ts recordingStoreFor. */
  recording?: { store: RecordingStore | null; reason: string };
  /**
   * What the model is given, when not Current's: "Classic + guards" (lib/voice-guarded/profile.ts, test lab only).
   * Absent: Current, unchanged.
   */
  profile?: VoiceProfile;
  /**
   * The realtime + ElevenLabs engines (lib/voice-rt-eleven, test lab only): the model answers in TEXT
   * (outputModality "text") and this speaker says each complete reply that made no tool call. Absent: the model
   * speaks with its own voice, unchanged.
   */
  speaker?: Speaker;
};

/**
 * The model side of another engine run on this one (lib/voice-guarded: "Classic + guards"): its instructions and
 * tools, its transcripts as said (no cleaner), its stage and result wording and the quote's spoken summary. With a
 * profile the engine also drives the model as Classic did (notes, injected lines, no language notes, no argument
 * rewriting, Classic's stage count) and shapes tool results as Classic with only the guards added
 * (guardedToolResult). Everything else (recording, the opener's wait, one agent at a time, the infrastructure, the
 * guards themselves) is this engine's.
 */
export type VoiceProfile = {
  /** Stored on the session (settings.engine) and logged (`engine=<name>`). */
  engine: string;
  loadInstructions(
    db: Db, a: { account: SellerAccount; version: AgentVersion; conv: Conversation; lead: Lead; deal: Awaited<ReturnType<typeof readDealState>>; now: Date },
    opts: { recap?: TranscriptLine[]; resumed?: boolean; woke?: boolean; recorded?: boolean },
  ): Promise<VoiceCallContext>;
  tools(family: SchemaFamily): RealtimeToolDef[];
  /** A transcript as stored and shown (Current: cleanTranscript). */
  clean(text: string): string;
  /** update_deal_state's stage block as the model reads it. */
  stageText(stage: string): string;
  /** A tool result message as the model reads it. */
  resultMessage(text: string): string;
  /** create_quote's message when it gives the summary (say_this). */
  quoteMessage(quote: string): string;
  /** The spoken summary of a quote made on the call, amounts in words; null when there is none. */
  quoteSummary(db: Db, a: { account: SellerAccount; quoteId: string; version: number; requested: string[]; language: "en" | "he" }): Promise<string | null>;
  /** The session's tool behaviour on this model family (absent: "blocking"). */
  toolBehavior?(family: SchemaFamily): RealtimeSessionConfig["toolBehavior"];
  /** A tool result's last shaping before it goes to the model (guarded: plain objection notes; the silent probe: scheduling). */
  shapeResult?(name: string, forModel: Record<string, unknown>, o: { family: SchemaFamily }): Record<string, unknown>;
  /**
   * The run-once guard (the silent probe): a tool call identical to one received this many ms before in the same call
   * is not run again (VoiceEngine duplicateOf). Absent: every call runs.
   */
  dedupeToolCallsMs?: number;
};

export type { VoiceEndBy, VoiceEndDetail };

/** The final row write: whether it ended the row, and the figures the browser is told. */
type FinalRow = { connected: boolean; ended: boolean; durationSec: number; costMicros: number; answerMsAvg: number | null };
/** What a Hebrew call says after request_callback put the booking card in the chat (the free times are there). */
export const BOOKING_CARD_LINE_HE = "השעות הפנויות לשיחה מופיעות כאן בצ'אט, ואפשר לבחור שם שעה שנוחה לך.";

/** A final row write that has not answered in this long is tried again (a hung query must not hold the end). */
export const FINAL_WRITE_TIMEOUT_MS = 8_000;
/** The recording's last chunk and its row update get at most this long after the call ended. */
export const RECORDING_FINISH_TIMEOUT_MS = 20_000;

const BY_REASON: Record<VoiceEndReason, VoiceEndBy> = {
  user_hangup: "client_end", agent_closed: "tool", limit: "limit", silence: "idle", idle: "idle", opt_out: "tool", handoff: "tool",
  take_over: "take_over", connection_lost: "client_closed", budget: "gate", error: "error",
};

type ToolRun = { name: string; input: unknown; r: ToolResult };

/** A tool call the run-once guard remembers: its id, tool and canonical arguments, when it came, its result once sent. */
type RecentToolCall = { id: string; key: string; at: number; result: Record<string, unknown> | null };

/** A value as JSON with object keys sorted at every level (the same arguments in another key order are the same). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

type AgentTurn = {
  id: string;
  text: string;
  startMs: number;
  answerMs: number | null;
  tools: ToolRun[];
  memo: TurnMemo;
  /** A tool result went to the model and it has not spoken since: the turn goes on. */
  awaitingContinuation: boolean;
  heardAudio: boolean;
  /** The buyer cut in (barge-in, or typed text while the agent spoke). */
  interrupted: boolean;
  /** The model sent the turn's final transcript: what it said is complete unless interrupted. */
  finalText: boolean;
};

/** Why a turn is stored: the model finished it, the model reports it was cut, or the turn ends under it (buyer turn, stop, reconnect). */
type FinalizeReason = "done" | "interrupted" | "buyer" | "stop";

/** A reply handed to the speaker (text output): its job, its turn and row, and its timing. */
type RtReply = {
  job: SpeechJob;
  turn: AgentTurn;
  /** The text handed to the speaker (the stored line). */
  said: string;
  /** Its row, once stored (handleTurnDone). */
  messageId: string | null;
  /** When the buyer's speech stopped (or the typed line came); null: no buyer turn (the opener, an injected line). */
  from: number | null;
  /** When the response was complete. */
  doneAt: number;
  /** Responses with tool calls since the buyer's turn. */
  toolRounds: number;
};

/** Per spoken answer to a buyer turn (text output): speech stopped → text complete, → first audio sent, and the sum. */
type RtTimes = { thinkMs: number; speakMs: number; totalMs: number; toolRounds: number };

/**
 * The last agent line this call stored (tool calls of a turn with no words go with it). Every spoken agent turn is
 * its own row, in order, a cut one ending with "…": nothing the buyer heard is merged away or dropped. (The merges
 * of 21-22 Nov 2026, and the startsWith ones before them, rewrote or dropped spoken lines, so the record hid double
 * answers and re-said lines the buyer really heard.)
 */
type StoredLine = { messageId: string; turnId: string; raw: string; cut: boolean; tools: number; startMs: number };

/** A typed buyer message younger than this with no reply is a chat turn in flight (voice start waits for it). */
export const TEXT_TURN_FRESH_MS = 45_000;
/**
 * A typed message stored at least this long before the call was created had its chat turn start (and pass the
 * one-agent guard) before the call existed: the call waits for its reply. A later one is refused by the guard.
 */
export const TEXT_TURN_GUARD_MS = 3_000;
/** The longest a call's start waits for a chat turn in flight. */
export const TEXT_TURN_WAIT_MS = 20_000;

/**
 * What the call starts from, for the log (no content): agent messages the stage counts, whether it continues a chat,
 * the stage title from the instructions, and how often each field was asked (the `_asked_<field>` counters).
 */
export function inheritedSummary(agentMessages: number, continuing: boolean, fields: Record<string, { value?: string | null } | undefined> | null, instructions: string): string {
  const stage = /## Stage now: ([^\n]+)/.exec(instructions)?.[1]?.trim() ?? "?";
  const asked = Object.entries(fields ?? {})
    .filter(([k]) => k.startsWith("_asked_"))
    .map(([k, v]) => `${k.slice("_asked_".length)}:${Number(v?.value ?? 0) || 0}`);
  return `inherited: agentMessages=${agentMessages} continuing=${continuing ? "yes" : "no"} stage="${stage}" asked=${asked.join(",") || "-"}`;
}

/**
 * What makes a stage different for the voice model: the stage title and what is still missing for a quote (ask counts
 * and "questions left" are not: they change with every recorded ask). From a "## Stage now" block, or instructions
 * containing one; null when there is none.
 */
export function stageKey(text: string): string | null {
  const title = /## Stage now: ([^\n]+)/.exec(text)?.[1]?.trim();
  if (!title) return null;
  const missing = /Still missing for a quote: ([^\n]*)/.exec(text)?.[1]?.trim() ?? "";
  return `${title}|${missing}`;
}

/**
 * An update_deal_state result with nothing new from the buyer: no field saved, no fact (recommendation_confirmed,
 * price_asked), no objection, no placeholder refused: only `asked`, next_step or a summary were recorded.
 */
export function isBookkeepingOnly(result: Record<string, unknown>): boolean {
  const saved = Array.isArray(result.saved) ? result.saved : [];
  return result.ok === true && saved.length === 0 && !result.recorded && !result.objection_recorded && !result.rejected_placeholder && !result.kept_as_buyer_said;
}

/** A line in English or Hebrew (other languages are not judged: the model decides). */
const JUDGEABLE = /[A-Za-z֐-׿]/;

/**
 * Whether the buyer agreed to the order form, from the call's last lines (lib/voice/form-agreement.ts): an explicit
 * yes or ask for the form or to go ahead, with no reservation (but, a price or competitor remark, a question, a no)
 * in the same line; a plain yes or "right" only as the answer to the agent's offer of the form.
 */
export { orderFormAgreed };

/**
 * The reminder a call's quiet results carry (the short bookkeeping result, the quote): conditional, so it asks for
 * nothing now (no forced speech), but keeps the objection step in view: since bookkeeping results lost the stage
 * block (e2953e5), objections on calls went unrecorded (live calls of 23 Nov 2026).
 */
export const OBJECTION_FIRST = "If the buyer objects or hesitates next (price, timing, another offer, needing to think), record it first with update_deal_state objection, then answer.";

/** The SKUs a create_quote call asks to take off (remove_auto_added), if any. */
export function removedAutoAdded(args: unknown): string[] {
  const v = args && typeof args === "object" ? (args as { remove_auto_added?: unknown }).remove_auto_added : null;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

/** Asking to leave something out (English or Hebrew). */
const REMOVE_WORDS = /\b(without|remove|drop|skip|leave (it )?out|take (it )?out|no need|don'?t need|do not need|not needed)\b|בלי|להוריד|תוריד|לא צריך|לוותר/i;

/**
 * Whether the buyer asked to take something off the quote, from their last line on this call ("yes"/"no"; "unknown"
 * when there is no buyer line or it is in another language: left to the model). On 23 Nov 2026 the agent dropped
 * the installation on its own after "It is more than we plan to spend".
 */
export function removalAsked(lines: readonly { role: string; text: string }[]): "yes" | "no" | "unknown" {
  const buyer = lines.findLast((l) => l.role === "buyer")?.text;
  if (!buyer || !JUDGEABLE.test(buyer)) return "unknown";
  return REMOVE_WORDS.test(buyer) ? "yes" : "no";
}

/** "Not saved yet: …" for the short bookkeeping result (data, not a cue to speak). */
export function notSavedYet(missing: readonly string[]): string {
  return `Not saved yet: ${missing.join(", ")}. If the buyer already told you, save it now with update_deal_state updates (this is not a cue to speak).`;
}

const NUMBER_WORDS: Record<number, RegExp> = {
  0: /\b(zero|none)\b|אפס/i, 1: /\b(one|a single|single)\b|אחד|אחת/i, 2: /\b(two|both|a couple)\b|שתיים|שניים|שני|שתי/i,
  3: /\bthree\b|שלוש|שלושה/i, 4: /\bfour\b|ארבע|ארבעה/i, 5: /\bfive\b|חמש|חמישה/i, 6: /\bsix\b|שש|שישה/i,
  7: /\bseven\b|שבע|שבעה/i, 8: /\beight\b|שמונה/i, 9: /\bnine\b|תשע|תשעה/i, 10: /\bten\b|עשר|עשרה/i,
};

/** Whether a line says this number, in digits or in words (English, Hebrew; up to ten in words). */
export function lineSaysNumber(line: string, n: number): boolean {
  if (new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(line)) return true;
  return NUMBER_WORDS[n]?.test(line) ?? false;
}

/** The order-form guard's refusal (orderFormAgreed): the rule and what the model is told. */
export const FORM_NOT_AGREED = {
  rule: "Not agreed yet",
  message: "The buyer has not agreed to the order form. Offer it in one short sentence and wait for their yes; if they raised the price or another concern, answer that first.",
} as const;

/** The removal guard's refusal (removalAsked). */
export const removalNotAsked = (removing: readonly string[]) => ({
  rule: "Removal not asked",
  message: `The buyer did not ask to remove ${removing.join(", ")}. The quote stays as it is. If it helps, offer that option in one short sentence and make the new quote only when the buyer agrees.`,
});

/** The smaller-quote guard's hold (smallerQuoteAgreed): ask that one question first. */
export const smallerQuoteNotAsked = (what: string) => ({
  rule: "Smaller quote not asked",
  message: `No quote was made: the buyer has not asked for a quote for ${what}. The current quote stays as it is. If a smaller start may help, first ask in one short question whether to prepare a quote for ${what}, and make it only when the buyer says yes.`,
});

/** What update_deal_state's result says when a lowered number was kept as the buyer said (holdLoweredNumbers). */
export const keptMessage = (kept: readonly { label: string; value: string }[]) =>
  `Not changed: ${kept.map((k) => `${k.label} stays ${k.value}`).join("; ")}, as the buyer said. Change it only when the buyer says the new number; an offer of a smaller start becomes the quote only after they accept it in so many words.`;

/** A create_quote refused for missing facts: no total may be said (23 Nov 2026: one was, on an assumption). */
export const refusedQuoteMessage = (missing: readonly string[]) =>
  `No quote was made: ${missing.join(", ")} not saved yet. If the buyer already told you, save it now with update_deal_state updates, then call create_quote again; otherwise ask for it in one short question. Do not say any total or price for the quote until create_quote has made one.`;

/** A send_order_form that did not run or failed: never a success line (the 22 Nov 2026 call said "the link is in the chat"). */
export function formNotSentMessage(result: Record<string, unknown>): string {
  const why = typeof result.rule === "string" ? result.rule : typeof result.error === "string" ? result.error : "it could not be sent";
  return `The order form was NOT sent (${why}). Do not say the order form or its link is in the chat. ${typeof result.message === "string" ? `${result.message} ` : ""}Tell the buyer in one short sentence what happens next.`;
}

/**
 * A quote held for the team's approval (create_quote: status awaiting_seller_approval / quote_held). A call once
 * said a total from an earlier check_fit for such a quote, said "the quote is in your chat" and offered the order
 * form (23 Nov 2026): the result the model gets says the held state first, in a sentence the server writes in the
 * call's language, and carries no figure of that quote.
 */
export const isHeldQuoteResult = (result: Record<string, unknown>) => result.status === "awaiting_seller_approval" || result.quote_held === true;

/** What the agent says when create_quote holds the quote for approval (no amount, no "the quote is in the chat"). */
export const HELD_QUOTE_SAY: Readonly<Record<"en" | "he", string>> = {
  en: "I've asked the team to approve this price. You'll see their answer here in the chat, and I'm staying on the line.",
  he: "ביקשתי מהצוות לאשר את המחיר הזה. התשובה שלהם תופיע כאן בצ'אט, ואני נשאר כאן על הקו.",
};

export const HELD_QUOTE_MESSAGE = "The quote is NOT final and was NOT sent: the team must approve it first. Say say_this now, as written. Do not say any total or price for it (not from check_fit either), do not say the quote is in the chat, and do not offer the order form until the app says it was approved.";

/**
 * check_fit on a call (any engine but the frozen Classic): no money figure reaches the model. Two calls (23 Nov 2026)
 * said a price taken from check_fit's totals (once for a quote held for approval, once with no quote at all). The
 * agent has a price to say only from a ready create_quote. The stored row and the test lab keep the full result.
 */
export const FIT_PRICES_FOR_CALL = "not shown here: call create_quote, then say the price it gives you";
const FIT_LINE_MONEY = ["total", "total_before_vat", "total_including_vat", "unit_price"] as const;

export function fitForCall(forModel: Record<string, unknown>): Record<string, unknown> {
  const { totals: _t, price_basis: _b, currency: _c, prices_include_tax: _i, headline: _h, ...rest } = forModel;
  void [_t, _b, _c, _i, _h];
  const lines = Array.isArray(rest.lines)
    ? rest.lines.map((l) => {
      if (!l || typeof l !== "object") return l;
      const out = { ...(l as Record<string, unknown>) };
      for (const k of FIT_LINE_MONEY) delete out[k];
      return out;
    })
    : undefined;
  return { ...rest, ...(lines ? { lines } : {}), prices: FIT_PRICES_FOR_CALL };
}

/** send_order_form while the conversation's latest quote waits for the team's approval. */
export const HELD_FORM_RULE = "Quote waits for the seller's approval";
export const HELD_FORM_MESSAGE = "The order form was not sent: the quote is waiting for the team's approval. Tell the buyer the team is checking the price.";

/** Fields of a held create_quote result the model may see: ids and status, never a figure of the quote. */
const HELD_QUOTE_KEEP = ["ok", "status", "quote", "quote_id", "quote_version", "removed_at_buyer_request", "cannot_remove", "cannot_remove_message", "duplicate_of", "scheduling"] as const;

/**
 * A held create_quote result as the model gets it on a call (any engine): say_this first, then ids and status, then
 * the message. Totals, lines_for_call, headline, price basis, delivery and approval reasons are left out.
 */
export function heldQuoteForModel(forModel: Record<string, unknown>, language: "en" | "he", sayIn: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { say_this: HELD_QUOTE_SAY[language] };
  for (const k of HELD_QUOTE_KEEP) if (forModel[k] !== undefined) out[k] = forModel[k];
  out.quote_held = true;
  out.message = sayIn ? `${HELD_QUOTE_MESSAGE} ${sayIn}` : HELD_QUOTE_MESSAGE;
  return out;
}

/** After hand_off_to_human on a call (owner, 22 Nov 2026): the team gets back to the buyer and the call goes on. */
export const HANDOFF_RESULT_MESSAGE = "Done: the team will get back to the buyer. Say so in one short sentence (to confirm the time, if a call was requested), then ask if there is anything else you can help with. Do not continue selling. The call goes on until the buyer says goodbye: then say a short goodbye and call end_call.";

/** After send_order_form on a call: the link is in the chat, the agent stays on the line. */
export const ORDER_FORM_IN_CHAT_MESSAGE = "The order form link is in the chat. Say so in one short sentence, with what the buyer does there (fill in their company details, sign and pay), and say they can fill it in now while you stay on the line. Never read the link aloud. Do not end the call, say goodbye or wind down: stay quiet while they fill it in, and answer only when they speak.";

/** After end_call: the goodbye, then the call ends. */
export const END_CALL_RESULT_MESSAGE = "The call ends now. If you have not said goodbye yet, say one short goodbye; say nothing else.";

/** A quote line at no charge, as lines_for_call gives it (in the language the call speaks; else English). */
export const FREE_WORD: Readonly<Record<string, string>> = { en: "free", he: "חינם" };

/** How a call presents a ready quote (create_quote's result on a call, with `lines_for_call`). */
export const QUOTE_WALKTHROUGH = "Walk the buyer through it in three or four short spoken sentences: what they need and what each part costs, from lines_for_call (for example \"For your two locations you need twelve seats at 59 shekels each, and setup at 200 per location\"), then the total today and the monthly amount, once each, then that the quote is in the chat now. Then ask if it looks right.";

/** What a connection was given, for the log: the config kind (full, or the safe retry), instruction length and tool count. */
export function configSummary(cfg: RealtimeSessionConfig): string {
  return `config=${cfg.safe ? "safe" : "full"} instructions=${cfg.instructions.length} tools=${cfg.tools.length}`;
}

/**
 * The log line of a browser's `ready` (lib/voice/client/readiness.ts): how long its check took, its playback route,
 * when each step was done (ms into the check), its output latency and the step that timed out ("-" where unknown;
 * an older page sends no diagnostics).
 */
export function browserReadyLine(msg: Extract<ClientMessage, { t: "ready" }>): string {
  const v = (n: number | null | undefined) => (n === null || n === undefined ? "-" : String(n));
  const lat = msg.baseLatencyMs === undefined && msg.outputLatencyMs === undefined ? "-" : String((msg.baseLatencyMs ?? 0) + (msg.outputLatencyMs ?? 0));
  const s = msg.steps;
  return `browser ready waitedMs=${v(msg.waitedMs)} route=${msg.route ?? "-"} mic=${v(s?.mic)} ctx=${v(s?.ctx)} out=${v(s?.out)} primer=${v(s?.primer)} latency=${lat}ms timedOut=${msg.timedOut ?? "-"}`;
}

/** Languages written in a script other than Latin. */
const NON_LATIN = /^(?:he|ar|fa|ur|ru|uk|bg|el|yi)\b/i;

/**
 * The language the buyer speaks now, from their line (by script): Hebrew or Arabic letters name it; Latin letters
 * keep the current language when it is a Latin-script one, else `latin` (the call's Latin-script default);
 * no letters keep the current one.
 */
export function spokenLanguageOf(text: string, current: string, latin: string): string {
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[A-Za-z]/.test(text)) return NON_LATIN.test(current) ? latin : current;
  return current;
}

/**
 * The language a spoken line is stored with: the buyer may switch languages on a call. Cheap, by script:
 * Hebrew letters → "he"; Arabic letters → "ar"; Latin text in a conversation whose language is written in
 * another script → "en"; otherwise the conversation's language (chat stores the conversation's language too).
 */
export function lineLanguage(text: string, conversationLanguage: string | null): string {
  const conv = conversationLanguage || "en";
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[A-Za-z]/.test(text) && /^(?:he|ar|fa|ur|ru|uk|bg|el|yi)\b/i.test(conv)) return "en";
  return conv;
}

/** A final buyer transcript this soon after the last one, that is that line grown, revises it (see grownFrom). */
export const BUYER_LINE_REVISE_MS = 15_000;

/** `next` is `prev` with more words after it (a running transcript of one utterance), not the same line again. */
export function grownFrom(next: string, prev: string): boolean {
  const a = transcriptWords(next);
  const b = transcriptWords(prev);
  return !!b && a.length > b.length && a.startsWith(`${b} `);
}

/** A line the buyer cut short, as stored: the words actually said, ending with "…". */
export const cutLine = (s: string) => `${s.trim().replace(/[\s,;:–—-]+$/u, "")}…`;

type Loaded = { session: VoiceSession; conv: Conversation; lead: Lead; version: AgentVersion; account: SellerAccount };

/** The engine's closing system note, "Voice call ended · m:ss" (exported for the demo seeds). */
export const CALL_ENDED_TEXT = voiceCallEndedLine;

export class VoiceEngine {
  private readonly db: Db;
  private readonly model: RealtimeModel;
  private readonly clock: Clock;
  private readonly limits: Required<Omit<VoiceLimits, "deadlineSec" | "env">> & Pick<VoiceLimits, "deadlineSec" | "env">;
  private readonly out: (msg: ServerMessage | Uint8Array) => void;
  readonly sessionId: string;

  private readonly log: VoiceLog;
  private readonly onEnding: VoiceEngineDeps["onEnding"];
  private readonly recordingChoice: VoiceEngineDeps["recording"];
  /** Another engine's model side ("Classic + guards"); null: Current. */
  private readonly profile: VoiceProfile | null;
  /** Text output and our speaker (the realtime + ElevenLabs engines); null: the model speaks (every other engine). */
  private readonly speaker: Speaker | null;
  private readonly player: SpeechPlayer | null;
  /** Text output: the replies handed to the speaker, by job id. */
  private readonly rtReplies = new Map<number, RtReply>();
  /** Text output: the turn being answered and the call's figures. */
  private rt = {
    /** When the buyer's speech stopped (OpenAI VAD), or their line came (typed, or a model without that event). */
    heardAt: null as number | null,
    sawSpeechStopped: false,
    toolRounds: 0,
    /** A response is in flight (started, not yet complete). */
    responseOpen: false,
    dropped: 0,
    bargeIns: 0,
    chars: 0,
    times: [] as RtTimes[],
  };
  /** Profile (Classic's notes): a form note that came while the model was away, sent with the next connection. */
  private heldFormNote: string | null = null;
  /** The call's recording (null: not recorded). */
  private recorder: CallRecorder | null = null;
  /** The call clock (ms since connect) when the call ended: the recording's end. */
  private endedAtMs: number | null = null;
  /** This call is recorded: its instructions carry the one recording rule (lib/voice/instructions.ts RECORDED_CALL_RULE). */
  private recorded = false;
  /**
   * The conversation's latest quote on this call waits for the team's approval (create_quote held it): the order
   * form is refused until a later create_quote returns a ready quote, or the quote is no longer awaiting approval.
   * `id` is null when the result named no quote id.
   */
  private heldQuote: { id: string | null } | null = null;
  /** This call's agent handed the conversation to the team (hand_off_to_human): the call itself goes on. */
  private handedOffHere = false;
  /** Counts of the relay's diagnostics (RealtimeEvent "diagnostic"), logged when the call ends. */
  private readonly diagnostics = new Map<string, number>();
  private endBy: VoiceEndBy | null = null;
  private clientClose: VoiceEndDetail["clientClose"];
  private modelClose: VoiceEndDetail["modelClose"];
  private lastError: string | undefined;
  /** Provider event types already logged in this call (once per type). */
  private providerSeen = new Set<string>();
  /** When the current model connection came up, and whether it sent any agent audio yet. */
  private connAt: number | null = null;
  private connAudio = false;
  /** The model generation whose close or going-away already started a reconnect (both can come for one connection). */
  private closeHandledGen = -1;
  /** The model closed a session before it said anything: one retry with proven session fields only. */
  private earlyRetryUsed = false;
  private safeConfig = false;
  private loaded: Loaded | null = null;
  private conn: RealtimeConnection | null = null;
  private gen = 0;
  private started = false;
  private ended = false;
  /** The session row was ended from outside (the starter's "End that call"): this call stops and still stores its figures. */
  private endedExternally = false;
  private stopping: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private state: VoiceState | null = null;

  private callStart: number | null = null;
  /**
   * The model event trace (log lines only, never read by the call): the response whose audio is going out, numbered
   * per call. A response ends at the model's turn-done, a barge-in, or a tool result (the audio after a result is
   * the model's next response: on Gemini, BLOCKING tools make it continue by itself).
   */
  private traceResp: { n: number; at: number; audioMs: number; textFrom: number; closedBy: string | null } | null = null;
  private traceRespSeq = 0;
  /** When each tool call came from the model (the trace's `took`). */
  private traceCallAt = new Map<string, number>();
  private maxSec = 0;
  private muted = false;
  private agentTurn: AgentTurn | null = null;
  private agentSpeaking = false;
  private buyerTurn: { id: string; startMs: number } | null = null;
  private buyerEndedAt: number | null = null;
  private turnSeq = 0;
  private agentMessages = 0;
  private answerTimes: number[] = [];
  private lines: TranscriptLine[] = [];
  /** The last agent line stored in this call (see finalizeAgentTurn). */
  private lastLine: StoredLine | null = null;
  /** The buyer's last spoken line stored in THIS call (its row), while a later transcript of it may still come. */
  private lastBuyerLine: { messageId: string; turnId: string; text: string; startMs: number; at: number } | null = null;
  /** The stage the voice model last saw (stageKey of its instructions or of the last full update_deal_state result). */
  private stageDelivered: string | null = null;
  /** The browser said it can play the agent (`{t:"ready"}`). */
  private clientReady = false;
  /** When the first agent audio of the call went to the browser (the `heard` log line's delta). */
  private firstAudioSentAt: number | null = null;
  /** The browser's `heard` was logged (once per call). */
  private heardLogged = false;
  /** The opening line, until it is asked for (see sendOpener). */
  private pendingOpener: { prompt: string; kind: string; since: number } | null = null;
  /** The call continues a chat (a pick-up line instead of an opener). */
  private continuingCall = false;
  /** This call stored its first agent line (the pick-up line, on a continuing call). */
  private firstLineStored = false;
  /** Tool calls the model cancelled (RealtimeEvent "tool-cancelled"). */
  private readonly cancelledCalls = new Set<string>();
  /** The row the late transcription of the last ended response belongs to ("none": it stored no row); null: none due. */
  private lateTarget: string | null = null;
  /** The text of a turn stored as cut by the buyer's line, until its response ends (agent-transcript). */
  private cutText: string | null = null;
  /**
   * The language the call speaks now: the call's language at the start, then the language of the buyer's last
   * line (by script). Every instruction the engine injects names it, and reconnects and wakes start in it.
   */
  private spokenLanguage = "en";
  /** The call's Latin-script default (the call's language when Latin-script, else English). */
  private latinLanguage = "en";
  /** Tool calls of a turn that said nothing yet (cut before its first word), for the next line. */
  private carriedTools: ToolRun[] = [];
  /** Usage snapshots, totalled whether the provider reports them per session or per turn. */
  /** OpenAI reports usage per response (summed); Gemini: the cumulative-or-per-turn heuristic. Set in the constructor. */
  private usageAcc: RealtimeUsageAccumulator;
  private providerSessionId: string | null = null;
  private pendingEnd: VoiceEndReason | null = null;
  private optedOut = false;
  private reconnectUsed = false;
  private reconnecting = false;
  private lastStamp = 0;
  private errorCode: VoiceErrorCode | null = null;
  private timers: Record<"warn" | "limit" | "quiet" | "idle" | "falseWake" | "grace" | "stats" | "reconnect" | "heartbeat" | "ready", TimerHandle | null> = {
    warn: null, limit: null, quiet: null, idle: null, falseWake: null, grace: null, stats: null, reconnect: null, heartbeat: null, ready: null,
  };

  // Standby (lib/voice/call-rules.ts): the model is disconnected while the buyer is quiet; our detector listens.
  /** On standby since this clock time (null: not on standby). */
  private standbySince: number | null = null;
  /** A wake is reconnecting the model; mic audio waits in `wakeAudio`. */
  private waking = false;
  private wakeAudio: Uint8Array[] = [];
  private wakeAudioMs = 0;
  private readonly vad: EnergyVad;
  private readonly preRoll: PcmRing;
  /** The wake being measured (detected at, its log entry), until the first agent audio. */
  private currentWake: { at: number; entry: WakeEntry } | null = null;
  private lastWakeAt = -Infinity;
  private wakeLog: WakeEntry[] = [];
  private falseWakes = 0;
  /** Quiet since (clock time): the idle end counts from here across false wakes; null after the buyer is heard. */
  private quietSince: number | null = null;
  /** The buyer has the order form open (sent in this call, or noteOrderFormOpen): no idle end before the limit. */
  private formOpen = false;
  /** Model-connected time: what is paid. */
  private activeMs = 0;
  private activeSince: number | null = null;
  private toolsRunning = 0;
  private standbys = 0;
  private queueDepth = 0;
  /** The agent finished its first turn in this call (the opening line): standby only after it. */
  private openerDone = false;
  /**
   * OpenAI realtime: the buyer's transcription completes AFTER the answer to it has started (the live calls of
   * 22 Nov 2026: about 13 ms after the answer was stored). Their buyer line is put before the answer it got.
   * Gemini closes the buyer's turn before the answer starts: never set, its order is as it was.
   */
  private readonly lateBuyerTranscript: boolean;

  constructor(deps: VoiceEngineDeps) {
    this.db = deps.db;
    this.model = deps.model;
    const openai = /^openai\/|gpt-realtime/i.test(this.model.modelId);
    this.usageAcc = new RealtimeUsageAccumulator(openai ? "per_response" : "auto");
    this.lateBuyerTranscript = openai;
    this.clock = deps.clock ?? systemClock;
    this.out = deps.send;
    this.sessionId = deps.sessionId;
    this.limits = { ...DEFAULTS, ...deps.limits };
    this.log = deps.log ?? consoleVoiceLog;
    this.onEnding = deps.onEnding;
    this.recordingChoice = deps.recording;
    this.profile = deps.profile ?? null;
    this.speaker = deps.speaker ?? null;
    this.player = this.speaker ? new SpeechPlayer({
      speaker: this.speaker, clock: this.clock, frameBytes: PIPELINE_TIMING.frameBytes, leadMs: PIPELINE_TIMING.leadMs,
      send: (frame) => this.onSpeechFrame(frame),
      onFirstAudio: (job) => this.onSpeechFirstAudio(job),
      onChars: (n) => void (this.rt.chars += n),
      onJobEnd: (job) => this.onSpeechJobEnd(job),
      onIdle: () => this.afterSpeech(),
      log: (level, line) => (level === "warn" ? this.log.warn : this.log.info).call(this.log, voiceLine(this.sessionId, line)),
    }) : null;
    this.speaker?.setLog?.((level, line) => (level === "warn" ? this.log.warn : this.log.info).call(this.log, voiceLine(this.sessionId, `trace t=${this.offsetMs()} ${line}`)));
    this.vad = new EnergyVad(this.limits.vad);
    this.preRoll = new PcmRing(this.limits.preRollMs);
  }

  // -------------------------------------------------------------------------
  // Transport API
  // -------------------------------------------------------------------------

  /** Loads the call, checks the gates, connects the model and asks it for the opener. */
  start(): Promise<void> {
    if (this.started) return this.queue;
    this.started = true;
    return this.enqueue(() => this.doStart());
  }

  onClientMessage(msg: import("./protocol").ClientMessage): void {
    if (this.ended) return;
    if (msg.t === "wake") return this.tapWake();
    switch (msg.t) {
      case "start":
        void this.start();
        return;
      case "mute":
        this.muted = msg.on;
        return;
      case "text":
        this.trace(`buyer typed len=${msg.text.length}`);
        this.buyerActivity();
        void this.enqueue(() => this.handleBuyerFinal(msg.text, true));
        return;
      case "end":
        void this.stop("user_hangup");
        return;
      case "ping":
        return;
      case "ready":
        if (!this.clientReady) this.log.info(voiceLine(this.sessionId, browserReadyLine(msg)));
        this.clientReady = true;
        this.sendOpener("ready");
        return;
      case "heard":
        // Log only: when the first agent audio actually started playing in the browser (once per call).
        if (this.heardLogged) return;
        this.heardLogged = true;
        this.trace(`browser heard first audio +${this.firstAudioSentAt === null ? "-" : Math.max(0, Math.round(this.clock.now() - this.firstAudioSentAt))}ms after it was sent (browser: ${msg.sinceFirstChunkMs}ms after it arrived, queued ${msg.queuedMs}ms)`);
        return;
      case "context":
        this.onFormContext(msg);
        return;
    }
  }

  /**
   * The order form open in another tab (lib/voice/form-context.ts): a quiet note to the model, throttled, never
   * answered aloud. The form being open also lifts standby's idle end (noteOrderFormOpen). A note never wakes the
   * model: the latest one is part of the instructions of every later connection (sessionConfig).
   */
  private formNotes: FormContextNotes | null = null;
  /** The last form context the buyer's form tab reported in this call (order_form_status). */
  private formLast: import("./form-context").FormContext | null = null;
  /** The latest form note: part of the instructions of every later model connection (a wake, a reconnect). */
  private formNote: string | null = null;
  /**
   * Gemini Live answers any completed client turn, and the Gateway's text item reaches it as one: a note sent
   * mid-call can make it speak with nothing to say (the live call's "<no speech detected>"). On Gemini a note
   * therefore never goes in mid-call; it rides in the instructions of the next connection instead.
   */
  private notesMidCall(): boolean {
    return schemaFamilyOf(this.model.modelId) !== "gemini";
  }
  private onFormContext(msg: Extract<import("./protocol").ClientMessage, { t: "context" }>): void {
    this.noteOrderFormOpen();
    // What order_form_status answers (a known step only: an unknown id is no step).
    this.formLast = { step: msg.step, event: msg.event };
    this.formNotes ??= new FormContextNotes(this.clock, (note) => {
      if (this.ended) return;
      if (this.profile) {
        // Classic: the note goes in now on every model; while the model is away it waits for the next connection.
        if (this.conn && !this.reconnecting && !this.waking && this.standbySince === null && this.conn.sendNote) {
          this.noteSent("order form step");
          this.conn.sendNote(note);
        } else this.heldFormNote = note;
        return;
      }
      this.formNote = note;
      if (!this.notesMidCall()) return;
      // Off the line (standby, a wake or a reconnect under way): nothing now, the next connection's instructions carry it.
      if (this.conn && !this.reconnecting && !this.waking && this.standbySince === null && this.conn.sendNote) {
        this.noteSent("order form step");
        this.conn.sendNote(note);
      }
    });
    this.formNotes.push({ step: msg.step, event: msg.event });
  }

  onClientAudio(bytes: Uint8Array): void {
    if (this.ended || this.muted) return;
    // Forward first; the recording (left channel: the mic as received) only queues its work for after.
    this.forwardClientAudio(bytes);
    if (this.callStart !== null) this.recorder?.buyer(bytes, this.offsetMs());
  }

  private forwardClientAudio(bytes: Uint8Array): void {
    // Before the opening line is asked for, the buyer's audio does not reach the model (one opening only).
    if (this.pendingOpener) return;
    if (this.standbySince !== null) return this.listenOnStandby(bytes);
    if (this.waking) return this.holdWakeAudio(bytes);
    if (!this.conn || this.reconnecting) return;
    this.conn.sendAudio(bytes);
  }

  /**
   * The buyer opened the order form (the bubble's form context): while it is open the call has no
   * idle end on standby, only the call's total limit. Sending the form in this call does the same.
   */
  noteOrderFormOpen(): void {
    this.formOpen = true;
    if (this.standbySince !== null) this.clearTimer("idle");
  }

  /** True while the model is disconnected for standby (tests, the harness). */
  get onStandby(): boolean {
    return this.standbySince !== null;
  }

  /**
   * The browser's socket dropped: the call ends now (never keep a paid model socket open). `close`: the socket's
   * close code and reason; `idle`: the relay closed it because the browser went silent.
   */
  onClientGone(close?: { code?: number | null; reason?: string; idle?: boolean }): Promise<void> {
    if (close && !this.ended) this.clientClose = { code: close.code ?? null, reason: clip(close.reason) };
    return this.stop("connection_lost", undefined, close?.idle ? "client_idle" : "client_closed");
  }

  /** Ends the call. Idempotent: a second call returns the first one's promise. `by`: what triggered it (else from the reason). */
  stop(reason: VoiceEndReason, code?: VoiceErrorCode, by?: VoiceEndBy): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ended = true;
    if (this.callStart !== null) this.endedAtMs = this.offsetMs();
    this.endBy = by ?? BY_REASON[reason] ?? "error";
    if (code) this.errorCode = code;
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) {
      this.clock.clearTimeout(this.timers[k]);
      this.timers[k] = null;
    }
    // Text output: our speaker stops with the call (a paid speech stream is never left open either).
    if (this.player?.active) this.player.cancel();
    this.closeModel();
    // A dropped browser: the row is written first, at once (not behind queued work), so the end survives the
    // function being stopped right after; the slower steps follow.
    const rowFirst = reason === "connection_lost" ? this.writeFinalRow(reason) : null;
    this.stopping = this.enqueue(() => this.finish(reason, rowFirst), true);
    // The host keeps the function alive until the end is stored (the route: waitUntil).
    this.onEnding?.(this.stopping);
    return this.stopping;
  }

  /** Resolves when every queued piece of work has run (tests). */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  get isEnded() {
    return this.ended;
  }

  // -------------------------------------------------------------------------
  // Internals: queue, sending, timers
  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>, evenIfEnded = false): Promise<void> {
    this.queueDepth++;
    const run = async () => {
      try {
        if (this.ended && !evenIfEnded) return;
        await fn();
      } finally {
        this.queueDepth--;
      }
    };
    const p = this.queue.then(run).catch((e) => {
      // One short line: the error and its cause, never a query's parameters.
      (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `engine error: ${errorSummary(e)}`));
      if (!this.ended) this.fail("error", "internal");
    });
    this.queue = p;
    return p;
  }

  private send(msg: ServerMessage | Uint8Array) {
    if (this.firstAudioSentAt === null && msg instanceof Uint8Array && msg.byteLength > 0) this.firstAudioSentAt = this.clock.now();
    try {
      this.out(msg);
    } catch (e) {
      console.error("[voice] send to client failed", e);
    }
  }

  private setState(state: VoiceState) {
    if (this.state === state) return;
    this.state = state;
    this.send({ t: "state", state });
  }

  private timer(k: keyof typeof this.timers, ms: number, fn: () => void) {
    this.clock.clearTimeout(this.timers[k]);
    this.timers[k] = this.clock.setTimeout(() => {
      this.timers[k] = null;
      if (!this.ended) fn();
    }, ms);
  }

  private clearTimer(k: keyof typeof this.timers) {
    this.clock.clearTimeout(this.timers[k]);
    this.timers[k] = null;
  }

  private closeModel() {
    const c = this.conn;
    this.conn = null;
    this.gen++;
    if (this.activeSince !== null) {
      this.activeMs += Math.max(0, this.clock.now() - this.activeSince);
      this.activeSince = null;
    }
    if (!c) return;
    try {
      c.close();
    } catch (e) {
      console.error("[voice] model close failed", e);
    }
  }

  private offsetMs() {
    return this.callStart === null ? 0 : Math.max(0, Math.round(this.clock.now() - this.callStart));
  }

  /** A created_at strictly after every row this call wrote (and after tools' own rows, which wait a millisecond too). */
  private async stamp(): Promise<Date> {
    while (Date.now() <= this.lastStamp) await new Promise((r) => setTimeout(r, 1));
    this.lastStamp = Date.now();
    return new Date(this.lastStamp);
  }

  private answerMsAvg(): number | null {
    return this.answerTimes.length ? Math.round(this.answerTimes.reduce((a, b) => a + b, 0) / this.answerTimes.length) : null;
  }

  /** Model-connected seconds so far (standby and reconnect gaps excluded). */
  private activeSec(): number {
    const open = this.activeSince === null ? 0 : Math.max(0, this.clock.now() - this.activeSince);
    return Math.round((this.activeMs + open) / 1000);
  }

  /** A model connection is up from now (start, reconnect, wake): its time is paid and its usage counters start at 0. */
  private modelUp(conn: RealtimeConnection) {
    this.conn = conn;
    this.connAt = this.clock.now();
    this.connAudio = false;
    this.traceResp = null;
    this.activeSince = this.clock.now();
    this.usageAcc.newSession();
    // Profile (Classic): a form note held while the model was away goes in now, after the fresh instructions and recap.
    if (this.profile && this.heldFormNote) {
      this.noteSent("order form step");
      conn.sendNote?.(this.heldFormNote);
      this.heldFormNote = null;
    }
  }

  /** Cost so far, from the latest usage snapshot and the model-connected time (0 for the scripted model). */
  private costSoFar(): number {
    if (this.model.mode === "scripted" || this.callStart === null) return 0;
    if (this.speaker) return this.callFigures().costMicros;
    return voiceCallCost(this.model.modelId, this.usageAcc, this.activeSec()).costMicros;
  }

  private sendStats() {
    this.send({ t: "stats", durationSec: Math.round(this.offsetMs() / 1000), costMicros: this.costSoFar(), answerMsAvg: this.answerMsAvg() });
  }

  private statsLoop() {
    this.timer("stats", this.limits.statsEveryMs, () => {
      this.sendStats();
      // The recording writes each chunk once the call clock passes its end, also while nobody speaks.
      if (this.callStart !== null) this.recorder?.tick(this.offsetMs());
      this.statsLoop();
      void this.enqueue(() => this.checkEndedExternally());
    });
  }

  private heartbeatLoop() {
    this.timer("heartbeat", this.limits.heartbeatMs, () => {
      this.heartbeatLoop();
      void this.enqueue(() => this.writeHeartbeat());
    });
  }

  /**
   * The live row's provisional figures: duration so far and the usage and cost as if the call ended now (no
   * endDetail). Only while the row is live: the call's own end (or an end from elsewhere) is never overwritten.
   */
  private async writeHeartbeat() {
    if (this.ended || this.callStart === null) return;
    const { durationSec, usage, costMicros } = this.callFigures();
    // The recording keeps writing chunks while the line is quiet (silence), and its progress goes on the row.
    this.recorder?.tick(this.offsetMs());
    const rec = this.recorder?.stored;
    await this.db.update(voiceSessions).set({ durationSec, usage, costMicros, ...(rec ? { recordingChunks: rec.chunks, recordingBytes: rec.bytes, recordingSec: rec.sec } : {}) })
      .where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "live")));
  }

  /**
   * The call's figures as of now: duration (the whole call), and the usage record and cost. Live: the larger of the
   * usage-based and the duration-based cost (active seconds), both kept with the basis (never undercounted).
   * Scripted: always 0; the fake counts are kept with basis "none".
   */
  private callFigures(): { connected: boolean; durationSec: number; activeSec: number; usage: VoiceCallUsageRecord | null; costMicros: number } {
    const connected = this.callStart !== null;
    const durationSec = connected ? Math.round(this.offsetMs() / 1000) : 0;
    // Paid time is the model-connected time (standby excluded); durationSec stays the whole call.
    const activeSec = Math.min(durationSec, this.activeSec());
    const times: VoiceCallTimes = { activeSec, standbySec: Math.max(0, durationSec - activeSec), standbys: this.standbys, wakes: this.wakeLog.length, falseWakes: this.falseWakes, wakeLog: this.wakeLog };
    let usage: VoiceCallUsageRecord | null = null;
    let costMicros = 0;
    if (this.speaker) {
      // Text output and ElevenLabs: the realtime model's usage (text out; floor: listening only) plus the characters spoken.
      const live = this.model.mode === "live" && connected;
      const realtime = live ? rtRealtimeCost(this.model.modelId, this.usageAcc, activeSec) : null;
      const speak = rtSpeakCost(this.speaker.modelId, this.rt.chars);
      const speakCostMicros = live ? speak.costMicros : 0;
      costMicros = (realtime?.costMicros ?? 0) + speakCostMicros;
      if (realtime || this.usageAcc.events > 0 || connected) {
        const a = this.usageAcc;
        const base: VoiceCallUsageRecord = realtime?.usage
          ?? { ...a.total, usageCostMicros: 0, durationCostMicros: 0, basis: "none", usageEvents: a.events, firstSnapshot: a.first, lastSnapshot: a.last };
        usage = { ...base, ...times, rtEleven: this.rtUsage(realtime?.costMicros ?? 0, speakCostMicros, speak.known) } as VoiceCallUsageRecord;
      }
      return { connected, durationSec, activeSec, usage, costMicros };
    }
    if (this.model.mode === "live" && connected) {
      ({ costMicros, usage } = voiceCallCost(this.model.modelId, this.usageAcc, activeSec));
      usage = { ...usage, ...times };
    } else if (this.usageAcc.events > 0 || connected) {
      const a = this.usageAcc;
      usage = { ...a.total, usageCostMicros: 0, durationCostMicros: 0, basis: "none", usageEvents: a.events, firstSnapshot: a.first, lastSnapshot: a.last, ...times };
    }
    return { connected, durationSec, activeSec, usage, costMicros };
  }

  /** On each stats tick: a session row ended elsewhere ("End that call") stops this call. */
  private async checkEndedExternally() {
    const [row] = await this.db.select({ status: voiceSessions.status, endReason: voiceSessions.endReason }).from(voiceSessions)
      .where(eq(voiceSessions.id, this.sessionId));
    if (row?.status !== "ended" || this.ended) return;
    this.endedExternally = true;
    void this.stop(row.endReason ?? "user_hangup", undefined, "ended_elsewhere");
  }

  private fail(reason: VoiceEndReason, code: VoiceErrorCode, by?: VoiceEndBy) {
    this.errorCode = code;
    this.log.warn(voiceLine(this.sessionId, `call failing: ${code} (${by ?? BY_REASON[reason]})`));
    this.send({ t: "error", code });
    void this.stop(reason, code, by);
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  private async doStart() {
    this.setState("connecting");
    const [session] = await this.db.select().from(voiceSessions).where(eq(voiceSessions.id, this.sessionId));
    if (!session) return this.fail("error", "not_found");
    if (session.status !== "pending") return this.fail("error", "not_pending");
    const accountId = session.accountId;
    const [[conv], [account]] = await Promise.all([
      this.db.select().from(conversations).where(and(eq(conversations.id, session.conversationId), eq(conversations.accountId, accountId))),
      this.db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    ]);
    if (!conv || !account) return this.fail("error", "not_found");
    const [[lead], [version], deal] = await Promise.all([
      this.db.select().from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, accountId))),
      this.db.select().from(agentVersions).where(and(eq(agentVersions.id, session.agentVersionId ?? conv.agentVersionId), eq(agentVersions.accountId, accountId))),
      readDealState(this.db, accountId, conv.leadId),
    ]);
    if (!lead || !version) return this.fail("error", "not_found");
    // Gates (as runBuyerTurn): nothing automated on a closed, opted-out, handed-off or paused conversation.
    if (conv.status === "closed" || lead.status === "opted_out") return this.fail("error", "conversation_closed");
    if (conv.status === "human") return this.fail("error", "human_handling");
    if (account.status === "paused") return this.fail("error", "account_paused");
    if (this.model.mode === "live") {
      if (await spendCapped(this.db, accountId)) return this.fail("budget", "spend_cap", "gate");
      if ((await platformBudget(this.db)).exceeded) return this.fail("budget", "platform_budget", "gate");
    }
    this.loaded = { session, conv, lead, version, account };
    this.maxSec = maxCallSeconds({ settings: version.voiceSettings, deadlineSec: this.limits.deadlineSec, env: this.limits.env });
    // One agent at a time: a chat turn still answering the buyer's typed message finishes first (its reply and its
    // deal-state writes are then part of what this call starts from).
    const waited = await this.waitForTextTurn(accountId, conv.id, session.createdAt);
    if (this.ended) return;
    const dealNow = waited ? await readDealState(this.db, accountId, conv.leadId) : deal;
    // What the stage counts, as a chat turn does (writtenByAgent): the agent's own messages and spoken lines (both carry
    // the version id), not the app's (cards, follow-ups, the order-form link this engine stores).
    const agentRows = await this.db.select({ actor: messages.actor, agentVersionId: messages.agentVersionId }).from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "agent")));
    // A profile counts as Classic did: every agent message.
    this.agentMessages = this.profile ? agentRows.length : agentRows.filter(writtenByAgent).length;
    if (this.profile) this.log.info(voiceLine(this.sessionId, `engine=${this.profile.engine}`));
    if (this.speaker) this.log.info(voiceLine(this.sessionId, `rt output=text model=${this.model.modelId} speak=${this.speaker.modelId} voice=${PIPELINE_VOICE_NAME}`));

    // Recording is decided before the instructions are built: a recorded call's voice block has one rule about it.
    const recording = await this.startRecording(account);
    this.recorded = recording.on;
    const ctx = this.profile
      ? await this.profile.loadInstructions(this.db, { account, version, conv, lead, deal: dealNow, now: new Date(this.clock.now()) }, { recorded: this.recorded })
      : await loadVoiceInstructions(this.db, { account, version, conv, lead, deal: dealNow, now: new Date(this.clock.now()) }, { recorded: this.recorded });
    this.continuingCall = ctx.continuing;
    // The count the stage uses for this call's tools (effectiveAgentMessages; nothing of this call is stored yet).
    this.log.info(voiceLine(this.sessionId, inheritedSummary(this.effectiveAgentMessages(), ctx.continuing, dealNow?.fields ?? null, ctx.instructions)));
    this.spokenLanguage = ctx.language || "en";
    this.latinLanguage = NON_LATIN.test(this.spokenLanguage) ? "en" : this.spokenLanguage;
    const gen = ++this.gen;
    let conn: RealtimeConnection;
    const t0 = this.clock.now();
    const cfg = this.sessionConfig(ctx.instructions, ctx);
    this.stageDelivered = stageKey(ctx.instructions);
    try {
      conn = await this.model.connect(cfg, (e) => this.onModelEvent(e, gen));
    } catch (e) {
      this.lastError = clip(e instanceof Error ? e.message : e);
      this.log.warn(voiceLine(this.sessionId, `model connect failed after ${Math.round(this.clock.now() - t0)}ms: ${this.lastError}`));
      return this.fail("error", "model_unavailable");
    }
    this.log.info(voiceLine(this.sessionId, `model connected in ${Math.round(this.clock.now() - t0)}ms (${this.model.modelId}${this.model.mode === "live" && !isProvenVoiceModel(this.model.modelId) ? ", not tried live before" : ""}) ${configSummary(cfg)}`));
    if (this.ended || gen !== this.gen) {
      conn.close();
      return;
    }
    // The recording notice: the first sentence of the agent's first line, once per call, in the call's language.
    const noticeSaid = recording.on && recording.notice;
    const openerPrompt = noticeSaid
      ? withRecordingNotice(ctx.openerPrompt, recordingNoticeText(this.spokenLanguage), {
        position: ctx.continuing ? "pickup" : "opener",
        languageName: /^(en|he)\b/i.test(this.spokenLanguage) ? null : languageNameEn(this.spokenLanguage),
      })
      : ctx.openerPrompt;
    this.modelUp(conn);
    this.callStart = this.clock.now();
    // The agent speaks first: the chat's opener (or the pick-up line of a call that continues a chat), once per
    // call, as the model's very first input: no buyer audio reaches the model before it (the row write below used
    // to come first, and mic audio sent meanwhile got its own answer before the opener: two answers at the start).
    // The opening line waits until the browser can play it (its first words were lost while the phone's audio
    // output started, 23 Nov 2026), at most clientReadyMs; meanwhile no buyer audio reaches the model, so a buyer
    // who says "hello?" in that moment does not get an answer before the opening (one opening only).
    this.pendingOpener = { prompt: openerPrompt, kind: ctx.continuing ? "pick-up line" : "opener", since: this.clock.now() };
    if (!this.limits.waitForClientAudio || this.clientReady) this.sendOpener(this.clientReady ? "ready" : "now");
    else this.timer("ready", this.limits.clientReadyMs, () => this.sendOpener("timeout"));
    await this.db.update(voiceSessions)
      // A live call records the model it ran on; a scripted call keeps its version's model (the scripted model stands in).
      .set({
        status: "live", connectedAt: new Date(this.callStart), ...(this.model.mode === "live" ? { model: this.model.modelId } : {}), mode: this.model.mode, settings: this.settingsSnapshot(),
        recordingState: recording.on ? "recording" : "off", recordingRef: recording.prefix, recordingNoticeSaid: noticeSaid, recordingKeepDays: recording.keepDays,
        ...(recording.on ? { recordingChunks: 0, recordingBytes: 0, recordingSec: 0 } : {}),
      })
      .where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "pending")));
    // Limits: an announcement before the end (60 s before on a call of two minutes or more), then the end.
    const warnSec = limitWarnSecFor(this.maxSec, this.limits.limitWarnSec);
    if (this.maxSec > warnSec) this.timer("warn", (this.maxSec - warnSec) * 1000, () => this.warnLimit());
    this.timer("limit", this.maxSec * 1000, () => this.atLimit());
    this.statsLoop();
    this.heartbeatLoop();
    this.setState("listening");
  }

  /**
   * The agent messages the stage counts (lib/agent/core/stage.ts: Recommend opens at 2): the conversation's agent
   * messages, without the pick-up line of a call that continues a chat. That line re-asks the chat's last question
   * (already counted as the chat's message); counting it again moved the stage on one exchange early.
   */
  private effectiveAgentMessages(): number {
    // A profile counts as Classic did (the pick-up line too).
    if (this.profile) return this.agentMessages;
    return Math.max(0, this.agentMessages - (this.continuingCall && this.firstLineStored ? 1 : 0));
  }

  /**
   * A chat turn in flight on this conversation: its last line is the buyer's typed message (not said on a call),
   * stored less than TEXT_TURN_FRESH_MS ago, with no reply yet. The call waits for that reply (at most
   * TEXT_TURN_WAIT_MS), so the two agents never answer the same message. Returns whether it waited.
   */
  private async waitForTextTurn(accountId: string, conversationId: string, sessionCreatedAt: Date): Promise<boolean> {
    const t0 = this.clock.now();
    let waited = false;
    for (;;) {
      const [last] = await this.db.select({ actor: messages.actor, voiceSessionId: messages.voiceSessionId, createdAt: messages.createdAt }).from(messages)
        .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), inArray(messages.actor, ["buyer", "agent", "human"])))
        .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
      const inFlight = !!last && last.actor === "buyer" && !last.voiceSessionId && Date.now() - last.createdAt.getTime() < TEXT_TURN_FRESH_MS
        // A message stored less than TEXT_TURN_GUARD_MS before this call was created (or after): its chat turn checks
        // the one-agent guard after this session exists and stands down (in_call). Nobody else will answer it: no
        // wait; the call's first line answers it (lib/voice/instructions.ts answerLastInstruction).
        && last.createdAt.getTime() < sessionCreatedAt.getTime() - TEXT_TURN_GUARD_MS;
      if (!inFlight || this.ended) break;
      if (this.clock.now() - t0 >= TEXT_TURN_WAIT_MS) {
        this.log.warn(voiceLine(this.sessionId, `voice start waited ${Math.round(this.clock.now() - t0)}ms for a text turn; it has not answered: starting anyway`));
        return true;
      }
      waited = true;
      await new Promise<void>((r) => this.clock.setTimeout(r, 500));
    }
    if (waited) this.log.info(voiceLine(this.sessionId, `voice start waited ${Math.round(this.clock.now() - t0)}ms for a text turn`));
    return waited;
  }

  /**
   * A quote version's lines as a call says them: name, quantity and unit, unit price and line total in the quote's
   * currency (one-time or per period), in the quote's order. Never ids or SKUs.
   */
  private async quoteLinesForCall(quoteId: unknown, version: unknown): Promise<{ item: string; qty: number; unit: string; unit_price: string | null; line_total: string | null }[]> {
    if (typeof quoteId !== "string" || typeof version !== "number" || !this.loaded) return [];
    const accountId = this.loaded.account.id;
    const [v] = await this.db.select({ id: quoteVersions.id, currency: quoteVersions.currency }).from(quoteVersions)
      .where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.version, version)));
    if (!v) return [];
    const rows = await this.db.select().from(quoteLines).where(and(eq(quoteLines.accountId, accountId), eq(quoteLines.quoteVersionId, v.id))).orderBy(asc(quoteLines.sortOrder));
    // A line at no charge is "free", never "₪0.00" (said aloud: "zero shekels").
    const money = (minor: number | null, period: string | null) =>
      minor === null ? null : minor === 0 ? FREE_WORD[this.spokenLanguage] ?? FREE_WORD.en : formatMoney(minor, v.currency, period === "month" || period === "year" ? { period } : {});
    return rows.map((l) => ({ item: l.name, qty: l.qty, unit: l.unit, unit_price: money(l.unitPriceMinor, l.period), line_total: money(l.lineTotalMinor, l.period) }));
  }

  /** Asks the model for the opening (or pick-up) line, once: when the browser can play it, or at the timeout. */
  private sendOpener(why: "ready" | "timeout" | "now") {
    const o = this.pendingOpener;
    if (!o || this.ended || !this.conn) return;
    this.pendingOpener = null;
    this.clearTimer("ready");
    if (why !== "now") this.log.info(voiceLine(this.sessionId, `opening waited ${Math.round(this.clock.now() - o.since)}ms for the browser's audio (${why})`));
    this.noteSent(o.kind, true);
    this.conn.requestResponse(o.prompt);
  }

  /**
   * One log line per text the engine puts into the model's conversation mid-call: its kind only, never its words.
   * `response`: it goes with a request for the model's response (requestResponse); the trace says which.
   */
  private noteSent(kind: string, response = false) {
    this.log.info(voiceLine(this.sessionId, `note sent: ${kind}`));
    this.trace(`${response ? "response request" : "note"} kind=${kind}`);
  }

  /** A model event trace line: `trace t=<ms since the call went live> <what>`. Log only; never content. */
  private trace(what: string) {
    this.log.info(voiceLine(this.sessionId, `trace t=${this.offsetMs()} ${what}`));
  }

  /** The trace's view of the current response: its number, audio sent, and its own text's length and print. */
  private traceRespSummary(): string {
    const r = this.traceResp;
    if (!r) return "r=- audio=none";
    const said = (this.agentTurn?.text ?? "").slice(r.textFrom).trim();
    return `r=${r.n} audioMs=${Math.round(r.audioMs)} len=${said.length}${said ? ` print=${textPrint(said)}` : ""}`;
  }

  /**
   * Whether this call is recorded (the company's switch, and a store: lib/voice/recording.ts recordingStoreFor),
   * logged in one line. The recorder runs on the call clock from now.
   */
  private async startRecording(account: SellerAccount): Promise<{ on: boolean; notice: boolean; prefix: string | null; keepDays: number | null }> {
    const settings = resolveRecordingSettings(account.voiceSettings);
    if (!settings.recordCalls) {
      this.log.info(voiceLine(this.sessionId, "recording off: turned off in Settings › Voice"));
      return { on: false, notice: false, prefix: null, keepDays: null };
    }
    const choice = this.recordingChoice ?? await recordingStoreFor(this.model.mode, this.limits.env ?? process.env).catch(() => ({ store: null, reason: "store unavailable" }));
    if (!choice.store) {
      this.log.info(voiceLine(this.sessionId, `recording off: ${choice.reason}`));
      return { on: false, notice: false, prefix: null, keepDays: null };
    }
    const prefix = recordingPrefix(account.id, this.sessionId, this.limits.env ?? process.env);
    // The recording line: once per conversation, on its first recorded call (owner decision, 22 Nov 2026).
    const saidBefore = settings.recordingNotice && this.loaded
      ? (await this.db.select({ id: voiceSessions.id }).from(voiceSessions)
        .where(and(eq(voiceSessions.accountId, account.id), eq(voiceSessions.conversationId, this.loaded.conv.id), eq(voiceSessions.recordingNoticeSaid, true), ne(voiceSessions.id, this.sessionId)))
        .limit(1)).length > 0
      : false;
    const notice = settings.recordingNotice && !saidBefore;
    this.recorder = new CallRecorder({
      store: choice.store, prefix, ttlDays: settings.keepDays,
      onError: (e) => (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `recording chunk write failed: ${errorSummary(e)}`)),
    });
    this.log.info(voiceLine(this.sessionId, `recording on: ${choice.reason}, ${settings.keepDays ? `kept ${settings.keepDays} days` : "kept until deleted"}${notice ? ", line said" : saidBefore ? ", line said on an earlier call" : ", no line (switched off)"}`));
    return { on: true, notice, prefix, keepDays: settings.keepDays };
  }

  /**
   * The voice sent to the model: the seller's choice always. With no choice: Gemini gets no voice field (its own
   * default, as in the owner's working calls before 21 Nov; owner, 22 Nov: the pinned default sounded worse);
   * OpenAI gets its pinned default (alloy), except after the early-close retry (proven fields only).
   */
  private voiceInEffect(): string | null {
    // Text output: the model has no voice; ours is the speaker's.
    if (this.speaker) return null;
    const chosen = resolveVoiceSettings(this.loaded!.version.voiceSettings).voice;
    if (chosen) return chosen;
    if (schemaFamilyOf(this.model.modelId) === "gemini") return null;
    return this.safeConfig ? null : callVoice(null, this.model.modelId);
  }

  /** The session's settings snapshot: the version's settings, the voice actually in effect ("model default" when none is sent) and the limit. */
  private settingsSnapshot() {
    const version = this.loaded!.version;
    // No voice sent: the model's own default (the test lab's "This call" card shows it, as the fillers setting).
    const voice = this.speaker ? PIPELINE_VOICE_NAME : this.voiceInEffect() ?? MODEL_DEFAULT_VOICE;
    // Text output: the call's realtime model is the engine's (its session row), a scripted call's too.
    const rtModel = this.model.mode === "live" ? this.model.modelId : this.loaded!.session.model;
    // The model in the snapshot: the one this call ran on (live), or its version's (a scripted stand-in).
    return {
      ...version.voiceSettings, voice, fillers: this.speaker ? false : resolveVoiceSettings(version.voiceSettings).fillers, maxCallSec: this.maxSec,
      model: this.speaker ? rtModel : this.model.mode === "live" ? this.model.modelId : versionModelId(version.voiceSettings),
      // Another engine's model side: its name stays on the session (the test lab shows it; Call again keeps it).
      ...(this.profile ? { engine: this.profile.engine } : {}),
      ...(this.speaker ? { rtEleven: { realtimeModel: rtModel, speakModel: this.speaker.modelId, voice: PIPELINE_VOICE_NAME } } : {}),
    };
  }

  private sessionConfig(instructions: string, languages?: { language: string; expectedLanguages: string[] }): RealtimeSessionConfig {
    // A recorded call (and only one): how to answer if the buyer raises the recording; on every connection of the call.
    const cfg = this.fullSessionConfig(instructions, languages);
    // After an early close: only the session fields proven on this model family (lib/voice/gateway-realtime.ts).
    return this.safeConfig ? { ...cfg, safe: true } : cfg;
  }

  private fullSessionConfig(instructions: string, languages?: { language: string; expectedLanguages: string[] }): RealtimeSessionConfig {
    const version = this.loaded!.version;
    const settings = resolveVoiceSettings(version.voiceSettings);
    const family = schemaFamilyOf(this.model.modelId);
    // The version's own pause and interruption level replace the style's (models with tunable turn detection).
    const tt = turnTakingFor(settings.style, this.model.modelId, { pauseMs: settings.pauseMs, interrupt: settings.interrupt });
    return {
      // The order form's latest step (a note the model reads, never answers), on every connection after it came.
      // (A profile: notes go in as notes, as Classic: never in the instructions.)
      instructions: this.formNote && !this.profile ? `${instructions}\n\n### The order form (a note from the app, not from the buyer)\n${this.formNote}` : instructions,
      tools: this.profile ? this.profile.tools(family) : realtimeTools(family), toolBehavior: this.profile?.toolBehavior?.(family) ?? "blocking", pace: settings.pace,
      // The call starts in the conversation's language; the buyer may switch (never locked).
      language: languages?.language ?? (this.loaded!.conv.language || "en"),
      ...(languages ? { expectedLanguages: languages.expectedLanguages } : {}),
      // Always an explicit voice (the family default when none is chosen), on every connection: the same voice all call.
      ...(this.voiceInEffect() ? { voice: this.voiceInEffect()! } : {}),
      ...(tt ? { turnTaking: tt } : {}),
      // Text output: the model answers in text; our speaker says it.
      ...(this.speaker ? { outputModality: "text" as const } : {}),
      scenario: this.loaded!.conv.scenario,
    };
  }

  /** A transcript as stored and shown: markers taken out (Current), or as said (a profile). */
  private clean(text: string): string {
    return this.profile ? this.profile.clean(text) : cleanTranscript(text);
  }

  /** "Say it in Hebrew." for an injected instruction: the language the call speaks now, named. */
  private sayIn(): string {
    return `Say it in ${languageNameEn(this.spokenLanguage)}, the language you are speaking with the buyer.`;
  }

  /**
   * The buyer's line sets the language the call speaks. When it changes, a model that takes notes mid-call
   * (OpenAI) is told at once, so it does not drift back after an interruption; Gemini reads it in the
   * instructions of its next connection.
   */
  private trackSpokenLanguage(text: string) {
    const next = spokenLanguageOf(text, this.spokenLanguage, this.latinLanguage);
    if (next === this.spokenLanguage) return;
    this.spokenLanguage = next;
    // A profile (Classic): no language note; the language only picks the words of the quote summary.
    if (!this.profile && this.notesMidCall() && this.conn && !this.reconnecting && !this.waking && this.standbySince === null) {
      this.noteSent("language");
      this.conn.sendNote?.(`(Note from the system, not from the buyer: the buyer now speaks ${languageNameEn(next)}. Speak ${languageNameEn(next)} from now on, also after an interruption or a pause, until the buyer speaks another language. Do not answer this note.)`);
    }
  }

  /**
   * The agent is in the middle of a response: speaking, or between a tool call and the words after its result (the
   * buyer did not cut it).
   */
  private agentMidResponse(): boolean {
    const turn = this.agentTurn;
    return this.agentSpeaking || (!!turn && !turn.interrupted && (turn.heardAudio || turn.awaitingContinuation));
  }

  /**
   * The time limit: the call ends now, or, when the agent is mid-response, once that response is done (its
   * turn-done), at most limitFinishSec later (lib/voice/socket-limits.ts: 8 s, less when the function's deadline is
   * near). The announcement came before (warnLimit).
   */
  private atLimit() {
    const finishSec = limitFinishSec(this.maxSec, this.limits.deadlineSec);
    if (this.pendingEnd || finishSec <= 0 || !this.agentMidResponse()) {
      void this.stop("limit", undefined, "limit");
      return;
    }
    this.log.info(voiceLine(this.sessionId, `time limit: the agent finishes its response first (at most ${finishSec}s)`));
    this.warnHeld = false;
    this.endSoon("limit", finishSec * 1000);
  }

  /** The time-limit announcement waits for the agent's response to end (it never cuts the agent mid-sentence). */
  private warnHeld = false;

  private warnLimit() {
    // On standby (or waking) nobody is listening: the limit just ends the call.
    if (!this.conn || this.reconnecting) return;
    // The agent is mid-response: the announcement goes when that response is done (handleTurnDone).
    if (this.agentMidResponse()) {
      this.warnHeld = true;
      return;
    }
    this.warnHeld = false;
    this.send({ t: "notice", kind: "limit_soon" });
    this.noteSent("time limit", true);
    this.conn?.requestResponse(this.profile
      ? "The call is close to its time limit. Tell the buyer the call is about to end and offer to continue in the chat."
      : `The call is close to its time limit. Tell the buyer the call is about to end and offer to continue in the chat. ${this.sayIn()}`);
  }

  // -------------------------------------------------------------------------
  // Model events
  // -------------------------------------------------------------------------

  private onModelEvent(e: RealtimeEvent, gen: number) {
    if (this.ended || gen !== this.gen) return;
    switch (e.type) {
      case "session":
        this.providerSessionId = e.providerSessionId;
        return;
      case "audio": {
        const turn = this.ensureAgentTurn();
        this.traceAudio(e.pcm.byteLength, turn.heardAudio ? turn.text.length : 0);
        turn.heardAudio = true;
        turn.awaitingContinuation = false;
        if (turn.answerMs === null && this.buyerEndedAt !== null) {
          turn.answerMs = Math.max(0, Math.round(this.clock.now() - this.buyerEndedAt));
          this.answerTimes.push(turn.answerMs);
          this.buyerEndedAt = null;
        }
        if (this.currentWake) {
          this.currentWake.entry.firstAudioMs ??= Math.max(0, Math.round(this.clock.now() - this.currentWake.at));
          this.currentWake = null;
        }
        this.agentSpeaking = true;
        this.connAudio = true;
        this.clearQuiet();
        this.setState("speaking");
        this.send(e.pcm);
        // The recording's right channel: as the browser plays it (queued after what it still has).
        this.recorder?.agent(e.pcm, this.offsetMs());
        return;
      }
      case "agent-transcript": {
        // A transcription marker ("<no speech detected>") is no text: never shown, stored or a caption.
        const said = this.clean(e.text);
        if (!said) return;
        // Transcript of the response that already ended: it goes with that response's row, never into a new turn.
        if (e.late && !this.agentTurn) {
          void this.enqueue(() => this.storeLateTranscript(maskCardNumbers(said).text));
          return;
        }
        // The rest of the transcript of a response already stored as cut (typed text cut it; the provider's
        // transcript of that response keeps coming, from its start): the same utterance, not a new one.
        if (!this.agentTurn && this.cutText && maskCardNumbers(said).text.startsWith(this.cutText)) return;
        const turn = this.ensureAgentTurn();
        turn.awaitingContinuation = false;
        turn.text = maskCardNumbers(said).text;
        if (e.final) turn.finalText = true;
        if (!e.final) this.send({ t: "transcript", id: turn.id, role: "agent", text: maskPartialDigits(turn.text), final: false, atMs: turn.startMs });
        return;
      }
      case "buyer-transcript": {
        // A marker only (noise, silence) is not the buyer talking: no turn, no answer, no standby reset, no wake heard.
        const heard = this.clean(e.text);
        if (!heard.trim()) {
          // The speech that opened a buyer turn was a marker only: that turn is over (else standby would wait for it).
          if (e.final) this.buyerTurn = null;
          return;
        }
        this.buyerActivity();
        this.markHeard();
        if (!this.buyerTurn) this.buyerTurn = { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
        if (e.final) {
          // The buyer's words never go to the log: their length only.
          this.trace(`buyer said len=${heard.trim().length}${e.revises ? " revises=yes" : ""}`);
          void this.enqueue(() => this.handleBuyerFinal(heard, false, !!e.revises));
        } else {
          this.send({ t: "transcript", id: this.buyerTurn.id, role: "buyer", text: maskPartialDigits(heard), final: false, atMs: this.buyerTurn.startMs });
        }
        return;
      }
      case "speech-started":
        this.trace("buyer speech started");
        this.buyerActivity();
        if (!this.buyerTurn) this.buyerTurn = { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
        // Text output: our speaker is the one speaking (the model's in-flight response, if any, is cancelled by its own VAD).
        if (this.speaker) {
          if (this.agentSpeaking) this.cutSpeech("barge-in");
          return;
        }
        if (this.agentSpeaking) {
          this.trace(`interrupted (barge-in) ${this.traceRespSummary()}`);
          if (this.traceResp) this.traceResp.closedBy = "barge-in";
          // Barge-in: the browser drops the agent audio it still has queued; the turn is stored as cut.
          if (this.agentTurn) this.agentTurn.interrupted = true;
          this.send({ t: "flush" });
          // The browser drops the agent audio it still had queued: never heard, not in the recording.
          this.recorder?.cut(this.offsetMs());
          this.agentSpeaking = false;
          this.setState("listening");
        }
        return;
      case "tool-call": {
        // Whether the agent's audio of the current response had already gone out when the model called the tool.
        const r = this.traceResp && !this.traceResp.closedBy ? this.traceResp : null;
        this.traceCallAt.set(e.callId, this.clock.now());
        const dup = this.duplicateOf(e.callId, e.name, e.args);
        this.trace(`tool call received name=${clip(e.name, 40)} id=${clip(e.callId, 200).slice(-8)} r=${r ? r.n : "-"} afterSpeech=${r ? `yes sinceAudioMs=${Math.round(this.clock.now() - r.at)}` : "no"}${dup ? " dup=yes" : ""}`);
        if (dup) {
          this.log.info(voiceLine(this.sessionId, `tool ${clip(e.name, 40)} duplicate of ${clip(dup.id, 200).slice(-8)}: not run again`));
          void this.enqueue(async () => this.answerDuplicate(e.callId, e.name, dup));
          return;
        }
        void this.enqueue(() => this.handleTool(e.callId, e.name, e.args));
        return;
      }
      case "tool-cancelled":
        // Not queued: a result still being worked out must see it before it is sent.
        for (const id of e.callIds) this.cancelledCalls.add(id);
        this.log.info(voiceLine(this.sessionId, `tools: the model cancelled ${e.callIds.length || "its"} call(s); their results are not sent`));
        return;
      case "turn-done":
        this.trace(`turn done interrupted=${e.interrupted ? "yes" : "no"} ${this.traceRespSummary()}`);
        this.traceResp = null;
        if (!this.agentTurn) this.cutText = null;
        void this.enqueue(() => this.handleTurnDone(!!e.interrupted));
        return;
      case "usage":
        this.usageAcc.add(e.usage);
        this.sendStats();
        return;
      case "going-away":
        // One reconnect per connection: a going-away and its close (or a session-closed and the socket's close) are one event.
        if (this.closeHandledGen === gen) return;
        this.closeHandledGen = gen;
        this.log.info(voiceLine(this.sessionId, `model going away after ${this.msSinceConnect() ?? "?"}ms`));
        void this.enqueue(() => this.reconnect());
        return;
      case "closed": {
        const ms = this.msSinceConnect();
        if (e.error) this.lastError = clip(e.error);
        this.log.warn(voiceLine(this.sessionId, `model closed code=${e.code ?? "-"} reason="${clip(e.reason)}" error=${e.error ? "yes" : "no"} after=${ms ?? "?"}ms audio=${this.connAudio ? "yes" : "no"}`));
        if (this.closeHandledGen === gen) return;
        this.closeHandledGen = gen;
        this.modelClose = { code: e.code ?? null, reason: clip(e.reason), msAfterConnect: ms, error: !!e.error };
        // Closed before it said anything: not a normal drop (a session the provider refused, e.g. a setting it does not take).
        const early = !this.connAudio;
        void this.enqueue(() => this.reconnect(early));
        return;
      }
      case "diagnostic": {
        const n = (this.diagnostics.get(e.kind) ?? 0) + 1;
        this.diagnostics.set(e.kind, n);
        // Every cleaned agent transcript is logged (the cleaner must never hide spoken junk silently); audio
        // anomalies once, with their totals at the end of the call.
        if (e.kind === "cleaned-transcript") this.log.warn(voiceLine(this.sessionId, `cleaned agent transcript: ${e.detail ?? "marker"}`));
        else if (e.kind === "tool-continuation") {
          this.log.info(voiceLine(this.sessionId, `tools: ${e.detail ?? "response requested"}`));
          // OpenAI: the adapter asked for the model's next response after the tool results.
          if (!e.detail || e.detail.startsWith("response requested")) this.trace(`response request kind=tool results (${clip(e.detail ?? "", 60)})`);
        } else if (n === 1) {
          const what = e.kind === "audio-odd-bytes" ? "a piece with an odd byte count (carried to the next piece)"
            : e.kind === "audio-after-cut" ? "audio of a cut response arrived after the cut (dropped)"
            : "audio of an earlier response after a newer one";
          this.log.warn(voiceLine(this.sessionId, `agent audio: ${what}`));
        }
        return;
      }
      case "provider-event": {
        if (e.kind === "error") {
          this.lastError = clip(e.message ?? e.name);
          // An error before this connection said anything is the provider refusing (part of) the session setup:
          // never let it pass silently, and never run an agent without its playbook.
          if (!this.connAudio && gen === this.gen && !this.ended) {
            const why = clip(e.message ?? e.name);
            void this.enqueue(() => this.afterSetupRejected(why, gen));
            return;
          }
        }
        const key = `${e.kind}:${e.name}`;
        if (this.providerSeen.has(key)) return;
        this.providerSeen.add(key);
        const line = voiceLine(this.sessionId, `provider ${e.kind} event ${clip(e.name, 60)}${e.message ? `: ${clip(e.message)}` : ""}`);
        if (e.kind === "error") this.log.warn(line);
        else this.log.info(line);
        return;
      }
      case "trace":
        // Text output: the buyer's speech end starts the turn's clock (think = until the reply text is complete).
        if (this.speaker && e.what === "buyer speech stopped") {
          this.rt.heardAt = this.clock.now();
          this.rt.sawSpeechStopped = true;
          this.rt.toolRounds = 0;
        }
        this.trace(clip(e.what, 80));
        return;
      case "response-started":
        this.rt.responseOpen = true;
        return;
      case "response-text":
        this.onResponseText(e);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Text output: the model writes, our speaker speaks (lib/voice-rt-eleven)
  // -------------------------------------------------------------------------

  /**
   * A complete response's text. Spoken only when the response made NO tool call and was not cut: a response with a
   * tool call has its text dropped (never spoken, never stored) and the reply is the response after the results.
   * That rule removes repeated and premature speech by construction.
   */
  private onResponseText(e: Extract<RealtimeEvent, { type: "response-text" }>) {
    this.rt.responseOpen = false;
    if (!this.speaker || !this.player) return;
    // The model answered: its session setup was accepted (as agent audio shows for the audio models).
    this.connAudio = true;
    const text = e.text.trim();
    if (e.toolCalls > 0) {
      this.rt.toolRounds++;
      if (text) {
        this.rt.dropped++;
        this.log.info(voiceLine(this.sessionId, `rt text before tool dropped len=${text.length} tools=${e.toolCalls}`));
      }
      this.trace(`rt response with tools=${e.toolCalls} len=${text.length}${text ? " text dropped" : ""}`);
      return;
    }
    if (e.interrupted) {
      if (text) this.log.info(voiceLine(this.sessionId, `rt text of a cut response dropped len=${text.length}`));
      return;
    }
    if (!text) return;
    this.startSpeech(this.clean(text));
  }

  /** Hands a reply to the speaker: its spoken form, sentence by sentence. The turn's line is exactly that text. */
  private startSpeech(text: string) {
    const language = lineLanguage(text, this.spokenLanguage);
    const sentences = splitSentences(spokenForm(maskCardNumbers(text).text, language));
    if (!sentences.length) {
      this.log.info(voiceLine(this.sessionId, `rt reply has nothing to say after the spoken form (len=${text.length})`));
      return;
    }
    const said = sentences.join(" ");
    const turn = this.ensureAgentTurn();
    turn.text = said;
    turn.finalText = true;
    turn.awaitingContinuation = false;
    const now = this.clock.now();
    const from = this.rt.heardAt;
    const toolRounds = this.rt.toolRounds;
    this.rt.heardAt = null;
    this.rt.toolRounds = 0;
    const job = this.player!.play(turn.id, sentences, language);
    this.rtReplies.set(job.id, { job, turn, said, messageId: null, from, doneAt: now, toolRounds });
    this.agentSpeaking = true;
    this.clearQuiet();
    this.trace(`rt response complete len=${said.length} sentences=${sentences.length} think=${from === null ? "-" : `${Math.round(now - from)}ms`} toolRounds=${toolRounds}`);
  }

  /** A frame of the speaker's audio: to the browser and the recording's agent channel, as agent audio always goes. */
  private onSpeechFrame(frame: Uint8Array) {
    if (this.ended) return;
    if (this.currentWake) {
      this.currentWake.entry.firstAudioMs ??= Math.max(0, Math.round(this.clock.now() - this.currentWake.at));
      this.currentWake = null;
    }
    this.connAudio = true;
    this.clearQuiet();
    this.setState("speaking");
    this.send(frame);
    this.recorder?.agent(frame, this.offsetMs());
  }

  /** A reply's first audio went out: its answer time (from the buyer's speech end), and its row's times. */
  private onSpeechFirstAudio(job: SpeechJob) {
    const r = this.rtReplies.get(job.id);
    if (!r) return;
    const now = this.clock.now();
    const speakMs = Math.max(0, Math.round(now - r.doneAt));
    const totalMs = r.from === null ? null : Math.max(0, Math.round(now - r.from));
    const thinkMs = r.from === null ? null : Math.max(0, Math.round(r.doneAt - r.from));
    if (totalMs !== null && thinkMs !== null) {
      r.turn.answerMs = totalMs;
      this.answerTimes.push(totalMs);
      this.rt.times.push({ thinkMs, speakMs, totalMs, toolRounds: r.toolRounds });
      this.trace(`rt turn think=${thinkMs}ms toolRounds=${r.toolRounds} speak=${speakMs}ms total=${totalMs}ms chars=${r.said.length} speakModel=${this.speaker?.modelId ?? "-"}`);
    } else this.trace(`rt reply first audio speak=${speakMs}ms chars=${r.said.length} (no buyer turn)`);
    this.buyerEndedAt = null;
    const spokenAtMs = this.offsetMs();
    // The row was stored when the response ended (before its audio): it gets when it was heard and its answer time.
    void this.enqueue(async () => {
      if (!r.messageId || !this.loaded) return;
      await this.db.update(messages).set({ spokenAtMs, ...(totalMs !== null ? { answerMs: totalMs } : {}) })
        .where(and(eq(messages.id, r.messageId), eq(messages.accountId, this.loaded.account.id)));
    });
  }

  private onSpeechJobEnd(job: SpeechJob) {
    if (job.state === "failed") this.trace(`rt speech failed after ${job.sent}/${job.sentences.length} sentences${job.firstAudioAt === null ? " (nothing heard)" : ""}`);
    else this.trace(`rt speech done sentences=${job.sentences.length} chars=${job.chars}`);
  }

  /** Every reply was spoken and played out: the agent is quiet (what turn-done does for the audio models). */
  private afterSpeech() {
    this.agentSpeaking = false;
    if (this.ended) return;
    if (this.pendingEnd) {
      void this.stop(this.pendingEnd);
      return;
    }
    if (this.agentTurn) return;
    this.setState("listening");
    if (this.warnHeld) this.warnLimit();
    this.startQuiet();
  }

  /**
   * The buyer cut in while our speaker spoke (their speech, or a typed line): its audio stops at once, the browser
   * drops what it queued (flush), the recording too. The model believes it said the whole reply: one note tells it
   * what the buyer heard (the sentences sent whole before the cut). The stored line keeps what started playing,
   * ending with "…".
   */
  private cutSpeech(by: "barge-in" | "typed") {
    const job = this.player!.cancel();
    this.agentSpeaking = false;
    this.rt.bargeIns++;
    this.send({ t: "flush" });
    this.recorder?.cut(this.offsetMs());
    this.setState("listening");
    if (!job) return;
    const n = job.sentences.length;
    this.trace(`rt ${by}: speech stopped sentences sent=${job.sent}/${n} started=${job.started}/${n}`);
    if (job.sent >= n) return;
    const heard = job.sentences.slice(0, job.sent).join(" ");
    if (this.conn?.sendNote && this.notesMidCall() && !this.reconnecting && !this.waking && this.standbySince === null) {
      this.noteSent("barge-in");
      this.conn.sendNote(`(Note from the system, not from the buyer: the buyer interrupted you, so they did not hear all of your last reply. ${heard ? `They heard only: "${heard}"` : "They heard none of it."} Do not answer this note.)`);
    }
    const r = this.rtReplies.get(job.id);
    if (!r) return;
    if (!job.started) {
      this.log.info(voiceLine(this.sessionId, "rt reply cut before any audio: its line is kept as written"));
      return;
    }
    const body = cutLine(job.sentences.slice(0, job.started).join(" "));
    // Not stored yet: the row is written with the cut line. Stored: it is updated (queued after its insert).
    r.turn.text = body;
    void this.enqueue(async () => {
      if (!r.messageId || !this.loaded) return;
      const { account, conv } = this.loaded;
      await this.db.update(messages).set({ body, language: lineLanguage(body, conv.language) }).where(and(eq(messages.id, r.messageId), eq(messages.accountId, account.id)));
      const i = this.lines.findLastIndex((l) => l.role === "agent" && l.text === r.said);
      if (i >= 0) this.lines[i] = { role: "agent", text: body };
      if (this.lastLine?.messageId === r.messageId) this.lastLine = { ...this.lastLine, raw: body, cut: true };
      this.send({ t: "transcript", id: r.turn.id, role: "agent", text: body, final: true, atMs: r.turn.startMs });
    });
  }

  /** The call's speech figures (usage.rtEleven). */
  private rtUsage(realtimeCostMicros: number, speakCostMicros: number, speakRateKnown: boolean): RtElevenUsage {
    const t = this.rt.times;
    return {
      realtimeModel: this.model.mode === "live" ? this.model.modelId : this.loaded?.session.model ?? this.model.modelId,
      speakModel: this.speaker?.modelId ?? "", spokenChars: this.rt.chars, realtimeCostMicros, speakCostMicros, speakRateKnown,
      turns: t.length, medianAnswerMs: medianOf(t.map((x) => x.totalMs)), medianThinkMs: medianOf(t.map((x) => x.thinkMs)),
      medianSpeakMs: medianOf(t.map((x) => x.speakMs)), medianToolRounds: medianOf(t.map((x) => x.toolRounds)),
      droppedTexts: this.rt.dropped, bargeIns: this.rt.bargeIns,
    };
  }


  /** Tool calls received in this call, for the run-once guard (a profile with dedupeToolCallsMs): newest last. */
  private recentCalls: RecentToolCall[] = [];

  /**
   * The run-once guard for identical tool calls (Google's client-side dedupe for non-blocking tools; the silent probe
   * only): a call with the same tool and the same arguments (canonical JSON) as one received within the profile's
   * window in this call, in flight or done, is that call again. Returns the first one; else records this one.
   */
  private duplicateOf(callId: string, name: string, args: unknown): RecentToolCall | null {
    const windowMs = this.profile?.dedupeToolCallsMs;
    if (!windowMs) return null;
    const now = this.clock.now();
    this.recentCalls = this.recentCalls.filter((c) => now - c.at <= windowMs);
    const key = `${name}\n${canonicalJson(args)}`;
    const first = this.recentCalls.find((c) => c.key === key);
    if (first) return first;
    this.recentCalls.push({ id: callId, key, at: now, result: null });
    return null;
  }

  /**
   * A duplicate call's answer (never run again): the first call's result as data (its words to say and guidance
   * left out), marked not to start speech (scheduling SILENT on Gemini) and naming the call it duplicates.
   */
  private answerDuplicate(callId: string, name: string, first: RecentToolCall) {
    if (this.cancelledCalls.has(callId)) return;
    const { say_this: _say, message: _msg, scheduling: _sch, ...data } = first.result ?? { ok: true };
    void _say;
    void _msg;
    void _sch;
    const result = { ...data, duplicate_of: first.id, ...(schemaFamilyOf(this.model.modelId) === "gemini" ? { scheduling: "SILENT" } : {}) };
    if (this.conn) this.trace(`tool result sent name=${clip(name, 40)} id=${clip(callId, 200).slice(-8)} took=0ms chars=${JSON.stringify(result).length} dup=yes`);
    this.traceCallAt.delete(callId);
    this.conn?.sendToolResult(callId, name, result);
  }

  /**
   * The trace for a piece of agent audio: the first piece of a response (none open, or the open one ended by a
   * barge-in or a tool result) starts the next one; every piece adds its length. One line per response, never per piece.
   */
  private traceAudio(bytes: number, textLength: number) {
    const open = this.traceResp;
    if (open && !open.closedBy) {
      open.audioMs += pcmDurationMs(bytes);
      return;
    }
    if (open) this.trace(`agent response end by=${open.closedBy} ${this.traceRespSummary()}`);
    this.traceResp = { n: ++this.traceRespSeq, at: this.clock.now(), audioMs: pcmDurationMs(bytes), textFrom: textLength, closedBy: null };
    this.trace(`agent response start r=${this.traceResp.n}${open ? ` after=${open.closedBy}` : ""}`);
  }

  private ensureAgentTurn(): AgentTurn {
    if (!this.agentTurn) {
      // A new turn gets a new per-turn memo (lib/agent/tools.ts TurnMemo: never shared across turns).
      this.agentTurn = {
        id: `a${++this.turnSeq}`, text: "", startMs: this.offsetMs(), answerMs: null, tools: [],
        memo: { account: this.loaded?.account }, awaitingContinuation: false, heardAudio: false, interrupted: false, finalText: false,
      };
    }
    return this.agentTurn;
  }

  /** The buyer spoke or typed: the quiet timer (standby) starts over. */
  private buyerActivity() {
    this.clearQuiet();
  }

  /** The buyer was really heard (words, typed text, a tap): not a false wake, and the idle clock starts over. */
  private markHeard() {
    this.quietSince = null;
    if (this.currentWake) this.currentWake.entry.heard = true;
    this.clearTimer("falseWake");
  }

  private clearQuiet() {
    this.clearTimer("quiet");
  }

  /** The agent finished and waits for the buyer: standby after standbyAfterQuietMs of quiet. */
  private startQuiet() {
    if (this.ended || this.pendingEnd || this.standbySince !== null || this.waking) return;
    this.timer("quiet", this.limits.standbyAfterQuietMs, () => this.tryStandby());
  }

  /**
   * Standby only when nothing is going on: the opening line was spoken, the agent is not speaking,
   * no turn is open, no tool runs, nothing is queued, the buyer is not mid-turn and no end is pending.
   * Otherwise the quiet timer starts again (a turn that ends restarts it too).
   */
  private canStandby(): boolean {
    return !this.ended && !this.pendingEnd && !!this.conn && !this.reconnecting && !this.waking && this.standbySince === null
      && this.openerDone && !this.agentTurn && !this.agentSpeaking && this.toolsRunning === 0 && this.queueDepth === 0 && !this.buyerTurn;
  }

  private tryStandby() {
    if (this.canStandby()) this.enterStandby();
    else this.startQuiet();
  }

  /** Closes the model (the paid part) and listens for the buyer on our side. No message is stored. */
  private enterStandby() {
    this.closeModel();
    this.clearQuiet();
    this.clearTimer("falseWake");
    this.currentWake = null;
    this.standbySince = this.clock.now();
    this.standbys++;
    this.quietSince ??= this.standbySince;
    // Standby and wakes leave no rows: the log says when they happened (a silent stretch in the record).
    this.log.info(voiceLine(this.sessionId, `standby: model disconnected after ${Math.round(this.limits.standbyAfterQuietMs / 1000)}s quiet`));
    this.vad.reset();
    this.preRoll.clear();
    this.setState("standby");
    this.armIdle();
  }

  /** Continuous standby with no speech ends the call; never while the order form is open (the call's limit applies). */
  private armIdle() {
    if (this.formOpen || this.standbySince === null) {
      this.clearTimer("idle");
      return;
    }
    const left = this.limits.standbyIdleEndMs - (this.clock.now() - (this.quietSince ?? this.standbySince));
    this.timer("idle", Math.max(0, left), () => {
      if (this.standbySince !== null) void this.stop("idle", undefined, "idle");
    });
  }

  /** Mic audio on standby: kept for the pre-roll, and a wake when the detector hears speech. */
  private listenOnStandby(bytes: Uint8Array) {
    this.preRoll.push(bytes);
    if (this.vad.push(bytes) !== "start") return;
    if (this.clock.now() - this.lastWakeAt < this.limits.minWakeGapMs) return;
    if (this.beginWake("speech")) void this.enqueue(async () => void (await this.connectAfterWake()));
  }

  /** Audio while the model reconnects on a wake: sent once it is ready (capped). */
  private holdWakeAudio(bytes: Uint8Array) {
    if (this.wakeAudioMs >= this.limits.wakeBufferMaxMs) return;
    this.wakeAudio.push(bytes);
    this.wakeAudioMs += pcmDurationMs(bytes.byteLength);
  }

  /** A tap on the call bar (`{t:'wake'}`). */
  private tapWake() {
    if (!this.beginWake("tap")) return;
    this.markHeard();
    void this.enqueue(async () => void (await this.connectAfterWake()));
  }

  /** Leaves standby (synchronously, so no audio is lost): the pre-roll becomes the start of the wake audio. */
  private beginWake(by: WakeEntry["by"]): boolean {
    if (this.ended || this.standbySince === null || this.waking) return false;
    const now = this.clock.now();
    this.standbySince = null;
    this.waking = true;
    this.clearTimer("idle");
    this.wakeAudio = by === "speech" ? this.preRoll.drain() : [];
    this.wakeAudioMs = this.wakeAudio.reduce((n, f) => n + pcmDurationMs(f.byteLength), 0);
    this.preRoll.clear();
    this.vad.reset();
    this.lastWakeAt = now;
    const entry: WakeEntry = { by, atMs: this.offsetMs(), readyMs: null, firstAudioMs: null, heard: by !== "speech" };
    this.log.info(voiceLine(this.sessionId, `wake by ${by}`));
    this.wakeLog.push(entry);
    this.currentWake = { at: now, entry };
    // The buyer is talking (or about to): the bar shows listening while the agent reconnects.
    this.setState("listening");
    return true;
  }

  /**
   * Reconnects the model after a wake, with fresh instructions and the recap; the held audio goes
   * first, then live audio flows as usual. One retry; else the call ends (connection_lost).
   */
  private async connectAfterWake(): Promise<boolean> {
    if (this.ended || !this.waking || !this.loaded) return false;
    let conn: RealtimeConnection | null = null;
    for (let attempt = 0; attempt < 2 && !conn && !this.ended; attempt++) {
      conn = (await this.openModel({ resumed: true, woke: true }, this.limits.wakeConnectMs, `wake ${attempt + 1}`))?.conn ?? null;
    }
    if (this.ended) {
      conn?.close();
      return false;
    }
    this.waking = false;
    if (!conn) {
      this.wakeAudio = [];
      this.fail("connection_lost", "connection_lost", "model_closed");
      return false;
    }
    this.modelUp(conn);
    const wake = this.currentWake;
    if (wake) wake.entry.readyMs = Math.max(0, Math.round(this.clock.now() - wake.at));
    const held = this.wakeAudio;
    this.wakeAudio = [];
    this.wakeAudioMs = 0;
    if (!this.muted) for (const f of held) conn.sendAudio(f);
    if (wake?.entry.by === "speech" && !wake.entry.heard) this.timer("falseWake", this.limits.falseWakeMs, () => this.falseWake());
    this.startQuiet();
    return true;
  }

  /** A speech wake that produced no words: count it, raise the detector after a few, and go back to standby when idle. */
  private falseWake() {
    this.falseWakes++;
    if (this.falseWakes % this.limits.falseWakesBeforeRaise === 0) this.vad.boost = Math.min(this.limits.maxThresholdBoost, this.vad.boost * 2);
    if (this.canStandby()) this.enterStandby();
  }

  /**
   * One model connection with fresh instructions and the call's recap, within `ms`; null on failure
   * or timeout (a late connection is closed at once).
   */
  private async openModel(opts: { resumed: boolean; woke?: boolean }, ms: number, what: string): Promise<{ conn: RealtimeConnection; openerPrompt: string } | null> {
    const { account, version, conv, lead } = this.loaded!;
    const gen = this.gen;
    const t0 = this.clock.now();
    let openerPrompt = "";
    let sent = `config=${this.safeConfig ? "safe" : "full"}`;
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => this.timer("reconnect", ms, () => { timedOut = true; resolve(null); }));
    const attempt = (async () => {
      const deal = await readDealState(this.db, account.id, conv.leadId);
      const ctx = this.profile
        ? await this.profile.loadInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) }, {
          ...(opts.resumed ? { recap: this.lines.slice(-RECAP_LINES) } : {}), ...opts, recorded: this.recorded,
        })
        : await loadVoiceInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) }, {
          ...(opts.resumed ? { recap: this.lines.slice(-RECAP_LINES), agentMessages: this.effectiveAgentMessages() } : {}), ...opts, language: this.spokenLanguage, recorded: this.recorded,
        });
      openerPrompt = ctx.openerPrompt;
      const cfg = this.sessionConfig(ctx.instructions, ctx);
      this.stageDelivered = stageKey(ctx.instructions);
      sent = configSummary(cfg);
      return this.model.connect(cfg, (e) => this.onModelEvent(e, gen));
    })().catch((e) => {
      this.lastError = clip(e instanceof Error ? e.message : e);
      return null;
    });
    const conn = await Promise.race([attempt, timeout]);
    this.clearTimer("reconnect");
    const took = Math.round(this.clock.now() - t0);
    if (!conn || timedOut || this.ended || gen !== this.gen) {
      void attempt.then((late) => late?.close());
      this.log.warn(voiceLine(this.sessionId, `${what} failed after ${took}ms (${sent}): ${timedOut ? "timed out" : this.ended ? "call ended" : clip(this.lastError) || "no connection"}`));
      return null;
    }
    this.log.info(voiceLine(this.sessionId, `${what} connected in ${took}ms${this.safeConfig ? " (proven session fields only)" : ""} ${sent}`));
    return { conn, openerPrompt };
  }

  private msSinceConnect(): number | null {
    return this.connAt === null ? null : Math.max(0, Math.round(this.clock.now() - this.connAt));
  }

  private toolCtx(callId: string, memo: TurnMemo): ToolContext {
    const { conv, version, account } = this.loaded!;
    return {
      db: this.db, accountId: account.id, conversationId: conv.id, leadId: conv.leadId, playbook: version.playbook, currency: account.currency,
      // The model's call id, scoped to this call: the idempotency key for writes.
      callId: `voice:${this.sessionId}:${callId}`, language: this.toolLanguage(), memo, agentMessages: this.effectiveAgentMessages(),
    };
  }

  /**
   * The language the tools write in on a call (quote cards, fixed texts): the language being spoken (owner, 23 Nov
   * 2026: an English call on a Hebrew lead got a Hebrew quote card), when the app has texts in it; else the
   * conversation's.
   */
  private toolLanguage(): string {
    return isLocale(this.spokenLanguage) ? this.spokenLanguage : this.loaded!.conv.language;
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private async handleBuyerFinal(raw: string, typed: boolean, revises = false) {
    if (this.ended || !this.loaded) return;
    const { conv, account } = this.loaded;
    const masked = maskCardNumbers(raw.replace(/\s+/g, " ").trim().slice(0, 4000));
    if (!masked.text) return;
    // A later transcript of the buyer's last spoken line of THIS call (the same utterance) updates its row: one row per
    // buyer turn. The provider says so (`revises`), or the text is that line grown (a running transcript) shortly after.
    const prev = this.lastBuyerLine;
    if (!typed && prev && (revises || (this.clock.now() - prev.at <= BUYER_LINE_REVISE_MS && grownFrom(masked.text, prev.text)))) {
      await this.reviseBuyerLine(prev, masked.text);
      return;
    }
    // Text output: a typed line is the buyer's turn now (its clock starts); one typed while our speaker speaks cuts it.
    if (typed && this.speaker) {
      this.rt.heardAt = this.clock.now();
      this.rt.toolRounds = 0;
      if (this.agentSpeaking) {
        if (this.rt.responseOpen) this.conn?.cancelResponse?.();
        this.cutSpeech("typed");
      }
    } else if (!typed && this.speaker && !this.rt.sawSpeechStopped && this.rt.heardAt === null) {
      // A model that reports no speech end (the scripted one): the buyer's final line starts the turn's clock.
      this.rt.heardAt = this.clock.now();
      this.rt.toolRounds = 0;
    }
    // Typed while the agent speaks: like a barge-in, the browser drops the queued agent audio.
    if (typed && this.agentSpeaking && !this.speaker) {
      if (this.agentTurn) this.agentTurn.interrupted = true;
      this.conn?.cancelResponse?.();
      this.send({ t: "flush" });
      this.recorder?.cut(this.offsetMs());
      this.agentSpeaking = false;
    }
    const turn = this.buyerTurn ?? { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
    // OpenAI: the transcription came after the answer started. That answer (started once the buyer began) stays open,
    // and agent lines already stored since the buyer began move after this one: the buyer's line comes first.
    const late = this.lateBuyerTranscript && !typed;
    const answering = late && !!this.agentTurn && this.agentTurn.startMs >= turn.startMs;
    // What the agent said before this buyer turn is stored first, so the thread keeps its order.
    if (!answering) await this.finalizeAgentTurn("buyer");
    this.buyerTurn = null;
    const buyerMessageId = randomUUID();
    await this.db.insert(messages).values({
      id: buyerMessageId, accountId: account.id, conversationId: conv.id, actor: "buyer", body: masked.text, language: lineLanguage(masked.text, conv.language),
      voiceSessionId: this.sessionId, spokenAtMs: turn.startMs, typedInCall: typed, createdAt: await this.stamp(),
    });
    // A spoken line may still be revised (a later transcript of it); a typed one never is, and closes the last one.
    this.lastBuyerLine = typed ? null : { messageId: buyerMessageId, turnId: turn.id, text: masked.text, startMs: turn.startMs, at: this.clock.now() };
    this.trackSpokenLanguage(masked.text);
    const moved = late ? await this.moveAgentLinesAfterBuyer(turn.startMs) : 0;
    this.lines.splice(this.lines.length - moved, 0, { role: "buyer", text: masked.text });
    this.send({ t: "transcript", id: turn.id, role: "buyer", text: masked.text, final: true, atMs: turn.startMs, ...(typed ? { typed: true as const } : {}) });
    // The answer already started: its answer time was taken (or is unknown); a later turn must not reuse this one.
    if (!answering && !moved) this.buyerEndedAt = this.clock.now();
    this.buyerActivity();
    if (typed) this.markHeard();
    if (!this.conn && this.standbySince === null) return;
    // A person took the conversation over during the call: the agent stops (the buyer's words are kept).
    const [now] = await this.db.select({ status: conversations.status, takenOverByUserId: conversations.takenOverByUserId }).from(conversations)
      .where(and(eq(conversations.id, conv.id), eq(conversations.accountId, account.id)));
    // A hand-off made on this call keeps the call going (the agent no longer sells); a person who takes it over ends it.
    if (now?.status === "human" && !this.pendingEnd && (now.takenOverByUserId || !this.handedOffHere)) {
      void this.stop(now.takenOverByUserId ? "take_over" : "handoff", undefined, "take_over");
      return;
    }
    // Typed on standby: the agent reconnects first, then gets the text.
    if (this.standbySince !== null) {
      if (!this.beginWake("typed") || !(await this.connectAfterWake())) return;
    }
    if (!this.conn) return;
    // Nothing answered this line yet: the quiet timer runs until the agent speaks (its audio stops it).
    this.startQuiet();
    // A spoken turn is already being answered by the model (the provider's own turn detection starts its response):
    // an injected instruction on top would be a second answer to the same turn. So the fixed replies below are
    // injected only for a typed line, which the model never hears; on a spoken one the model answers by its rules
    // (the voice block's card and opt-out lines; the record_opt_out result gives the exact reply).
    if (this.profile) {
      // Classic: the fixed replies are asked for on any line, spoken or typed, in English.
      if (isSpokenOptOut(masked.text)) await this.codeOptOut(masked.text, true, OPT_OUT_REPLY.en);
      else if (masked.found) {
        this.noteSent("card number", true);
        this.conn.requestResponse(`The buyer started reading out a card number. Stop them politely and say exactly this and nothing else: "${CARD_REPLY.en}"`);
      } else if (typed) {
        this.noteSent("typed line", schemaFamilyOf(this.model.modelId) !== "gemini");
        this.conn.sendText(masked.text);
      }
    } else if (isSpokenOptOut(masked.text)) {
      await this.codeOptOut(masked.text, typed);
    } else if (masked.found && !typed) {
      this.log.info(voiceLine(this.sessionId, "note skipped: card number on a spoken turn (the model answers it)"));
    } else if (masked.found) {
      // Card details never belong in a call: the fixed security reply, as in chat.
      this.noteSent("card number", true);
      this.conn.requestResponse(`The buyer started reading out a card number. Stop them politely and say exactly this and nothing else: "${CARD_REPLY[this.spokenLanguage] ?? CARD_REPLY.en}"`);
    } else if (typed) {
      this.noteSent("typed line", schemaFamilyOf(this.model.modelId) !== "gemini");
      this.conn.sendText(masked.text);
    }
  }

  /**
   * A later transcript of the buyer's last spoken line (this call's own row): the row, the recap line and the
   * browser's line are updated in place; no new row and no new answer (the model already has the audio). The same
   * text: nothing to do.
   */
  private async reviseBuyerLine(prev: NonNullable<VoiceEngine["lastBuyerLine"]>, text: string) {
    this.buyerTurn = null;
    this.buyerActivity();
    this.markHeard();
    if (text === prev.text) return;
    const { conv, account } = this.loaded!;
    await this.db.update(messages).set({ body: text, language: lineLanguage(text, conv.language) })
      .where(and(eq(messages.id, prev.messageId), eq(messages.accountId, account.id), eq(messages.voiceSessionId, this.sessionId)));
    const i = this.lines.findLastIndex((l) => l.role === "buyer" && l.text === prev.text);
    if (i >= 0) this.lines[i] = { role: "buyer", text };
    this.lastBuyerLine = { ...prev, text };
    this.log.info(voiceLine(this.sessionId, "buyer line revised: a later transcript of the same line updated its row"));
    this.trackSpokenLanguage(text);
    this.send({ t: "transcript", id: prev.turnId, role: "buyer", text, final: true, atMs: prev.startMs });
    // An opt-out said in the rest of the line counts as if it came whole (spoken: the model answers it).
    if (!this.profile && isSpokenOptOut(text)) await this.codeOptOut(text, false);
  }

  /**
   * Agent lines of this call stored after the buyer began the turn just stored (OpenAI's late transcription):
   * they get new times after it, in their order, so the thread reads buyer line, then the answer. Returns how many.
   */
  private async moveAgentLinesAfterBuyer(buyerStartMs: number): Promise<number> {
    const { account, conv } = this.loaded!;
    const rows = await this.db.select({ id: messages.id, spokenAtMs: messages.spokenAtMs }).from(messages)
      .where(and(eq(messages.accountId, account.id), eq(messages.conversationId, conv.id), eq(messages.voiceSessionId, this.sessionId), eq(messages.actor, "agent")))
      .orderBy(asc(messages.createdAt));
    // Only the trailing run: agent lines stored after the buyer's turn began, with no buyer line between.
    const after = rows.filter((r) => r.spokenAtMs !== null && r.spokenAtMs >= buyerStartMs);
    for (const r of after) await this.db.update(messages).set({ createdAt: await this.stamp() }).where(and(eq(messages.id, r.id), eq(messages.accountId, account.id)));
    return Math.min(after.length, this.lines.length);
  }

  /** The buyer opted out in words the code recognises: the same effect as the record_opt_out tool. */
  private async codeOptOut(said: string, typed: boolean, reply: string = OPT_OUT_REPLY[this.spokenLanguage] ?? OPT_OUT_REPLY.en) {
    if (this.optedOut) return;
    const turn = this.ensureAgentTurn();
    const r = await this.runRecorded(turn, `optout-${this.turnSeq}`, "record_opt_out", { reason: said.slice(0, 200) });
    if (r.outcome !== "ok") return;
    this.afterOptOut();
    if (!typed) {
      this.log.info(voiceLine(this.sessionId, "note skipped: opt-out on a spoken turn (the model answers it)"));
      return;
    }
    this.noteSent("opt-out reply", true);
    this.conn?.requestResponse(`The buyer asked not to be contacted again and is now opted out. Say exactly this and nothing else: "${reply}"`);
  }

  private afterOptOut() {
    this.optedOut = true;
    this.endSoon("opt_out");
  }

  /** The call ends once the agent finishes its sentence, at most endGraceMs from now. */
  private endSoon(reason: VoiceEndReason, graceMs = this.limits.endGraceMs) {
    this.pendingEnd = reason;
    this.clearQuiet();
    this.timer("grace", graceMs, () => void this.stop(reason));
  }

  /**
   * update_deal_state on a call: updates that LOWER a number the buyer stated (provenance buyer) are taken out of the
   * call (the rest runs) unless the buyer's last line says that number. 23 Nov 2026: "Yeah, I guess so. I need a
   * solution." turned two sites into one. Returns what was kept (field label and the buyer's value).
   */
  private async holdLoweredNumbers(args: unknown): Promise<{ key: string; label: string; value: string }[]> {
    if (!this.loaded || !args || typeof args !== "object" || !Array.isArray((args as { updates?: unknown }).updates)) return [];
    const a = args as { updates: unknown[] };
    const deal = await readDealState(this.db, this.loaded.account.id, this.loaded.conv.leadId);
    const fields = (deal?.fields ?? {}) as Record<string, { value?: string; provenance?: string } | undefined>;
    const buyerLine = this.lines.findLast((l) => l.role === "buyer")?.text ?? "";
    const kept: { key: string; label: string; value: string }[] = [];
    a.updates = a.updates.filter((u) => {
      const key = u && typeof u === "object" ? String((u as { key?: unknown }).key ?? "") : "";
      const next = Number(String((u as { value?: unknown })?.value ?? "").trim());
      const was = fields[key];
      const before = Number(String(was?.value ?? "").trim());
      if (!key || !was || was.provenance !== "buyer" || !Number.isFinite(next) || !Number.isFinite(before) || next >= before) return true;
      if (lineSaysNumber(buyerLine, next)) return true;
      const label = this.loaded!.version.playbook.fields.find((f) => f.key === key)?.label ?? key;
      kept.push({ key, label, value: String(was.value) });
      return false;
    });
    return kept;
  }

  /**
   * A create_quote that covers FEWER sites than the buyer stated (deal state, provenance buyer) or fewer units of an
   * item than the buyer's latest quote: the new numbers (to find in the lines) and the smaller set in words. Null when
   * it is not smaller (or there is nothing to compare with).
   */
  private async smallerQuote(args: unknown): Promise<{ numbers: number[]; what: string } | null> {
    if (!this.loaded || !args || typeof args !== "object") return null;
    const { account, conv } = this.loaded;
    const a = args as { lines?: unknown; sites?: unknown };
    const sites = typeof a.sites === "number" && Number.isInteger(a.sites) && a.sites > 0 ? a.sites : null;
    let statedSites: number | null = null;
    if (sites !== null) {
      const deal = await readDealState(this.db, account.id, conv.leadId);
      const stated = (deal?.fields as Record<string, { value?: string; provenance?: string } | undefined> | undefined)?.sites;
      const before = Number(String(stated?.value ?? "").trim());
      if (stated?.provenance === "buyer" && Number.isFinite(before)) statedSites = before;
    }
    const asked = (Array.isArray(a.lines) ? a.lines : []).map((l) => ({ sku: String((l as { sku?: unknown })?.sku ?? ""), qty: Number((l as { qty?: unknown })?.qty) }));
    let latest: { sku: string; name: string; qty: number; recurring: boolean }[] = [];
    if (asked.length) {
      // The latest quote, whatever its status (held, declined or cancelled included): compared by its quantities.
      const [q] = await this.db.select({ id: quotes.id, version: quotes.currentVersion }).from(quotes)
        .where(and(eq(quotes.accountId, account.id), eq(quotes.leadId, conv.leadId))).orderBy(desc(quotes.createdAt), desc(quotes.number)).limit(1);
      const [v] = q ? await this.db.select({ id: quoteVersions.id }).from(quoteVersions)
        .where(and(eq(quoteVersions.accountId, account.id), eq(quoteVersions.quoteId, q.id), eq(quoteVersions.version, q.version))) : [];
      const rows = v ? await this.db.select({ sku: quoteLines.sku, name: quoteLines.name, qty: quoteLines.qty, chargeType: quoteLines.chargeType }).from(quoteLines)
        .where(and(eq(quoteLines.accountId, account.id), eq(quoteLines.quoteVersionId, v.id))) : [];
      latest = rows.map((r) => ({ sku: r.sku, name: r.name, qty: r.qty, recurring: r.chargeType !== "one_time" }));
    }
    return smallerQuoteParts({ sites, statedSites, asked, latest });
  }

  /**
   * Whether the quote create_quote held on this call still waits for the team's approval. Once the team approved
   * (or declined) it, the hold is lifted and the tool decides (it refuses a quote that is not ready).
   */
  private async quoteStillHeld(): Promise<boolean> {
    if (!this.heldQuote) return false;
    if (!this.heldQuote.id || !this.loaded) return true;
    const [q] = await this.db.select({ status: quotes.status }).from(quotes)
      .where(and(eq(quotes.accountId, this.loaded.account.id), eq(quotes.id, this.heldQuote.id)));
    if (q && q.status !== "awaiting_approval") {
      this.heldQuote = null;
      return false;
    }
    return true;
  }

  /** A tool call the engine refuses on a call without running it, recorded like any other (the steps view shows it). */
  private async refuseRecorded(turn: AgentTurn, callId: string, name: string, args: unknown, why: { rule: string; message: string }): Promise<ToolResult> {
    await this.stamp();
    const r: ToolResult = { outcome: "refused", rule: why.rule, result: { ok: false, rule: why.rule, message: why.message } };
    turn.tools.push({ name, input: args, r });
    return r;
  }

  private async runRecorded(turn: AgentTurn, callId: string, name: string, args: unknown): Promise<ToolResult> {
    let r: ToolResult;
    await this.stamp(); // rows the tool writes come after everything stored so far
    if (!VOICE_TOOL_NAMES.has(name)) {
      r = { outcome: "failed", result: { ok: false, error: `Unknown tool ${name}` } };
    } else if (name === "end_call") {
      // Voice-only: nothing to run; handleTool ends the call after the goodbye.
      r = { outcome: "ok", result: { ok: true } };
    } else if (name === "order_form_status") {
      // Voice-only: the form tab's last report (fixed step names, never values).
      r = { outcome: "ok", result: { ok: true, ...orderFormStatus(this.formLast) } };
    } else {
      try {
        r = await runTool(name, args, this.toolCtx(callId, turn.memo));
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `tool ${name} failed: ${errorSummary(e)}`));
        r = { outcome: "failed", result: { ok: false, error: "The tool failed. Tell the buyer you will check and get back to them." } };
      }
    }
    turn.tools.push({ name, input: args, r });
    return r;
  }

  private async handleTool(callId: string, name: string, args: unknown) {
    if (this.ended || !this.loaded) return;
    this.toolsRunning++;
    try {
      await this.runToolForModel(callId, name, args);
    } finally {
      this.toolsRunning--;
    }
  }

  /**
   * Tool arguments as the tool takes them, where a realtime model (not strict about the schema) gets them wrong:
   * - update_deal_state: `recommendation_confirmed` / `price_asked` sent as deal-state fields in `updates` (the
   *   22 Nov 2026 call: refused twice as "Unknown deal-state fields") become the top-level booleans they are;
   * - send_order_form: a quote given by its internal id (a uuid from create_quote's result), or a number this
   *   buyer has no quote for, becomes the buyer's current quote ("Q-<number>").
   */
  private async voiceToolArgs(name: string, args: unknown): Promise<unknown> {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const a = { ...(args as Record<string, unknown>) };
    if (name === "update_deal_state" && Array.isArray(a.updates)) {
      const facts: Record<string, string> = { recommendation_confirmed: "recommendation_confirmed", _recommendation_confirmed: "recommendation_confirmed", price_asked: "price_asked", _price_asked: "price_asked" };
      const keep: unknown[] = [];
      for (const u of a.updates) {
        const key = u && typeof u === "object" ? String((u as { key?: unknown }).key ?? "").trim() : "";
        const fact = facts[key];
        if (!fact) {
          keep.push(u);
          continue;
        }
        const v = String((u as { value?: unknown }).value ?? "").trim().toLowerCase();
        if (typeof a[fact] !== "boolean" && /^(true|false|yes|no)$/.test(v)) a[fact] = v === "true" || v === "yes";
      }
      a.updates = keep;
    }
    // N1: a realtime model may send time as "null" or "" instead of null (no time named: only the booking card).
    if (name === "request_callback" && typeof a.time === "string" && /^\s*(null|none|undefined)?\s*$/i.test(a.time)) a.time = null;
    if (name === "send_order_form" && this.loaded) {
      const { account, conv } = this.loaded;
      const given = String(a.quote ?? "").trim();
      const number = /^\s*Q-?\d+(\s*v\d+)?\s*$/i.test(given) || /^\d+$/.test(given) ? Number(given.replace(/^\s*Q-?/i, "").replace(/\s*v\d+\s*$/i, "")) : NaN;
      const own = (await this.db.select({ id: quotes.id, number: quotes.number }).from(quotes)
        .where(and(eq(quotes.accountId, account.id), eq(quotes.leadId, conv.leadId))).orderBy(desc(quotes.createdAt), desc(quotes.number)));
      const match = own.find((q) => q.number === number || q.id === given);
      const pick = match ?? own[0];
      if (pick && (!match || match.number !== number)) a.quote = `Q-${pick.number}`;
    }
    return a;
  }

  private async runToolForModel(callId: string, name: string, rawArgs: unknown) {
    const turn = this.ensureAgentTurn();
    const label = toolLabel(name);
    this.setState("checking");
    this.send({ t: "tool", id: callId, name, label, status: "running" });
    // A profile (Classic) passes the model's arguments as they came.
    const args = this.profile ? rawArgs : await this.voiceToolArgs(name, rawArgs).catch(() => rawArgs);
    const t0 = this.clock.now();
    // The order form on a call goes only after the buyer agreed to it (or asked for it): see orderFormAgreed.
    // A number the buyer stated (sites, quantities) is not lowered unless their last line says the new number.
    const kept = name === "update_deal_state" ? await this.holdLoweredNumbers(args).catch(() => []) : [];
    // The order form never goes for a quote waiting for the team's approval, even after the buyer's yes.
    const quoteHeld = name === "send_order_form" ? await this.quoteStillHeld().catch(() => true) : false;
    const formGate = name === "send_order_form" && !quoteHeld ? orderFormAgreed(this.lines) : "yes";
    // A line the app adds to a quote (installation, setup) comes off only when the buyer asked: see removalAsked.
    const removing = name === "create_quote" ? removedAutoAdded(args) : [];
    const removeGate = removing.length ? removalAsked(this.lines) : "yes";
    // A quote for fewer units or sites than before goes only when the buyer asked for it (or said yes to the offer).
    const smaller = name === "create_quote" && removeGate !== "no" ? await this.smallerQuote(args).catch(() => null) : null;
    const smallerGate = smaller ? smallerQuoteAgreed(this.lines, (line) => smaller.numbers.some((n) => lineSaysNumber(line, n))) : "yes";
    const r = quoteHeld
      ? await this.refuseRecorded(turn, callId, name, args, { rule: HELD_FORM_RULE, message: HELD_FORM_MESSAGE })
      : formGate === "no"
        ? await this.refuseRecorded(turn, callId, name, args, FORM_NOT_AGREED)
        : removeGate === "no"
          ? await this.refuseRecorded(turn, callId, name, args, removalNotAsked(removing))
          : smallerGate === "no" && smaller
            ? await this.refuseRecorded(turn, callId, name, args, smallerQuoteNotAsked(smaller.what))
            : await this.runRecorded(turn, callId, name, args);
    if (quoteHeld) this.log.info(voiceLine(this.sessionId, "tool send_order_form held: the quote waits for the team's approval"));
    // The conversation's latest quote: held for approval (the order form waits), or ready (the hold is lifted).
    const heldNow = name === "create_quote" && r.outcome === "ok" && isHeldQuoteResult(r.result);
    if (heldNow) {
      this.heldQuote = { id: typeof r.result.quote_id === "string" ? r.result.quote_id : null };
      this.log.info(voiceLine(this.sessionId, "tool create_quote held for approval: totals withheld from the model"));
    } else if (name === "create_quote" && r.outcome === "ok" && r.result.status === "ready") {
      this.heldQuote = null;
    }
    if (smallerGate === "no") this.log.info(voiceLine(this.sessionId, "tool create_quote held: a smaller quote the buyer did not ask for"));
    if (formGate === "no") this.log.info(voiceLine(this.sessionId, "tool send_order_form held: the buyer has not agreed to it yet"));
    if (kept.length) {
      this.log.info(voiceLine(this.sessionId, `tool update_deal_state: ${kept.length} lowered number(s) kept as the buyer said`));
      r.result = { ...r.result, kept_as_buyer_said: kept, kept_message: keptMessage(kept) };
    }
    if (removeGate === "no") this.log.info(voiceLine(this.sessionId, "tool create_quote held: removes a line the buyer did not ask to remove"));
    // One line per tool call: its name, outcome and time (never its arguments or result).
    this.log.info(voiceLine(this.sessionId, `tool ${clip(name, 40)} ${r.outcome} ${Math.round(this.clock.now() - t0)}ms`));
    let forModel = this.profile ? await this.guardedToolResult(turn, name, args, r, formGate === "no") : await this.currentToolResult(turn, name, r);
    // Held for approval: the held state first, in the call's language, and no figure of the quote (any engine).
    const sayIn = this.spokenLanguage !== "en" ? this.sayIn() : null;
    const noTotals = name === "check_fit";
    if (noTotals) forModel = fitForCall(forModel);
    if (heldNow) forModel = heldQuoteForModel(forModel, this.spokenLanguage === "he" ? "he" : "en", sayIn);
    if (quoteHeld) {
      forModel = {
        ok: false, rule: HELD_FORM_RULE, ...(typeof forModel.scheduling === "string" ? { scheduling: forModel.scheduling } : {}),
        message: sayIn ? `${HELD_FORM_MESSAGE} ${sayIn}` : HELD_FORM_MESSAGE,
      };
    }
    // The run-once guard answers a duplicate of this call with this result.
    const recent = this.recentCalls.find((c) => c.id === callId);
    if (recent) recent.result = forModel;
    // A call the model cancelled (the buyer cut in): its result would start an answer to a question no longer asked.
    if (this.cancelledCalls.has(callId)) {
      this.log.info(voiceLine(this.sessionId, `tool ${clip(name, 40)} result not sent: the model cancelled the call`));
    } else {
      if (this.conn) {
        const at = this.traceCallAt.get(callId);
        this.trace(`tool result sent name=${clip(name, 40)} id=${clip(callId, 200).slice(-8)} took=${at === undefined ? "?" : `${Math.round(this.clock.now() - at)}ms`} chars=${JSON.stringify(forModel)?.length ?? 0}${typeof forModel.scheduling === "string" ? ` sched=${clip(forModel.scheduling, 20)}` : ""}${heldNow || quoteHeld ? " held=yes" : ""}${noTotals ? " nototals=yes" : ""}`);
        // The model's audio from here on is its next response (Gemini continues by itself after a result).
        if (this.traceResp && !this.traceResp.closedBy) this.traceResp.closedBy = "tool-result";
      }
      this.conn?.sendToolResult(callId, name, forModel);
    }
    this.traceCallAt.delete(callId);
    turn.awaitingContinuation = true;
    this.send({ t: "tool", id: callId, name, label, status: r.outcome });
  }

  /** Current: a tool's result as the model gets it on a call, and what the tool's outcome does to the call. */
  private async currentToolResult(turn: AgentTurn, name: string, r: ToolResult): Promise<Record<string, unknown>> {
    let forModel: Record<string, unknown> = r.result;
    if (name === "create_quote" && r.outcome !== "ok" && Array.isArray(r.result.missing) && r.result.missing.length) {
      // No quote: no total may be said (23 Nov 2026: a total was spoken after this refusal, on an assumption).
      forModel = { ...r.result, message: refusedQuoteMessage(r.result.missing.map(String)) };
    }
    if (name === "send_order_form" && r.outcome !== "ok") {
      // Never a success line for a form that was not sent (the 22 Nov 2026 call said "the link is in the chat").
      forModel = { ...r.result, message: formNotSentMessage(r.result) };
    }
    // A refusal after the card was posted (N1: the named time could not be booked): the card is in the chat, nothing is booked.
    const cardPosted = this.bookingCardPosted(name, r);
    if (name === "request_callback" && r.outcome !== "ok") {
      const why = typeof r.result.rule === "string" ? r.result.rule : typeof r.result.error === "string" ? r.result.error : "it could not be sent";
      forModel = cardPosted
        ? {
          ...r.result,
          message: `Nothing was booked (${why}). Do not say a call is booked. The booking card is in the chat: say in one short sentence that they can pick a time there (never read the link aloud). Then ask if there is anything else you can help with: this call goes on.`,
        }
        : {
          // Never a booking link that was not sent, and never a booking that was not made.
          ...r.result,
          message: `The booking link was NOT sent and nothing was booked (${why}). Do not say there is a link in the chat or that a call is booked or set up. ${typeof r.result.message === "string" ? `${r.result.message} ` : ""}Tell the buyer in one short sentence what happens next.`,
        };
    }
    await this.announceBookingCard(name, r);
    if (r.outcome === "ok") {
      if (name === "create_quote" && typeof r.result.quote_message_id === "string") this.send({ t: "message", messageId: r.result.quote_message_id });
      if (name === "create_quote") {
        // The model names a quote by its number only: internal ids out, and how to send the form for this one.
        const { quote_id: _qid, quote_message_id: _mid, ...rest } = r.result;
        void _qid;
        void _mid;
        // On a call the agent walks the buyer through the quote: what they need and what each part costs, from the
        // quote's own lines (never invented), then the totals once.
        const lines = r.result.status === "ready" ? await this.quoteLinesForCall(r.result.quote_id, r.result.quote_version).catch(() => []) : [];
        forModel = {
          ...rest, ...(lines.length ? { lines_for_call: lines } : {}),
          ...(typeof r.result.quote === "string" ? {
            message: `${String(r.result.message ?? "")} This quote is ${r.result.quote}.${lines.length ? ` ${QUOTE_WALKTHROUGH}` : ""} ${OBJECTION_FIRST} Offer the order form and wait for the buyer's yes; when they agree (or if they already asked for it), call send_order_form with quote "${String(r.result.quote).replace(/\s*v\d+$/i, "")}". Never send it unasked.`.trim(),
          } : {}),
        };
      }
      if (name === "record_opt_out" && OPT_OUT_REPLY[this.spokenLanguage]) {
        // The reply in the language the call speaks now (the tool gives the conversation's).
        const reply = OPT_OUT_REPLY[this.spokenLanguage];
        forModel = { ...r.result, reply, message: `The buyer is opted out and will not be contacted again. Say exactly this and nothing else: ${reply}` };
      }
      if (name === "send_order_form" && typeof r.result.link === "string") {
        await this.putOrderFormInChat(r.result.link);
        forModel = { ...r.result, link: "shown in the chat", message: ORDER_FORM_IN_CHAT_MESSAGE };
      }
      if (name === "update_deal_state" && typeof r.result.stage === "string") {
        const key = stageKey(r.result.stage);
        if (isBookkeepingOnly(r.result) && key === this.stageDelivered) {
          // Nothing new from the buyer and the stage as the model last saw it: no "Do: …" to act on again. With
          // BLOCKING tools the model continues after every result; a full stage block here made it speak again
          // (a second question, or narration of the room: "no speech detected").
          // Data only (no "Do:"): what is still missing for a quote, so a fact the model forgot to save is not lost.
          const missing = Array.isArray(r.result.still_needed_before_quote) ? r.result.still_needed_before_quote.map(String) : [];
          forModel = {
            ok: true, saved: [], ...(Array.isArray(r.result.recorded_as_asked) ? { recorded_as_asked: r.result.recorded_as_asked } : {}),
            still_needed_before_quote: missing,
            note: `${missing.length ? `${notSavedYet(missing)} ` : ""}${OBJECTION_FIRST}`,
          };
          this.log.info(voiceLine(this.sessionId, "tools: bookkeeping result shortened"));
        } else {
          forModel = { ...r.result, stage: voiceStageText(r.result.stage) };
          this.stageDelivered = key;
        }
      }
      forModel = this.afterCallTool(turn, name, r, forModel);
    }
    // Every result message in call wording ("confirm it here" → "by message", …).
    if (typeof forModel.message === "string") forModel = { ...forModel, message: voiceToolResultMessage(forModel.message) };
    // The booking card only (no time named): a fixed Hebrew example of what to say, for a Hebrew call.
    if (name === "request_callback" && r.outcome === "ok" && this.spokenLanguage === "he" && /^Link sent in the chat\./.test(String(r.result.message ?? ""))) {
      forModel = { ...forModel, message: `${String(forModel.message ?? "")} For example, in Hebrew: "${BOOKING_CARD_LINE_HE}"` };
    }
    // A call in another language than English: guidance the result already gives (written in English) names the
    // language to answer in. A result with no guidance gets none: a silent tool (update_deal_state) stays silent.
    if (this.spokenLanguage !== "en" && name !== "record_opt_out" && typeof forModel.message === "string") {
      forModel = { ...forModel, message: `${typeof forModel.message === "string" ? `${forModel.message} ` : ""}${this.sayIn()}` };
    }
    return forModel;
  }

  /**
   * "Classic + guards" (a profile): the result as Classic gave it (lib/voice-classic/engine.ts runToolForModel), with
   * only the guards' parts added: the guards' refusals in Current's words (the order form not agreed, a refused
   * quote), the kept number (already on the result), the hand-off that keeps the call (Current), and the quote's
   * spoken summary with its amounts in words.
   */
  private async guardedToolResult(turn: AgentTurn, name: string, args: unknown, r: ToolResult, formHeld: boolean): Promise<Record<string, unknown>> {
    const profile = this.profile!;
    let forModel: Record<string, unknown> = r.result;
    // K4: no quote, no total.
    if (name === "create_quote" && r.outcome !== "ok" && Array.isArray(r.result.missing) && r.result.missing.length) {
      forModel = { ...r.result, message: refusedQuoteMessage(r.result.missing.map(String)) };
    }
    // K1: the order form held by the guard, in Current's words.
    if (formHeld) forModel = { ...r.result, message: formNotSentMessage(r.result) };
    await this.announceBookingCard(name, r);
    if (r.outcome === "ok") {
      if (name === "create_quote" && typeof r.result.quote_message_id === "string") this.send({ t: "message", messageId: r.result.quote_message_id });
      if (name === "create_quote" && r.result.status === "ready" && typeof r.result.quote_id === "string" && typeof r.result.quote_version === "number" && this.loaded) {
        // K5/K6: the summary to say, every amount in words (the call's language: Hebrew when the buyer speaks it).
        const requested = Array.isArray((args as { lines?: unknown })?.lines)
          ? ((args as { lines: unknown[] }).lines).map((l) => String((l as { sku?: unknown })?.sku ?? "")).filter(Boolean)
          : [];
        const language = this.spokenLanguage === "he" ? "he" : "en";
        const summary = await profile.quoteSummary(this.db, { account: this.loaded.account, quoteId: r.result.quote_id, version: r.result.quote_version, requested, language })
          .catch(() => null);
        if (summary) forModel = { ...forModel, say_this: summary, message: profile.quoteMessage(String(r.result.quote ?? "")) };
      }
      if (name === "send_order_form" && typeof r.result.link === "string") {
        await this.putOrderFormInChat(r.result.link);
        forModel = { ...r.result, link: "shown in the chat", message: ORDER_FORM_IN_CHAT_MESSAGE };
      }
      // T1: the full update_deal_state result, the stage in Classic's call wording.
      if (name === "update_deal_state" && typeof r.result.stage === "string") forModel = { ...forModel, stage: profile.stageText(r.result.stage) };
      forModel = this.afterCallTool(turn, name, r, forModel);
    }
    if (typeof forModel.message === "string") forModel = { ...forModel, message: profile.resultMessage(forModel.message) };
    return profile.shapeResult ? profile.shapeResult(name, forModel, { family: schemaFamilyOf(this.model.modelId) }) : forModel;
  }

  /** request_callback's booking card: the browser shows it during the call (an ok result, or a refusal after the card). */
  private bookingCardPosted(name: string, r: ToolResult): boolean {
    return name === "request_callback" && r.outcome !== "ok" && typeof r.result.rule === "string" && r.result.rule.startsWith("Not booked");
  }

  private async announceBookingCard(name: string, r: ToolResult) {
    if (name === "request_callback" && (r.outcome === "ok" || this.bookingCardPosted(name, r)) && this.loaded) {
      // The booking card is in the chat now ("Call booked" when the agent booked the named time):
      // the browser refetches the thread and shows it during the call.
      const offer = await latestBookingOffer(this.db, this.loaded.account.id, this.loaded.conv.leadId).catch(() => null);
      if (offer?.conversationId === this.loaded.conv.id) this.send({ t: "message", messageId: offer.messageId });
    }
  }

  /** The order form's link goes into the chat; the buyer can fill it in now while the agent stays on the line. */
  private async putOrderFormInChat(link: string) {
    const id = await this.storeAppMessage(`Your order form: ${link}`);
    this.send({ t: "message", messageId: id });
    // Standby covers the quiet while they fill it in, with no idle end.
    this.noteOrderFormOpen();
  }

  /** What an ok opt-out, hand-off or end_call does to the call (both engines' model sides), and its result. */
  private afterCallTool(turn: AgentTurn, name: string, r: ToolResult, forModel: Record<string, unknown>): Record<string, unknown> {
    // A call request or a hand-off does not end this call (only an opt-out, end_call, or the buyer does).
    if (name === "record_opt_out") this.afterOptOut();
    if (name === "hand_off_to_human") {
      // Owner decision (22 Nov 2026): the team gets back to the buyer, and the call goes on until the buyer ends
      // it (or says goodbye and the agent calls end_call). The conversation is held by the team from now on.
      this.handedOffHere = true;
      return { ...r.result, message: HANDOFF_RESULT_MESSAGE };
    }
    if (name === "end_call") {
      // Goodbye already said before the tool: a short wait for anything the model adds; else the usual grace for the goodbye.
      // The browser plays out the audio it has before it closes (voice-client onEnded).
      this.endSoon("agent_closed", turn.text.trim() ? Math.min(END_AFTER_GOODBYE_MS, this.limits.endGraceMs) : this.limits.endGraceMs);
      return { ...r.result, message: END_CALL_RESULT_MESSAGE };
    }
    return forModel;
  }

  /**
   * Late transcription of the response that just ended (Gemini): the whole text of that response so far. It updates
   * that response's own row (the same utterance, never a merge of two), or becomes its row when the response stored
   * none (it had only tool calls when it ended): every spoken response gets a row.
   */
  private async storeLateTranscript(text: string) {
    if (this.ended || !this.loaded || this.agentTurn || this.lateTarget === null) return;
    const last = this.lastLine;
    if (this.lateTarget !== "none" && last && last.messageId === this.lateTarget) {
      if (text === last.raw) return;
      const body = last.cut ? cutLine(text) : text;
      const { account, conv } = this.loaded;
      await this.db.update(messages).set({ body, language: lineLanguage(body, conv.language) }).where(and(eq(messages.id, last.messageId), eq(messages.accountId, account.id)));
      this.lastLine = { ...last, raw: text };
      const i = this.lines.findLastIndex((l) => l.role === "agent");
      if (i >= 0) this.lines[i] = { role: "agent", text: body };
      this.send({ t: "transcript", id: last.turnId, role: "agent", text: body, final: true, atMs: last.startMs });
      return;
    }
    // The response ended with no words stored: its words become its row now.
    const turn = this.ensureAgentTurn();
    turn.text = text;
    turn.finalText = true;
    await this.finalizeAgentTurn("done");
    this.lateTarget = this.lastLine?.turnId === turn.id ? this.lastLine.messageId : null;
  }

  private async storeAppMessage(body: string): Promise<string> {
    const { conv, account } = this.loaded!;
    const id = randomUUID();
    await this.db.insert(messages).values({
      id, accountId: account.id, conversationId: conv.id, actor: "agent", body, language: conv.language, createdAt: await this.stamp(),
    });
    return id;
  }

  private async handleTurnDone(interrupted = false) {
    if (this.ended) return;
    const turn = this.agentTurn;
    // The model goes on after a tool result (after a hand-off or opt-out too: the grace timer bounds it).
    if (turn && turn.awaitingContinuation && !interrupted) return;
    await this.finalizeAgentTurn(interrupted ? "interrupted" : "done");
    // Late transcription of this response (Gemini) goes to its row: the row it stored, or a new one when none.
    this.lateTarget = turn ? (this.lastLine && this.lastLine.turnId === turn.id ? this.lastLine.messageId : "none") : null;
    // Text output: the reply's speech may still be playing: the rest waits for its end (afterSpeech).
    if (this.player?.active) {
      this.openerDone = true;
      return;
    }
    this.agentSpeaking = false;
    this.openerDone = true;
    if (this.pendingEnd) {
      void this.stop(this.pendingEnd);
      return;
    }
    this.setState("listening");
    // The time-limit announcement held while the agent spoke goes now.
    if (this.warnHeld) this.warnLimit();
    this.startQuiet();
  }

  /**
   * Stores the agent's turn: ONE message with the text actually spoken, and its tool calls, like
   * lib/agent/turn.ts. A turn the buyer cut short ends with "…". One stored message per spoken agent turn, in
   * order: a line said again after a cut is a row of its own (the buyer heard both).
   */
  private async finalizeAgentTurn(reason: FinalizeReason = "done") {
    const turn = this.agentTurn;
    if (!turn || !this.loaded) return;
    this.agentTurn = null;
    // What the agent actually said (card numbers masked): the owner reviews calls from this transcript.
    const raw = maskCardNumbers(turn.text.trim()).text;
    // Cut: the model says so, or the turn ends under the agent (a buyer turn, the end of the call) before its final
    // transcript, or after a barge-in. A turn the model completes normally ("done") is whole.
    const cut = !!raw && (reason === "interrupted" || (reason !== "done" && (turn.interrupted || !turn.finalText)));
    const body = cut ? cutLine(raw) : raw;
    this.cutText = cut && reason === "buyer" ? raw : null;
    if (!body && !turn.tools.length) return;
    // Tools with nothing said (the buyer cut in before the first word): no empty line in the thread.
    // The calls go with the agent's next line in this call, or with its last one when the call ends.
    if (!raw && reason !== "stop") {
      this.carriedTools.push(...turn.tools);
      return;
    }
    if (this.carriedTools.length) {
      turn.tools = [...this.carriedTools, ...turn.tools];
      this.carriedTools = [];
    }
    const { conv, account, version, lead } = this.loaded;
    const last = this.lastLine;
    if (!raw && last) {
      await this.db.insert(toolCalls).values(turn.tools.map((p, i) => ({
        accountId: account.id, conversationId: conv.id, messageId: last.messageId, sequence: last.tools + i + 1, name: p.name,
        input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>,
        result: p.r.result, outcome: p.r.outcome, rule: p.r.rule ?? null,
      })));
      this.lastLine = { ...last, tools: last.tools + turn.tools.length };
      return;
    }
    const toolRows = (messageId: string, from: number) => turn.tools.map((p, i) => ({
      accountId: account.id, conversationId: conv.id, messageId, sequence: from + i + 1, name: p.name,
      input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>,
      result: p.r.result, outcome: p.r.outcome, rule: p.r.rule ?? null,
    }));
    const messageId = randomUUID();
    const now = await this.stamp();
    await atomic(this.db, (q) => [
      q.insert(messages).values({
        id: messageId, accountId: account.id, conversationId: conv.id, actor: "agent", body, language: lineLanguage(body, conv.language), agentVersionId: version.id,
        voiceSessionId: this.sessionId, spokenAtMs: turn.startMs, answerMs: turn.answerMs, createdAt: now,
      }),
      ...(turn.tools.length ? [q.insert(toolCalls).values(toolRows(messageId, 0))] : []),
      q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, account.id))),
      // A new lead becomes agent-handled, only while the conversation is still open.
      q.update(leads).set({ status: "agent_handling", lastActivityAt: now }).where(and(
        eq(leads.id, lead.id), eq(leads.accountId, account.id), eq(leads.status, "new"),
        exists(q.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conv.id), eq(conversations.status, "open")))),
      )),
    ]);
    this.agentMessages++;
    this.firstLineStored = true;
    if (raw) this.lastLine = { messageId, turnId: turn.id, raw, cut, tools: turn.tools.length, startMs: turn.startMs };
    // Text output: the reply handed to the speaker has its row now (its first audio and a cut update it).
    if (this.speaker) for (const r of this.rtReplies.values()) if (r.turn === turn) r.messageId = messageId;
    if (body) this.lines.push({ role: "agent", text: body });
    this.send({ t: "transcript", id: turn.id, role: "agent", text: body, final: true, atMs: turn.startMs });
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  /**
   * The provider sent an error before the call's first audio on this connection: its session setup was refused.
   * ONE retry with the smallest config that still carries the instructions and tools (`safe`); a second refusal
   * ends the call (model_rejected_session, with the provider's error in endDetail).
   */
  private async afterSetupRejected(why: string, gen: number) {
    if (this.ended || this.reconnecting || gen !== this.gen) return;
    // Queued: the refused connection is the current one now (its setup may race the error event).
    const sent = this.conn?.sessionFields?.join(",") ?? "?";
    (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `provider rejected the session setup: ${why} sent=${sent}`));
    if (this.earlyRetryUsed) {
      this.fail("error", "model_closed_early", "model_rejected_session");
      return;
    }
    await this.reconnect(true);
  }

  /**
   * The provider is going away or dropped: ONE fresh connection within reconnectMs, with a recap; else the call ends.
   * `early`: the model closed this session before it said anything. That is never a normal end: ONE retry with
   * only the session fields proven on this model family; if that fails too, the call ends with model_closed_early.
   * A call whose opening line was never spoken starts again with the opener.
   */
  private async reconnect(early = false) {
    if (this.ended || this.reconnecting || !this.loaded) return;
    if (early) {
      if (this.earlyRetryUsed) {
        this.fail("error", "model_closed_early", "model_closed_early");
        return;
      }
      this.earlyRetryUsed = true;
      this.safeConfig = true;
    } else {
      if (this.reconnectUsed) {
        this.fail("connection_lost", "connection_lost", "model_closed");
        return;
      }
      this.reconnectUsed = true;
    }
    this.reconnecting = true;
    this.setState("reconnecting");
    this.closeModel();
    await this.finalizeAgentTurn("stop");
    // Text output: a reply already handed to our speaker goes on playing (the model is not needed for it).
    if (!this.player?.active) this.agentSpeaking = false;
    const fresh = early && !this.openerDone && !this.lastLine;
    // Our pinned default voice has never been proven on every account: the retry leaves it out (the model's own default).
    const droppedVoice = early && !resolveVoiceSettings(this.loaded.version.voiceSettings).voice && schemaFamilyOf(this.model.modelId) !== "gemini" && !!callVoice(null, this.model.modelId);
    const what = early ? (droppedVoice ? "retry without pinned default voice" : "retry after early close") : "reconnect";
    const opened = await this.openModel({ resumed: !fresh }, this.limits.reconnectMs, what);
    if (!opened || this.ended) {
      opened?.conn.close();
      this.reconnecting = false;
      if (!this.ended) early ? this.fail("error", "model_closed_early", "model_closed_early") : this.fail("connection_lost", "connection_lost", "model_closed");
      return;
    }
    this.modelUp(opened.conn);
    this.reconnecting = false;
    this.setState("listening");
    // The snapshot shows the voice now in effect ("model default" after the pinned one was dropped).
    if (droppedVoice) await this.db.update(voiceSessions).set({ settings: this.settingsSnapshot() }).where(eq(voiceSessions.id, this.sessionId));
    // The opening line was never heard: the retried session says it.
    if (fresh) {
      // The retried session says the opening now; a first one still waiting for the browser is not sent as well.
      this.pendingOpener = null;
      this.clearTimer("ready");
      this.noteSent("opener (retry)", true);
      opened.conn.requestResponse(opened.openerPrompt);
    }
    else this.startQuiet();
  }

  // -------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------

  /**
   * The call's final row: status, end time, figures and endDetail, written as soon as the end starts for a dropped
   * browser (lib/voice/socket.ts keeps the function alive for it). A write that fails, or hangs past
   * FINAL_WRITE_TIMEOUT_MS, is tried once more; if that fails too the row stays live and the stale close ends it at
   * its last heartbeat (lib/voice/service.ts). Status-guarded: never over a row already ended (by the stale close),
   * except a row ended from elsewhere ("End that call"), which gets the call's real figures. Never throws.
   */
  private async writeFinalRow(reason: VoiceEndReason): Promise<FinalRow> {
    const figures = this.callFigures();
    const { connected, durationSec, activeSec, costMicros } = figures;
    let { usage } = figures;
    // How it ended, technically: stored with the figures so a failed call can be read without logs.
    const endDetail: VoiceEndDetail = {
      by: this.endBy ?? BY_REASON[reason] ?? "error",
      ...(this.clientClose ? { clientClose: this.clientClose } : {}),
      ...(this.modelClose ? { modelClose: this.modelClose } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
    usage = usage ? { ...usage, endDetail } : ({ ...EMPTY_USAGE, endDetail } as VoiceCallUsageRecord);
    this.log.info(voiceLine(this.sessionId, `ended reason=${reason} code=${this.errorCode ?? "-"} durationSec=${durationSec} activeSec=${activeSec} by=${endDetail.by}`
      + `${this.clientClose ? ` client=${this.clientClose.code ?? "-"}/"${this.clientClose.reason}"` : ""}${this.modelClose ? ` model=${this.modelClose.code ?? "-"}/"${this.modelClose.reason}"@${this.modelClose.msAfterConnect ?? "?"}ms` : ""}`
      + `${this.diagnostics.size ? ` diagnostics=${[...this.diagnostics].map(([k, n]) => `${k}:${n}`).join(",")}` : ""}${this.profile ? ` engine=${this.profile.engine}` : ""}`));
    const answerMsAvg = this.answerMsAvg();
    const rtu = (usage as { rtEleven?: RtElevenUsage }).rtEleven;
    if (rtu) {
      const ms = (v: number | null) => (v === null ? "-" : `${v}ms`);
      this.log.info(voiceLine(this.sessionId, `trace t=${this.offsetMs()} rt summary turns=${rtu.turns} median think=${ms(rtu.medianThinkMs)} speak=${ms(rtu.medianSpeakMs)} total=${ms(rtu.medianAnswerMs)} toolRounds=${rtu.medianToolRounds ?? "-"} dropped=${rtu.droppedTexts} bargeIns=${rtu.bargeIns} chars=${rtu.spokenChars} speakModel=${rtu.speakModel || "-"} costMicros=${costMicros} (realtime ${rtu.realtimeCostMicros} + speak ${rtu.speakCostMicros}${rtu.speakRateKnown ? "" : ", speech rate unknown"})`));
    }
    const set = {
      status: "ended" as const, endedAt: new Date(this.clock.now()), endReason: reason, errorCode: this.errorCode, durationSec,
      usage, costMicros, answerMsAvg, providerSessionId: this.providerSessionId,
    };
    // Ended from elsewhere ("End that call", not a stale close): the call's real figures replace the estimate.
    const where = this.endedExternally
      ? and(eq(voiceSessions.id, this.sessionId), sql`coalesce(${voiceSessions.usage}->'endDetail'->>'by', '') <> 'relay_gone'`)
      : and(eq(voiceSessions.id, this.sessionId), ne(voiceSessions.status, "ended"));
    let ended = false;
    for (let attempt = 1; attempt <= 2 && !ended; attempt++) {
      try {
        const rows = await this.withTimeout(this.db.update(voiceSessions).set(set).where(where).returning({ id: voiceSessions.id }), FINAL_WRITE_TIMEOUT_MS);
        ended = rows.length > 0;
        if (!ended) {
          this.log.warn(voiceLine(this.sessionId, "final row write: the row was already ended (kept as it is)"));
          break;
        }
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `final row write failed (attempt ${attempt} of 2): ${errorSummary(e)}${attempt === 2 ? "; left to the stale close" : ""}`));
      }
    }
    return { connected, ended, durationSec, costMicros, answerMsAvg };
  }

  /** Rejects after `ms` (the call's clock) if `p` has not settled: a hung query does not hold the end. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.clock.setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      p.then((v) => { this.clock.clearTimeout(t); resolve(v); }, (e) => { this.clock.clearTimeout(t); reject(e); });
    });
  }

  /**
   * The end of the call, after the row: the last turn (and tool calls still waiting for a line), the end line in
   * the thread, and `ended` to the browser. `row`: the final row write when it started first (a dropped browser).
   */
  private async finish(reason: VoiceEndReason, rowFirst: Promise<FinalRow> | null) {
    const storeLast = async () => {
      try {
        await this.finalizeAgentTurn("stop");
        // Tool calls still waiting for a line go with the call's last line.
        if (this.carriedTools.length) {
          this.ensureAgentTurn();
          await this.finalizeAgentTurn("stop");
        }
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `could not store the last turn: ${errorSummary(e)}`));
      }
    };
    let row: FinalRow;
    if (rowFirst) {
      row = await rowFirst;
      await storeLast();
    } else {
      await storeLast();
      row = await this.writeFinalRow(reason);
    }
    const { durationSec, costMicros, answerMsAvg } = row;
    // The end line only when this write ended the row: a row the stale close ended has its own line, and one it
    // could not end is left to the stale close (which adds it).
    if (row.connected && row.ended && this.loaded) {
      // Like the other operational notes in a thread (system messages): when and how long.
      const { conv, account } = this.loaded;
      try {
        await this.db.insert(messages).values({
          accountId: account.id, conversationId: conv.id, actor: "system", body: CALL_ENDED_TEXT(durationSec), language: "en", createdAt: await this.stamp(),
        });
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `could not store the end line: ${errorSummary(e)}`));
      }
    }
    this.send({ t: "ended", reason, durationSec, costMicros, answerMsAvg });
    this.state = null;
    this.setState("ended");
    await this.finishRecording();
  }

  /**
   * The recording's last chunk (up to the end of the call), then its state on the row: saved when any chunk is
   * stored, failed when none could be. Bounded, never throws; a chunk still being written when the function stops
   * is simply missing (the chunks before it play).
   */
  private async finishRecording() {
    const rec = this.recorder;
    if (!rec) return;
    try {
      const p = await this.withTimeout(rec.finish(this.endedAtMs ?? this.offsetMs()), RECORDING_FINISH_TIMEOUT_MS);
      await this.db.update(voiceSessions).set({ recordingState: p.chunks > 0 ? "saved" : "failed", recordingChunks: p.chunks, recordingBytes: p.bytes, recordingSec: p.sec })
        .where(eq(voiceSessions.id, this.sessionId));
      this.log.info(voiceLine(this.sessionId, `recording ${p.chunks > 0 ? "saved" : "failed"}: chunks=${p.chunks} bytes=${p.bytes} sec=${p.sec}${p.failed ? ` failed=${p.failed}` : ""}`));
    } catch (e) {
      (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `recording not finished: ${errorSummary(e)}`));
    }
  }
}
