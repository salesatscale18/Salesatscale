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
import { and, asc, desc, eq, exists, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, leads, messages, quotes, sellerAccounts, toolCalls, voiceSessions,
  type AgentVersion, type Conversation, type Lead, type SellerAccount, type VoiceEndBy, type VoiceEndDetail, type VoiceEndReason, type VoiceSession,
} from "@/db/schema";
import { readDealState } from "@/lib/agent/service";
import { latestBookingOffer } from "@/lib/team-calls/service";
import { voiceCallEndedLine } from "@/lib/agent/thread-markers";
import { runTool, type ToolContext, type ToolResult, type TurnMemo } from "@/lib/agent/tools";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { voiceStageText, voiceToolResultMessage } from "@/lib/agent/core/voice";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { RealtimeUsageAccumulator, voiceCallCost, type VoiceCallTimes, type VoiceCallUsageRecord } from "@/lib/ai/models";
import type { ServerMessage, VoiceErrorCode, VoiceState } from "./protocol";
import { systemClock, type Clock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig, type TimerHandle } from "./realtime";
import { isSpokenOptOut, maskCardNumbers, maskPartialDigits } from "./safety";
import { languageNameEn, loadVoiceInstructions, RECAP_LINES, type TranscriptLine } from "./instructions";
import { callVoice, isProvenVoiceModel, maxCallSeconds, resolveVoiceSettings, turnTakingFor, versionModelId } from "./settings";
import { realtimeTools, schemaFamilyOf, toolLabel, VOICE_TOOL_NAMES } from "./tool-schema";
import { CALL_RULES } from "./call-rules";
import { EnergyVad, PcmRing, type VadOptions } from "./vad";
import { pcmDurationMs } from "./protocol";
import { FormContextNotes, orderFormStatus } from "./form-context";
import { cleanTranscript } from "./transcript-clean";
import { clip, consoleVoiceLog, errorSummary, voiceLine, type VoiceLog } from "./log";
import { CallRecorder, recordingPrefix, recordingStoreFor, type RecordingStore } from "./recording";
import { recordingInstruction, recordingNoticeText, resolveRecordingSettings, withRecordingNotice } from "./recording-settings";

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
};

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
};

export type { VoiceEndBy, VoiceEndDetail };

/** The final row write: whether it ended the row, and the figures the browser is told. */
type FinalRow = { connected: boolean; ended: boolean; durationSec: number; costMicros: number; answerMsAvg: number | null };
/** A final row write that has not answered in this long is tried again (a hung query must not hold the end). */
export const FINAL_WRITE_TIMEOUT_MS = 8_000;
/** The recording's last chunk and its row update get at most this long after the call ended. */
export const RECORDING_FINISH_TIMEOUT_MS = 20_000;

const BY_REASON: Record<VoiceEndReason, VoiceEndBy> = {
  user_hangup: "client_end", agent_closed: "tool", limit: "limit", silence: "idle", idle: "idle", opt_out: "tool", handoff: "tool",
  take_over: "take_over", connection_lost: "client_closed", budget: "gate", error: "error",
};

type ToolRun = { name: string; input: unknown; r: ToolResult };

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

/** The last agent line this call stored, to merge a resumed line into it or drop a repeated cut copy. */
type StoredLine = { messageId: string; turnId: string; raw: string; cut: boolean; tools: number; startMs: number; cutAtMs?: number };

/**
 * A cut line followed, within this long and with no buyer line between, by a new agent line: the model was cut by
 * no words (noise, the echo of its own voice) and said its answer again, maybe in another language (the
 * 22 Nov 2026 call: a Hebrew answer cut, then the same answer in English 2 s later). One line is kept: the new one.
 */
export const FALSE_CUT_REDO_MS = 8_000;

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

/** Text compared for "the same line": lower case, words only. */
export const normLine = (s: string) => s.toLowerCase().replace(/…/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
/** `longer` starts with `shorter` (normalised, whole words), and `shorter` has at least two words. */
export function startsWithLine(longer: string, shorter: string): boolean {
  const a = normLine(longer);
  const b = normLine(shorter);
  return b.split(" ").length >= 2 && (a === b || a.startsWith(`${b} `));
}
/**
 * `longer` goes on from the cut line `cut`: like startsWithLine, and the cut line's last word may be the start of a
 * word (the transcript stops mid-word: "It is about 40 doll" → "It is about 40 dollars per seat").
 */
export function continuesCutLine(longer: string, cut: string): boolean {
  if (startsWithLine(longer, cut)) return true;
  const a = normLine(longer).split(" ");
  const b = normLine(cut).split(" ");
  if (b.length < 2 || a.length < b.length) return false;
  const last = b.length - 1;
  return b.slice(0, last).every((w, i) => w === a[i]) && a[last].startsWith(b[last]) && a[last] !== b[last];
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
  /** The call's recording (null: not recorded). */
  private recorder: CallRecorder | null = null;
  /** The call clock (ms since connect) when the call ended: the recording's end. */
  private endedAtMs: number | null = null;
  /** A recorded call's instruction about the recording (recording-settings recordingInstruction); null when not recorded. */
  private recordingNote: string | null = null;
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
  /** A buyer line was stored since the last agent line (a cut line then has its answer, not a re-say). */
  private buyerSinceLastLine = false;
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
  private timers: Record<"warn" | "limit" | "quiet" | "idle" | "falseWake" | "grace" | "stats" | "reconnect" | "heartbeat", TimerHandle | null> = {
    warn: null, limit: null, quiet: null, idle: null, falseWake: null, grace: null, stats: null, reconnect: null, heartbeat: null,
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
        this.buyerActivity();
        void this.enqueue(() => this.handleBuyerFinal(msg.text, true));
        return;
      case "end":
        void this.stop("user_hangup");
        return;
      case "ping":
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
      this.formNote = note;
      if (!this.notesMidCall()) return;
      // Off the line (standby, a wake or a reconnect under way): nothing now, the next connection's instructions carry it.
      if (this.conn && !this.reconnecting && !this.waking && this.standbySince === null) this.conn.sendNote?.(note);
    });
    this.formNotes.push({ step: msg.step, event: msg.event });
  }

  onClientAudio(bytes: Uint8Array): void {
    if (this.ended || this.muted) return;
    // The recording's left channel: the mic as received (a muted mic sends nothing here: silence).
    if (this.callStart !== null) this.recorder?.buyer(bytes, this.offsetMs());
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
    this.activeSince = this.clock.now();
    this.usageAcc.newSession();
  }

  /** Cost so far, from the latest usage snapshot and the model-connected time (0 for the scripted model). */
  private costSoFar(): number {
    if (this.model.mode === "scripted" || this.callStart === null) return 0;
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
    this.agentMessages = (await this.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "agent")))).length;

    const ctx = await loadVoiceInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) });
    this.spokenLanguage = ctx.language || "en";
    this.latinLanguage = NON_LATIN.test(this.spokenLanguage) ? "en" : this.spokenLanguage;
    // Recording is decided before the model connects: a recorded call's instructions say how to answer about it.
    const recording = await this.startRecording(account);
    if (recording.on) this.recordingNote = recordingInstruction();
    const gen = ++this.gen;
    let conn: RealtimeConnection;
    const t0 = this.clock.now();
    try {
      conn = await this.model.connect(this.sessionConfig(ctx.instructions, ctx), (e) => this.onModelEvent(e, gen));
    } catch (e) {
      this.lastError = clip(e instanceof Error ? e.message : e);
      this.log.warn(voiceLine(this.sessionId, `model connect failed after ${Math.round(this.clock.now() - t0)}ms: ${this.lastError}`));
      return this.fail("error", "model_unavailable");
    }
    this.log.info(voiceLine(this.sessionId, `model connected in ${Math.round(this.clock.now() - t0)}ms (${this.model.modelId}${this.model.mode === "live" && !isProvenVoiceModel(this.model.modelId) ? ", not tried live before" : ""})`));
    if (this.ended || gen !== this.gen) {
      conn.close();
      return;
    }
    this.modelUp(conn);
    this.callStart = this.clock.now();
    // The recording notice: the first sentence of the agent's first line, once per call, in the call's language.
    const noticeSaid = recording.on && recording.notice;
    const openerPrompt = noticeSaid
      ? withRecordingNotice(ctx.openerPrompt, recordingNoticeText(this.spokenLanguage), {
        position: ctx.continuing ? "pickup" : "opener",
        languageName: /^(en|he)\b/i.test(this.spokenLanguage) ? null : languageNameEn(this.spokenLanguage),
      })
      : ctx.openerPrompt;
    await this.db.update(voiceSessions)
      // A live call records the model it ran on; a scripted call keeps its version's model (the scripted model stands in).
      .set({
        status: "live", connectedAt: new Date(this.callStart), ...(this.model.mode === "live" ? { model: this.model.modelId } : {}), mode: this.model.mode, settings: this.settingsSnapshot(),
        recordingState: recording.on ? "recording" : "off", recordingRef: recording.prefix, recordingNoticeSaid: noticeSaid, recordingKeepDays: recording.keepDays,
        ...(recording.on ? { recordingChunks: 0, recordingBytes: 0, recordingSec: 0 } : {}),
      })
      .where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "pending")));
    // Limits: an announcement before the end, then the end.
    if (this.maxSec > this.limits.limitWarnSec) this.timer("warn", (this.maxSec - this.limits.limitWarnSec) * 1000, () => this.warnLimit());
    this.timer("limit", this.maxSec * 1000, () => void this.stop("limit", undefined, "limit"));
    this.statsLoop();
    this.heartbeatLoop();
    this.setState("listening");
    // The agent speaks first: the chat's opener, in its voice.
    // A call that continues a chat starts with the short disclosure line instead (lib/voice/instructions.ts).
    conn.requestResponse(openerPrompt);
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
    this.log.info(voiceLine(this.sessionId, `recording on: ${choice.reason}, kept ${settings.keepDays} days${notice ? ", line said" : saidBefore ? ", line said on an earlier call" : ", no line (switched off)"}`));
    return { on: true, notice, prefix, keepDays: settings.keepDays };
  }

  /**
   * The voice sent to the model: the seller's choice always; otherwise our pinned family default (Puck/alloy),
   * except after the early-close retry (which runs on proven fields only): from then on this call omits the
   * pinned default and the model uses its own default, as in the owner's working live calls.
   */
  private voiceInEffect(): string | null {
    const chosen = resolveVoiceSettings(this.loaded!.version.voiceSettings).voice;
    if (chosen) return chosen;
    return this.safeConfig ? null : callVoice(null, this.model.modelId);
  }

  /** The session's settings snapshot: the version's settings, the voice actually in effect ("model default" when none is sent) and the limit. */
  private settingsSnapshot() {
    const version = this.loaded!.version;
    const voice = this.voiceInEffect() ?? (callVoice(null, this.model.modelId) ? "model default" : undefined);
    // The model in the snapshot: the one this call ran on (live), or its version's (a scripted stand-in).
    return { ...version.voiceSettings, voice, maxCallSec: this.maxSec, model: this.model.mode === "live" ? this.model.modelId : versionModelId(version.voiceSettings) };
  }

  private sessionConfig(instructions: string, languages?: { language: string; expectedLanguages: string[] }): RealtimeSessionConfig {
    // A recorded call (and only one): how to answer if the buyer raises the recording; on every connection of the call.
    const cfg = this.fullSessionConfig(this.recordingNote ? `${instructions}\n\n${this.recordingNote}` : instructions, languages);
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
      instructions: this.formNote ? `${instructions}\n\n### The order form (a note from the app, not from the buyer)\n${this.formNote}` : instructions,
      tools: realtimeTools(family), toolBehavior: "blocking", pace: settings.pace,
      // The call starts in the conversation's language; the buyer may switch (never locked).
      language: languages?.language ?? (this.loaded!.conv.language || "en"),
      ...(languages ? { expectedLanguages: languages.expectedLanguages } : {}),
      // Always an explicit voice (the family default when none is chosen), on every connection: the same voice all call.
      ...(this.voiceInEffect() ? { voice: this.voiceInEffect()! } : {}),
      ...(tt ? { turnTaking: tt } : {}),
      scenario: this.loaded!.conv.scenario,
    };
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
    if (this.notesMidCall() && this.conn && !this.reconnecting && !this.waking && this.standbySince === null) {
      this.conn.sendNote?.(`(Note from the system, not from the buyer: the buyer now speaks ${languageNameEn(next)}. Speak ${languageNameEn(next)} from now on, also after an interruption or a pause, until the buyer speaks another language. Do not answer this note.)`);
    }
  }

  private warnLimit() {
    // On standby (or waking) nobody is listening: the limit just ends the call.
    if (!this.conn || this.reconnecting) return;
    this.send({ t: "notice", kind: "limit_soon" });
    this.conn?.requestResponse(`The call is close to its time limit. Tell the buyer the call is about to end and offer to continue in the chat. ${this.sayIn()}`);
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
        const said = cleanTranscript(e.text);
        if (!said) return;
        const fresh = !this.agentTurn || !this.agentTurn.text;
        const turn = this.ensureAgentTurn();
        turn.awaitingContinuation = false;
        turn.text = maskCardNumbers(said).text;
        if (e.final) turn.finalText = true;
        // The model resumes (or re-says) the line the buyer cut: the live transcript keeps it on one line.
        const last = this.lastLine;
        if (fresh && last?.cut && (continuesCutLine(turn.text, last.raw) || continuesCutLine(last.raw, turn.text) || this.redoesFalseCut(turn))) turn.id = last.turnId;
        if (!e.final) this.send({ t: "transcript", id: turn.id, role: "agent", text: maskPartialDigits(turn.text), final: false, atMs: turn.startMs });
        return;
      }
      case "buyer-transcript": {
        // A marker only (noise, silence) is not the buyer talking: no turn, no answer, no standby reset, no wake heard.
        const heard = cleanTranscript(e.text);
        if (!heard.trim()) {
          // The speech that opened a buyer turn was a marker only: that turn is over (else standby would wait for it).
          if (e.final) this.buyerTurn = null;
          return;
        }
        this.buyerActivity();
        this.markHeard();
        if (!this.buyerTurn) this.buyerTurn = { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
        if (e.final) {
          void this.enqueue(() => this.handleBuyerFinal(heard, false));
        } else {
          this.send({ t: "transcript", id: this.buyerTurn.id, role: "buyer", text: maskPartialDigits(heard), final: false, atMs: this.buyerTurn.startMs });
        }
        return;
      }
      case "speech-started":
        this.buyerActivity();
        if (!this.buyerTurn) this.buyerTurn = { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
        if (this.agentSpeaking) {
          // Barge-in: the browser drops the agent audio it still has queued; the turn is stored as cut.
          if (this.agentTurn) this.agentTurn.interrupted = true;
          this.send({ t: "flush" });
          // The browser drops the agent audio it still had queued: never heard, not in the recording.
          this.recorder?.cut(this.offsetMs());
          this.agentSpeaking = false;
          this.setState("listening");
        }
        return;
      case "tool-call":
        void this.enqueue(() => this.handleTool(e.callId, e.name, e.args));
        return;
      case "turn-done":
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
    }
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
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => this.timer("reconnect", ms, () => { timedOut = true; resolve(null); }));
    const attempt = (async () => {
      const deal = await readDealState(this.db, account.id, conv.leadId);
      const ctx = await loadVoiceInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) }, {
        ...(opts.resumed ? { recap: this.lines.slice(-RECAP_LINES) } : {}), ...opts, language: this.spokenLanguage,
      });
      openerPrompt = ctx.openerPrompt;
      return this.model.connect(this.sessionConfig(ctx.instructions, ctx), (e) => this.onModelEvent(e, gen));
    })().catch((e) => {
      this.lastError = clip(e instanceof Error ? e.message : e);
      return null;
    });
    const conn = await Promise.race([attempt, timeout]);
    this.clearTimer("reconnect");
    const took = Math.round(this.clock.now() - t0);
    if (!conn || timedOut || this.ended || gen !== this.gen) {
      void attempt.then((late) => late?.close());
      this.log.warn(voiceLine(this.sessionId, `${what} failed after ${took}ms: ${timedOut ? "timed out" : this.ended ? "call ended" : clip(this.lastError) || "no connection"}`));
      return null;
    }
    this.log.info(voiceLine(this.sessionId, `${what} connected in ${took}ms${this.safeConfig ? " (proven session fields only)" : ""}`));
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
      callId: `voice:${this.sessionId}:${callId}`, language: conv.language, memo, agentMessages: this.agentMessages,
    };
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private async handleBuyerFinal(raw: string, typed: boolean) {
    if (this.ended || !this.loaded) return;
    const { conv, account } = this.loaded;
    const masked = maskCardNumbers(raw.replace(/\s+/g, " ").trim().slice(0, 4000));
    if (!masked.text) return;
    // Typed while the agent speaks: like a barge-in, the browser drops the queued agent audio.
    if (typed && this.agentSpeaking) {
      if (this.agentTurn) this.agentTurn.interrupted = true;
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
    await this.db.insert(messages).values({
      accountId: account.id, conversationId: conv.id, actor: "buyer", body: masked.text, language: lineLanguage(masked.text, conv.language),
      voiceSessionId: this.sessionId, spokenAtMs: turn.startMs, typedInCall: typed, createdAt: await this.stamp(),
    });
    this.buyerSinceLastLine = true;
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
    if (now?.status === "human" && !this.pendingEnd) {
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
    if (isSpokenOptOut(masked.text)) {
      await this.codeOptOut(masked.text);
    } else if (masked.found) {
      // Card details never belong in a call: the fixed security reply, as in chat.
      this.conn.requestResponse(`The buyer started reading out a card number. Stop them politely and say exactly this and nothing else: "${CARD_REPLY[this.spokenLanguage] ?? CARD_REPLY.en}"`);
    } else if (typed) {
      this.conn.sendText(masked.text);
    }
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
  private async codeOptOut(said: string) {
    if (this.optedOut) return;
    const turn = this.ensureAgentTurn();
    const r = await this.runRecorded(turn, `optout-${this.turnSeq}`, "record_opt_out", { reason: said.slice(0, 200) });
    if (r.outcome !== "ok") return;
    this.afterOptOut();
    this.conn?.requestResponse(`The buyer asked not to be contacted again and is now opted out. Say exactly this and nothing else: "${OPT_OUT_REPLY[this.spokenLanguage] ?? OPT_OUT_REPLY.en}"`);
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
    const args = await this.voiceToolArgs(name, rawArgs).catch(() => rawArgs);
    const r = await this.runRecorded(turn, callId, name, args);
    let forModel: Record<string, unknown> = r.result;
    if (name === "send_order_form" && r.outcome !== "ok") {
      // Never a success line for a form that was not sent (the 22 Nov 2026 call said "the link is in the chat").
      const why = typeof r.result.rule === "string" ? r.result.rule : typeof r.result.error === "string" ? r.result.error : "it could not be sent";
      forModel = {
        ...r.result,
        message: `The order form was NOT sent (${why}). Do not say the order form or its link is in the chat. ${typeof r.result.message === "string" ? `${r.result.message} ` : ""}Tell the buyer in one short sentence what happens next.`,
      };
    }
    if (name === "request_callback" && r.outcome !== "ok") {
      // Never a booking link that was not sent.
      const why = typeof r.result.rule === "string" ? r.result.rule : typeof r.result.error === "string" ? r.result.error : "it could not be sent";
      forModel = {
        ...r.result,
        message: `The booking link was NOT sent (${why}). Do not say there is a link in the chat or that a call is set up. ${typeof r.result.message === "string" ? `${r.result.message} ` : ""}Tell the buyer in one short sentence what happens next.`,
      };
    }
    if (r.outcome === "ok") {
      if (name === "create_quote" && typeof r.result.quote_message_id === "string") this.send({ t: "message", messageId: r.result.quote_message_id });
      if (name === "request_callback" && this.loaded) {
        // The booking card is in the chat now: the browser shows it during the call.
        const offer = await latestBookingOffer(this.db, this.loaded.account.id, this.loaded.conv.leadId).catch(() => null);
        if (offer?.conversationId === this.loaded.conv.id) this.send({ t: "message", messageId: offer.messageId });
      }
      if (name === "create_quote") {
        // The model names a quote by its number only: internal ids out, and how to send the form for this one.
        const { quote_id: _qid, quote_message_id: _mid, ...rest } = r.result;
        void _qid;
        void _mid;
        forModel = { ...rest, ...(typeof r.result.quote === "string" ? { message: `${String(r.result.message ?? "")} This quote is ${r.result.quote}: to send its order form, call send_order_form with quote "${String(r.result.quote).replace(/\s*v\d+$/i, "")}".`.trim() } : {}) };
      }
      if (name === "record_opt_out" && OPT_OUT_REPLY[this.spokenLanguage]) {
        // The reply in the language the call speaks now (the tool gives the conversation's).
        const reply = OPT_OUT_REPLY[this.spokenLanguage];
        forModel = { ...r.result, reply, message: `The buyer is opted out and will not be contacted again. Say exactly this and nothing else: ${reply}` };
      }
      if (name === "send_order_form" && typeof r.result.link === "string") {
        // The link goes into the chat; the model is told it is there and never reads it out.
        const id = await this.storeAppMessage(`Your order form: ${r.result.link}`);
        this.send({ t: "message", messageId: id });
        // The buyer can fill it in now while the agent stays on the line: standby covers the quiet, with no idle end.
        this.noteOrderFormOpen();
        forModel = {
          ...r.result, link: "shown in the chat",
          message: "The order form link is in the chat. Say so in one short sentence, with what the buyer does there (fill in their company details, sign and pay), and say they can fill it in now while you stay on the line. Never read the link aloud. Do not end the call, say goodbye or wind down: stay quiet while they fill it in, and answer only when they speak.",
        };
      }
      if (name === "update_deal_state" && typeof r.result.stage === "string") forModel = { ...r.result, stage: voiceStageText(r.result.stage) };
      // A call request does not end this call (only a hand-off or an opt-out does).
      if (name === "record_opt_out") this.afterOptOut();
      if (name === "hand_off_to_human") {
        // The conversation is now held by the team and this call ends after the agent's last sentence.
        forModel = {
          ...r.result,
          message: "Done: the team takes over and this call ends now. Say in one short sentence that someone from the team will get back to them (to confirm the time, if a call was requested), then say goodbye. Do not say the call continues or that someone will join it, and do not continue selling.",
        };
        this.endSoon("handoff");
      }
      if (name === "end_call") {
        // The buyer asked to end the call: the goodbye is spoken (or finished), then the call ends.
        forModel = { ...r.result, message: "The call ends now. If you have not said goodbye yet, say one short goodbye; say nothing else." };
        // Goodbye already said before the tool: a short wait for anything the model adds; else the usual grace for the goodbye.
        // The browser plays out the audio it has before it closes (voice-client onEnded).
        this.endSoon("agent_closed", turn.text.trim() ? Math.min(END_AFTER_GOODBYE_MS, this.limits.endGraceMs) : this.limits.endGraceMs);
      }
    }
    // Every result message in call wording ("confirm it here" → "by message", …).
    if (typeof forModel.message === "string") forModel = { ...forModel, message: voiceToolResultMessage(forModel.message) };
    // A call in another language than English: the guidance (written in English) names the language to answer in.
    if (this.spokenLanguage !== "en" && name !== "record_opt_out") {
      forModel = { ...forModel, message: `${typeof forModel.message === "string" ? `${forModel.message} ` : ""}${this.sayIn()}` };
    }
    this.conn?.sendToolResult(callId, name, forModel);
    turn.awaitingContinuation = true;
    this.send({ t: "tool", id: callId, name, label, status: r.outcome });
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
    this.agentSpeaking = false;
    this.openerDone = true;
    if (this.pendingEnd) {
      void this.stop(this.pendingEnd);
      return;
    }
    this.setState("listening");
    this.startQuiet();
  }

  /**
   * The model says its cut answer again after a cut that had no words from the buyer: the last stored line was
   * cut, no buyer line came since, no buyer turn waits for its transcription, and this line starts within
   * FALSE_CUT_REDO_MS of the cut. Then the cut row becomes this line (one line, in the language it was said in).
   */
  private redoesFalseCut(turn: AgentTurn): boolean {
    const last = this.lastLine;
    return !!last && last.cut && last.cutAtMs !== undefined && !this.buyerSinceLastLine && this.buyerTurn === null
      && turn.startMs - last.cutAtMs <= FALSE_CUT_REDO_MS;
  }

  /**
   * Stores the agent's turn: ONE message with the text actually spoken, and its tool calls, like
   * lib/agent/turn.ts. A turn the buyer cut short ends with "…". One stored message per agent line:
   * when the model resumes or re-says a line that was cut, the cut row is updated to the full line
   * (its id, time in the call and tool calls kept); a cut copy of the line just said is not stored.
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
    // A cut transcript may stop mid-word ("40 doll"): the whole line still continues it.
    const resumes = !!last && last.cut && !!raw && (continuesCutLine(raw, last.raw) || this.redoesFalseCut(turn));
    const repeatsCut = !!last && cut && !resumes && continuesCutLine(last.raw, raw);
    if (last && (resumes || repeatsCut)) {
      // Resumed after the cut: the earlier row becomes the whole line. A cut copy of the line just said adds nothing.
      const now = await this.stamp();
      const newBody = resumes ? body : (last.cut ? cutLine(last.raw) : last.raw);
      await atomic(this.db, (q) => [
        ...(resumes ? [q.update(messages).set({ body: newBody, language: lineLanguage(newBody, conv.language) }).where(and(eq(messages.id, last.messageId), eq(messages.accountId, account.id)))] : []),
        ...(turn.tools.length ? [q.insert(toolCalls).values(toolRows(last.messageId, last.tools))] : []),
        q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, account.id))),
      ]);
      this.lastLine = resumes
        ? { ...last, raw, cut, tools: last.tools + turn.tools.length, ...(cut ? { cutAtMs: this.offsetMs() } : { cutAtMs: undefined }) }
        : { ...last, tools: last.tools + turn.tools.length };
      if (resumes) {
        const i = this.lines.findLastIndex((l) => l.role === "agent");
        if (i >= 0) this.lines[i] = { role: "agent", text: newBody };
      }
      this.send({ t: "transcript", id: last.turnId, role: "agent", text: newBody, final: true, atMs: last.startMs });
      if (turn.id !== last.turnId) this.send({ t: "transcript", id: turn.id, role: "agent", text: resumes ? newBody : body, final: true, atMs: turn.startMs });
      return;
    }
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
    if (raw) this.lastLine = { messageId, turnId: turn.id, raw, cut, tools: turn.tools.length, startMs: turn.startMs, ...(cut ? { cutAtMs: this.offsetMs() } : {}) };
    this.buyerSinceLastLine = false;
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
    this.agentSpeaking = false;
    const fresh = early && !this.openerDone && !this.lastLine;
    // Our pinned default voice has never been proven on every account: the retry leaves it out (the model's own default).
    const droppedVoice = early && !resolveVoiceSettings(this.loaded.version.voiceSettings).voice && !!callVoice(null, this.model.modelId);
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
    if (fresh) opened.conn.requestResponse(opened.openerPrompt);
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
      + `${this.clientClose ? ` client=${this.clientClose.code ?? "-"}/"${this.clientClose.reason}"` : ""}${this.modelClose ? ` model=${this.modelClose.code ?? "-"}/"${this.modelClose.reason}"@${this.modelClose.msAfterConnect ?? "?"}ms` : ""}`));
    const answerMsAvg = this.answerMsAvg();
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
