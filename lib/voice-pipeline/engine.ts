/**
 * The pipeline voice engine (PROOF; test lab only, platform admins only, engine id "pipeline"):
 *
 *   buyer audio → LISTENING (a streaming transcription model) → THINKING (the text chat agent: tools first, then one
 *   reply, exactly as in chat) → SPEAKING (a streaming speech model) → agent audio to the browser.
 *
 * It answers the question "does a listen-think-speak pipeline work end to end, how long until the agent speaks, how
 * does the voice sound", next to today's live-voice engines. It is not the full build: see the report in the commit
 * and the limits listed here.
 *
 * Same relay contract as the other engines (lib/voice/socket.ts RelayEngine) and the same browser protocol
 * (lib/voice/protocol.ts): no browser change. Same call rules as the live engine: the session row goes live and ends
 * with its figures and endDetail, the heartbeat keeps the live row's figures fresh (stale close), the call's time
 * limit (with the limit_soon notice) and an end from elsewhere ("End that call") stop it, and the thread gets the
 * "Voice call ended" line. The platform/spend gates run at the start of a live call (createVoiceSession ran them too).
 *
 * Rows: the buyer's line is stored here (voice_session_id, spoken_at_ms, typed_in_call, card numbers masked) before
 * the chat turn runs with buyerMessageStored and this call's callSessionId; the chat turn stores its reply row (stamped
 * with voice_session_id) and any cards (not stamped) itself; this engine sets the reply's spoken_at_ms and answer_ms
 * at its first audio (or spoken_at_ms alone, when it is never spoken). The chat thread after the call
 * reads as a normal chat with the call markers.
 *
 * Proof limits: not recorded (recording_state "off"); a barge-in cuts the audio but the reply row stays whole; no
 * standby (the listener runs for the whole call); no spoken time-limit announcement (the notice only); no tool
 * progress messages (the chat turn runs its tools inside one call); the order-form context is not used.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  agentVersions, conversations, leads, messages, sellerAccounts, voiceSessions,
  type AgentVersion, type Conversation, type Lead, type SellerAccount, type VoiceEndBy, type VoiceEndDetail, type VoiceEndReason, type VoiceSettings, type VoiceUsage,
} from "@/db/schema";
import type { LlmClient } from "@/lib/agent/llm";
import { openerText } from "@/lib/agent/core/opener";
import { buyerNames } from "@/lib/agent/core/names";
import { voiceCallEndedLine } from "@/lib/agent/thread-markers";
import { isLocale } from "@/lib/i18n";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import type { ClientMessage, ServerMessage, VoiceErrorCode, VoiceState } from "@/lib/voice/protocol";
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";
import { systemClock, type Clock, type TimerHandle } from "@/lib/voice/realtime";
import { maxCallSeconds } from "@/lib/voice/settings";
import { EnergyVad, rms } from "@/lib/voice/vad";
import { maskCardNumbers } from "@/lib/voice/safety";
import { lineLanguage, limitWarnSecFor } from "@/lib/voice/engine";
import { clip, consoleVoiceLog, errorSummary, textPrint, voiceLine, type VoiceLog } from "@/lib/voice/log";
import { PIPELINE_ENGINE } from "@/lib/voice-classic/engine-choice";
import { PIPELINE_TIMING, pipelineCostMicros, type PipelineUsage } from "./models";
import type { Listener } from "./listener";
import type { Speaker } from "./speaker";
import { PcmFramer, pcmMs } from "./pcm";
import { spokenForm, splitSentences } from "./spoken";
import { median, TurnTaking, type BuyerLine } from "./turns";
import { runCallTurn, type CallTurnFn } from "./turn";

export type PipelineLimits = {
  deadlineSec?: number | null;
  env?: Record<string, string | undefined>;
  limitWarnSec?: number;
  statsEveryMs?: number;
  heartbeatMs?: number;
  /** The browser said it will send `{t:"ready"}` (auth `waitAudio`): the opening line waits for it. */
  waitForClientAudio?: boolean;
  clientReadyMs?: number;
  finalWaitMs?: number;
  leadMs?: number;
};

export type PipelineEngineDeps = {
  db: Db;
  sessionId: string;
  /** To the browser: a protocol message (JSON) or agent audio (binary, PCM16 24 kHz). */
  send: (msg: ServerMessage | Uint8Array) => void;
  mode: "live" | "scripted";
  /** Builds the call's listener when the call starts (one for the whole call). */
  listener: () => Listener;
  speaker: Speaker;
  /** The chat model client (live: the Anthropic client; scripted: a ScriptedLlm stand-in). */
  llm: LlmClient;
  /** Tests: the chat-turn function (default: runCallTurn, the real chat turn). */
  turn?: CallTurnFn;
  clock?: Clock;
  limits?: PipelineLimits;
  log?: VoiceLog;
  onEnding?: (work: Promise<unknown>) => void;
};

const DEFAULTS: Required<Omit<PipelineLimits, "deadlineSec" | "env">> = {
  limitWarnSec: 45, statsEveryMs: 5_000, heartbeatMs: 20_000, waitForClientAudio: false,
  clientReadyMs: PIPELINE_TIMING.clientReadyMs, finalWaitMs: PIPELINE_TIMING.finalWaitMs, leadMs: PIPELINE_TIMING.leadMs,
};

const BY_REASON: Record<VoiceEndReason, VoiceEndBy> = {
  user_hangup: "client_end", agent_closed: "tool", limit: "limit", silence: "idle", idle: "idle", opt_out: "tool", handoff: "tool",
  take_over: "take_over", connection_lost: "client_closed", budget: "gate", error: "error",
};

/** A chat turn still running when the call ends gets this long to store its reply before the end line. */
const TURN_FINISH_TIMEOUT_MS = 15_000;
const FINAL_WRITE_TIMEOUT_MS = 8_000;

type Loaded = { conv: Conversation; lead: Lead; version: AgentVersion; account: SellerAccount };

/** One answered turn's timings (ms) for the trace and the call's medians. */
type TurnTimes = { listenMs: number | null; thinkMs: number; speakMs: number; totalMs: number; tools: number; chars: number };

/** What a spoken reply needs to measure itself: when its buyer line ended and when the reply text came. */
type SpeakTurn = { messageId: string; n: number | null; speechEndAt: number | null; finalAt: number; replyAt: number; listenMs: number | null; thinkMs: number; tools: number; endAfter: VoiceEndReason | null };

export class PipelineVoiceEngine {
  readonly sessionId: string;
  private readonly db: Db;
  private readonly out: PipelineEngineDeps["send"];
  private readonly clock: Clock;
  private readonly log: VoiceLog;
  private readonly limits: typeof DEFAULTS & PipelineLimits;
  private readonly speaker: Speaker;
  private readonly llm: LlmClient;
  private readonly turnFn: CallTurnFn;
  private readonly makeListener: () => Listener;
  private readonly mode: "live" | "scripted";
  private readonly onEnding: PipelineEngineDeps["onEnding"];

  private listener: Listener | null = null;
  private loaded: Loaded | null = null;
  private started = false;
  private ended = false;
  private endedExternally = false;
  private stopping: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private state: VoiceState | null = null;
  private callStart: number | null = null;
  private maxSec = 0;
  private muted = false;
  private clientReady = false;
  private pendingOpener = false;
  private errorCode: VoiceErrorCode | null = null;
  private endBy: VoiceEndBy | null = null;
  private clientClose: VoiceEndDetail["clientClose"];
  private lastError: string | undefined;
  private lastStamp = 0;
  private language = "en";
  private timers: Record<"warn" | "limit" | "stats" | "heartbeat" | "ready" | "finalWait" | "played", TimerHandle | null> = {
    warn: null, limit: null, stats: null, heartbeat: null, ready: null, finalWait: null, played: null,
  };

  // Listening
  private readonly vad = new EnergyVad({ ...PIPELINE_TIMING.vad });
  private loudMs = 0;
  private speechStartMs: number | null = null;
  private speechEndAt: number | null = null;
  private finals: string[] = [];
  private lastFinalAt: number | null = null;
  private partial = "";
  /** A line was committed from its partial text (no final in time): its late final is dropped. */
  private dropLateFinal = false;
  private buyerSeq = 0;
  private buyerLineId = "";

  // Thinking / speaking
  private readonly turns = new TurnTaking(PIPELINE_TIMING.minTurnChars);
  private running: Promise<void> | null = null;
  private speakGen = 0;
  private playheadAt = 0;
  private waits = new Set<() => void>();
  private readonly framer = new PcmFramer(PIPELINE_TIMING.frameBytes);
  private turnSeq = 0;

  // Figures
  private times: TurnTimes[] = [];
  private spokenChars = 0;
  private bargeIns = 0;
  private thinkModel = "";

  constructor(deps: PipelineEngineDeps) {
    this.db = deps.db;
    this.sessionId = deps.sessionId;
    this.out = deps.send;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? consoleVoiceLog;
    this.limits = { ...DEFAULTS, ...deps.limits };
    this.speaker = deps.speaker;
    this.llm = deps.llm;
    this.turnFn = deps.turn ?? runCallTurn;
    this.makeListener = deps.listener;
    this.mode = deps.mode;
    this.onEnding = deps.onEnding;
  }

  // -------------------------------------------------------------------------
  // Relay API (lib/voice/socket.ts RelayEngine)
  // -------------------------------------------------------------------------

  start(): Promise<void> {
    if (this.started) return this.queue;
    this.started = true;
    return this.enqueue(() => this.doStart());
  }

  onClientMessage(msg: ClientMessage): void {
    if (this.ended) return;
    switch (msg.t) {
      case "start":
        void this.start();
        return;
      case "mute":
        this.muted = msg.on;
        return;
      case "text":
        this.trace(`buyer typed len=${msg.text.length}`);
        if (this.callStart === null) return;
        this.commitBuyer(msg.text, true);
        return;
      case "end":
        void this.stop("user_hangup");
        return;
      case "ready":
        this.clientReady = true;
        if (this.pendingOpener) void this.enqueue(() => this.sayOpener("ready"));
        return;
      case "heard":
        this.trace(`browser heard first audio (browser: ${msg.sinceFirstChunkMs}ms after it arrived, queued ${msg.queuedMs}ms)`);
        return;
      default:
        // ping, wake (no standby in the proof), context (the order form is not used in the proof).
        return;
    }
  }

  onClientAudio(bytes: Uint8Array): void {
    if (this.ended || this.muted || this.callStart === null || !this.listener) return;
    // Before the opening line is spoken the buyer is not heard (one opening only), as on the live engine.
    if (this.pendingOpener) return;
    this.listener.pushAudio(bytes);
    const ms = pcmMs(bytes.byteLength, VOICE_SAMPLE_RATE);
    const loud = rms(bytes) >= this.vad.level;
    this.loudMs = loud ? this.loudMs + ms : 0;
    const e = this.vad.push(bytes);
    if (e === "start") {
      this.speechStartMs = Math.max(0, this.offsetMs() - PIPELINE_TIMING.vad.minSpeechMs);
      this.speechEndAt = null;
      this.dropLateFinal = false;
      this.clearTimer("finalWait");
      this.trace("buyer speech start");
    } else if (e === "end") {
      this.onSpeechEnd();
    }
    if (this.turns.state === "speaking" && this.loudMs >= PIPELINE_TIMING.bargeInSpeechMs) this.bargeIn("speech");
  }

  onClientGone(close?: { code?: number | null; reason?: string; idle?: boolean }): Promise<void> {
    if (close && !this.ended) this.clientClose = { code: close.code ?? null, reason: clip(close.reason) };
    return this.stop("connection_lost", undefined, close?.idle ? "client_idle" : "client_closed");
  }

  stop(reason: VoiceEndReason, code?: VoiceErrorCode, by?: VoiceEndBy): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ended = true;
    this.endBy = by ?? BY_REASON[reason] ?? "error";
    if (code) this.errorCode = code;
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) this.clearTimer(k);
    this.speakGen++;
    this.speaker.cancel();
    this.releaseWaits();
    this.listener?.close();
    this.stopping = this.enqueue(() => this.finish(reason), true);
    this.onEnding?.(this.stopping);
    return this.stopping;
  }

  get isEnded() {
    return this.ended;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>, evenIfEnded = false): Promise<void> {
    const p = this.queue.then(async () => {
      if (this.ended && !evenIfEnded) return;
      await fn();
    }).catch((e) => {
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

  private offsetMs() {
    return this.callStart === null ? 0 : Math.max(0, Math.round(this.clock.now() - this.callStart));
  }

  private trace(what: string) {
    this.log.info(voiceLine(this.sessionId, `trace t=${this.offsetMs()} pipeline ${what}`));
  }

  /** A created_at strictly after every row this call wrote. */
  private async stamp(): Promise<Date> {
    while (Date.now() <= this.lastStamp) await new Promise((r) => setTimeout(r, 1));
    this.lastStamp = Date.now();
    return new Date(this.lastStamp);
  }

  private fail(reason: VoiceEndReason, code: VoiceErrorCode, by?: VoiceEndBy) {
    this.errorCode = code;
    this.log.warn(voiceLine(this.sessionId, `call failing: ${code} (${by ?? BY_REASON[reason]}) engine=${PIPELINE_ENGINE}`));
    this.send({ t: "error", code });
    void this.stop(reason, code, by);
  }

  /** Waits on the call clock; released early by a barge-in or the end. */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let h: TimerHandle | null = null;
      const done = () => {
        this.waits.delete(done);
        this.clock.clearTimeout(h);
        resolve();
      };
      this.waits.add(done);
      h = this.clock.setTimeout(done, Math.max(0, ms));
    });
  }

  private releaseWaits() {
    for (const w of [...this.waits]) w();
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
    const [[lead], [version]] = await Promise.all([
      this.db.select().from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, accountId))),
      this.db.select().from(agentVersions).where(and(eq(agentVersions.id, session.agentVersionId ?? conv.agentVersionId), eq(agentVersions.accountId, accountId))),
    ]);
    if (!lead || !version) return this.fail("error", "not_found");
    // Gates (as the live engine and runBuyerTurn): nothing automated on a closed, opted-out, handed-off or paused conversation.
    if (conv.status === "closed" || lead.status === "opted_out") return this.fail("error", "conversation_closed");
    if (conv.status === "human") return this.fail("error", "human_handling");
    if (account.status === "paused") return this.fail("error", "account_paused");
    if (this.mode === "live") {
      if (await spendCapped(this.db, accountId)) return this.fail("budget", "spend_cap", "gate");
      if ((await platformBudget(this.db)).exceeded) return this.fail("budget", "platform_budget", "gate");
    }
    this.loaded = { conv, lead, version, account };
    this.language = conv.language || "en";
    this.thinkModel = version.model;
    this.maxSec = maxCallSeconds({ settings: version.voiceSettings, deadlineSec: this.limits.deadlineSec, env: this.limits.env });
    try {
      this.listener = this.makeListener();
    } catch (e) {
      this.lastError = clip(e instanceof Error ? e.message : e);
      this.log.warn(voiceLine(this.sessionId, `pipeline listener unavailable: ${this.lastError}`));
      return this.fail("error", "model_unavailable");
    }
    const listener = this.listener;
    listener.onPartial((t) => this.onPartial(t));
    listener.onFinal((t) => this.onFinal(t));
    listener.onError((m) => {
      this.lastError = clip(m);
      this.log.warn(voiceLine(this.sessionId, `pipeline listener: ${this.lastError}`));
    });
    this.callStart = this.clock.now();
    const agentRows = await this.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "agent"))).limit(1);
    this.log.info(voiceLine(this.sessionId, `engine=${PIPELINE_ENGINE} mode=${this.mode} listen=${listener.modelId} think=${version.model}/${version.effort} speak=${this.speaker.modelId} voice=${this.speaker.voice}`));
    await this.db.update(voiceSessions)
      .set({
        status: "live", connectedAt: new Date(this.callStart), mode: this.mode, ...(this.mode === "live" ? { model: listener.modelId } : {}),
        settings: this.settingsSnapshot(), recordingState: "off",
      })
      .where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "pending")));
    this.log.info(voiceLine(this.sessionId, "recording off: not in the pipeline proof"));
    const warnSec = limitWarnSecFor(this.maxSec, this.limits.limitWarnSec);
    if (this.maxSec > warnSec) this.timer("warn", (this.maxSec - warnSec) * 1000, () => this.send({ t: "notice", kind: "limit_soon" }));
    this.timer("limit", this.maxSec * 1000, () => void this.stop("limit", undefined, "limit"));
    this.statsLoop();
    this.heartbeatLoop();
    this.setState("listening");
    // The opening line: a new conversation (no agent message yet) starts with the chat's own opener; a call on a chat
    // that already has agent messages starts by listening.
    if (agentRows.length === 0) {
      this.pendingOpener = true;
      if (!this.limits.waitForClientAudio || this.clientReady) await this.sayOpener(this.clientReady ? "ready" : "now");
      else this.timer("ready", this.limits.clientReadyMs, () => void this.enqueue(() => this.sayOpener("timeout")));
    } else {
      this.trace("opener none: the conversation already has agent messages (listening first)");
    }
  }

  private settingsSnapshot(): VoiceSettings {
    const version = this.loaded!.version;
    return {
      ...version.voiceSettings, voice: this.speaker.voice, fillers: false, maxCallSec: this.maxSec, engine: PIPELINE_ENGINE,
      pipeline: { listenModel: this.listener?.modelId ?? "", thinkModel: version.model, thinkEffort: version.effort, speakModel: this.speaker.modelId, voice: this.speaker.voice },
    } as VoiceSettings;
  }

  /** The chat's opener (lib/agent/core/opener.ts openerText, as the first message of a new chat), stored and spoken. */
  private async sayOpener(why: "ready" | "timeout" | "now") {
    if (!this.pendingOpener || this.ended || !this.loaded) return;
    this.pendingOpener = false;
    this.clearTimer("ready");
    const { conv, lead, version, account } = this.loaded;
    const locale = isLocale(this.language) ? this.language : "en";
    const names = buyerNames(version.playbook, account, locale);
    const firstName = lead.fullName.trim().split(/\s+/)[0] || "there";
    const text = openerText({ name: firstName, agent: names.agent, company: names.seller, gender: names.gender, language: locale, opener: version.playbook.opener });
    const id = randomUUID();
    await this.db.insert(messages).values({
      id, accountId: account.id, conversationId: conv.id, actor: "agent", body: text, language: locale, agentVersionId: version.id,
      voiceSessionId: this.sessionId, spokenAtMs: this.offsetMs(), createdAt: await this.stamp(),
    });
    this.trace(`opener (${why}) len=${text.length} print=${textPrint(text)}`);
    this.send({ t: "transcript", id, role: "agent", text, final: true, atMs: this.offsetMs() });
    if (!this.turns.speakFirst()) return;
    const now = this.clock.now();
    this.running = this.speakTurn(text, { messageId: id, n: null, speechEndAt: null, finalAt: now, replyAt: now, listenMs: null, thinkMs: 0, tools: 0, endAfter: null })
      .catch((e) => this.log.warn(voiceLine(this.sessionId, `pipeline opener failed: ${errorSummary(e)}`)));
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  private onPartial(text: string) {
    if (this.ended || this.pendingOpener) return;
    this.partial = text.trim();
    if (!this.partial) return;
    this.buyerLineId ||= `b${++this.buyerSeq}`;
    this.send({ t: "transcript", id: this.buyerLineId, role: "buyer", text: [...this.finals, this.partial].join(" "), final: false, atMs: this.offsetMs() });
    if (this.turns.state === "speaking" && this.partial.split(/\s+/).filter(Boolean).length >= PIPELINE_TIMING.bargeInWords) this.bargeIn("partial");
  }

  private onFinal(text: string) {
    if (this.ended || this.pendingOpener) return;
    const t = text.trim();
    if (!t) return;
    if (this.dropLateFinal && !this.vad.inSpeech) {
      this.dropLateFinal = false;
      this.trace(`late final dropped len=${t.length} (its line was taken from the partial)`);
      return;
    }
    this.finals.push(t);
    this.partial = "";
    this.lastFinalAt = this.clock.now();
    this.trace(`final transcript len=${t.length}${this.speechEndAt !== null ? ` +${Math.round(this.clock.now() - this.speechEndAt)}ms after speech end` : ""}`);
    // The buyer is still speaking: more of the line may come; it is committed when the speech ends.
    if (!this.vad.inSpeech) this.commitBuyer(null, false);
  }

  /** The local detector heard the buyer stop (endSilenceMs of quiet): commit what was heard, or wait for the final. */
  private onSpeechEnd() {
    this.speechEndAt = this.clock.now() - PIPELINE_TIMING.vad.endSilenceMs;
    this.trace("buyer speech end");
    if (this.finals.length) return this.commitBuyer(null, false);
    this.timer("finalWait", this.limits.finalWaitMs, () => {
      if (this.finals.length) return this.commitBuyer(null, false);
      if (this.partial) {
        this.trace(`no final transcript within ${this.limits.finalWaitMs}ms: the partial is the line`);
        this.dropLateFinal = true;
        return this.commitBuyer(null, false);
      }
      this.trace("speech without a transcript (noise)");
      this.speechEndAt = null;
    });
  }

  /** A buyer line is complete: `typed` text, or what the listener heard (`text` null). */
  private commitBuyer(typedText: string | null, typed: boolean) {
    const text = (typed ? typedText ?? "" : [...this.finals].join(" ") || this.partial).trim();
    const line: BuyerLine = {
      text, typed, speechEndAt: typed ? this.clock.now() : this.speechEndAt, finalAt: typed ? this.clock.now() : this.lastFinalAt ?? this.clock.now(),
      startMs: typed ? this.offsetMs() : this.speechStartMs ?? this.offsetMs(),
    };
    if (!typed) {
      this.finals = [];
      this.partial = "";
      this.lastFinalAt = null;
      this.speechEndAt = null;
      this.speechStartMs = null;
      this.clearTimer("finalWait");
    }
    const id = this.buyerLineId || `b${++this.buyerSeq}`;
    this.buyerLineId = "";
    const r = this.turns.commit(line);
    if (r === "ignored") {
      this.trace(`noise ignored len=${text.length}`);
      if (!typed && text) this.send({ t: "transcript", id, role: "buyer", text: "", final: true, atMs: this.offsetMs() });
      return;
    }
    this.send({ t: "transcript", id, role: "buyer", text, final: true, atMs: line.startMs, ...(typed ? { typed: true as const } : {}) });
    if (r === "queued") {
      this.trace(`buyer line queued len=${text.length} (a turn is thinking)`);
      return;
    }
    if (r === "barge_and_run") this.cutSpeech("typed");
    this.runTurn(line);
  }

  // -------------------------------------------------------------------------
  // Thinking
  // -------------------------------------------------------------------------

  private runTurn(line: BuyerLine) {
    const n = ++this.turnSeq;
    const prev = this.running ?? Promise.resolve();
    this.running = prev.then(() => this.think(line, n)).catch((e) => {
      (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `pipeline turn ${n} failed: ${errorSummary(e)}`));
      if (!this.ended) {
        this.turns.replied(false);
        this.setState("listening");
      }
    });
  }

  private async think(line: BuyerLine, n: number) {
    if (this.ended || !this.loaded) return;
    const { conv, account, lead } = this.loaded;
    const masked = maskCardNumbers(line.text.slice(0, 4000));
    const language = lineLanguage(masked.text, conv.language);
    await this.db.insert(messages).values({
      accountId: account.id, conversationId: conv.id, actor: "buyer", body: masked.text, language,
      voiceSessionId: this.sessionId, spokenAtMs: line.startMs, typedInCall: line.typed, createdAt: await this.stamp(),
    });
    if (this.ended) return;
    this.setState("checking");
    const listenMs = line.typed || line.speechEndAt === null ? null : Math.max(0, Math.round(line.finalAt - line.speechEndAt));
    this.trace(`turn=${n} think start len=${masked.text.length}${line.typed ? " typed" : ""}`);
    const result = await this.turnFn(this.db, this.llm, { accountId: account.id, conversationId: conv.id, leadId: lead.id, text: masked.text, callSessionId: this.sessionId });
    const replyAt = this.clock.now();
    const thinkMs = Math.max(0, Math.round(replyAt - line.finalAt));
    if (result.status !== "replied") {
      this.trace(`turn=${n} no reply status=${result.status} think=${thinkMs}ms`);
      if (result.status === "in_call") {
        this.log.warn(voiceLine(this.sessionId, "pipeline turn refused by the one-agent block (in_call): the chat turn needs this call's callSessionId (lib/voice-pipeline/turn.ts PIPELINE-HOOK)"));
      } else if (result.status === "error") {
        this.lastError = clip(result.error);
      }
      if (this.ended) return;
      const next = this.turns.replied(false);
      this.setState("listening");
      if (next) this.runTurn(next);
      return;
    }
    // The chat turn stored its reply row (stamped with this call's session: callSessionId) and any cards (not
    // stamped). spokenAtMs is set here when its first audio goes out (a line with a session and no spokenAtMs is
    // hidden from the call block), or, if it is never spoken, when it would have been (markUnspoken).
    this.send({ t: "transcript", id: result.messageId, role: "agent", text: result.text, final: true, atMs: this.offsetMs() });
    this.send({ t: "message", messageId: result.messageId });
    // An opt-out closes the conversation, a hand-off gives it to the team: the reply is said, then the call ends.
    const [after] = await this.db.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, conv.id));
    const endAfter: VoiceEndReason | null = after?.status === "closed" ? "opt_out" : after?.status === "human" ? "handoff" : null;
    if (this.ended) return this.markUnspoken(result.messageId, "the call ended while thinking");
    this.trace(`turn=${n} reply len=${result.text.length} print=${textPrint(result.text)} think=${thinkMs}ms tools=${result.calls}`);
    if (this.turns.replied(true) !== null) return this.markUnspoken(result.messageId, "not in a thinking turn");
    await this.speakTurn(result.text, { messageId: result.messageId, n, speechEndAt: line.speechEndAt, finalAt: line.finalAt, replyAt, listenMs, thinkMs, tools: result.calls, endAfter });
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  /** Says a reply sentence by sentence (the next one is synthesized while the current one plays), paced to real time. */
  private async speakTurn(chatText: string, t: SpeakTurn) {
    const gen = ++this.speakGen;
    const language = lineLanguage(chatText, this.language);
    const sentences = splitSentences(spokenForm(chatText, language));
    this.setState("speaking");
    this.framer.reset();
    let firstAudio = false;
    let speechFailed = false;
    let chars = 0;
    // Prefetch: each sentence's audio is collected as soon as its synthesis starts.
    const starts: Prefetch[] = [];
    const startSentence = (i: number) => {
      if (i >= sentences.length || starts[i]) return;
      chars += sentences[i].length;
      this.spokenChars += sentences[i].length;
      starts[i] = prefetch(this.speaker.speak(sentences[i], { language }));
    };
    try {
      for (let i = 0; i < sentences.length; i++) {
        startSentence(i);
        startSentence(i + 1);
        for await (const chunk of starts[i].chunks()) {
          if (gen !== this.speakGen) return;
          for (const frame of this.framer.push(chunk)) {
            await this.pace();
            if (gen !== this.speakGen) return;
            this.send(frame);
            const now = this.clock.now();
            this.playheadAt = Math.max(this.playheadAt, now) + pcmMs(frame.byteLength, VOICE_SAMPLE_RATE);
            if (!firstAudio) {
              firstAudio = true;
              this.onFirstAudio(t, now, sentences.join(" ").length);
            }
          }
        }
        if (gen !== this.speakGen) return;
      }
    } catch (e) {
      this.lastError = clip(e instanceof Error ? e.message : e);
      this.log.warn(voiceLine(this.sessionId, `pipeline speech failed (model ${this.speaker.modelId}, voice ${this.speaker.voice}): ${this.lastError}; if the voice is refused, set PIPELINE_VOICE in lib/voice-pipeline/models.ts`));
      this.speaker.cancel();
      speechFailed = true;
    } finally {
      for (const s of starts) s?.stop();
      // A reply never heard still gets its place in the call (spokenAtMs): never hidden from the call block.
      if (!firstAudio && t.n !== null) {
        const why = speechFailed ? "speech failed" : gen !== this.speakGen ? (this.ended ? "the call ended" : "barge-in before any audio") : "nothing to say after the spoken form";
        await this.markUnspoken(t.messageId, why);
      }
    }
    if (gen !== this.speakGen) return;
    if (!firstAudio) this.trace(`turn=${t.n ?? "opener"} said nothing (chars=${chars})`);
    // The browser plays what was sent: speaking until the playhead, then the next line (or listening).
    const left = Math.max(0, this.playheadAt - this.clock.now());
    if (left > 0) await this.wait(left);
    if (gen !== this.speakGen || this.ended) return;
    if (t.endAfter) {
      this.trace(`call ends after the reply (${t.endAfter})`);
      void this.stop(t.endAfter, undefined, "tool");
      return;
    }
    const next = this.turns.spoken();
    this.setState(next ? "checking" : "listening");
    if (next) this.runTurn(next);
  }

  /** Waits until the browser's queue is within the lead (never more than leadMs of agent audio queued there). */
  private async pace() {
    const ahead = this.playheadAt - this.clock.now();
    if (ahead > this.limits.leadMs) await this.wait(ahead - this.limits.leadMs);
  }

  private onFirstAudio(t: SpeakTurn, now: number, chars: number) {
    const speakMs = Math.max(0, Math.round(now - t.replyAt));
    if (t.n === null) {
      this.trace(`opener first audio +${speakMs}ms chars=${chars}`);
      return;
    }
    const from = t.speechEndAt ?? t.finalAt;
    const totalMs = Math.max(0, Math.round(now - from));
    this.times.push({ listenMs: t.listenMs, thinkMs: t.thinkMs, speakMs, totalMs, tools: t.tools, chars });
    this.trace(`turn=${t.n} listen=${t.listenMs ?? "-"}ms think=${t.thinkMs}ms tools=${t.tools} speak=${speakMs}ms total=${totalMs}ms chars=${chars}`);
    void this.db.update(messages).set({ spokenAtMs: this.offsetMs(), answerMs: totalMs }).where(eq(messages.id, t.messageId))
      .catch((e) => this.log.warn(voiceLine(this.sessionId, `spoken time not stored: ${errorSummary(e)}`)));
  }

  /** A reply that was never spoken: its spokenAtMs is when it would have been (now), so the call block shows it. */
  private async markUnspoken(messageId: string, why: string) {
    const at = this.offsetMs();
    this.log.warn(voiceLine(this.sessionId, `pipeline reply not spoken (${why}): spoken_at_ms set to ${at} so the line shows in the call`));
    try {
      await this.db.update(messages).set({ spokenAtMs: at }).where(and(eq(messages.id, messageId), isNull(messages.spokenAtMs)));
    } catch (e) {
      this.log.warn(voiceLine(this.sessionId, `spoken time not stored: ${errorSummary(e)}`));
    }
  }

  /** The buyer cut in while the agent spoke: stop the audio now, the browser drops what it queued, listen. */
  private bargeIn(by: "speech" | "partial") {
    if (!this.turns.bargeIn()) return;
    this.cutSpeech(by);
    this.setState("listening");
  }

  private cutSpeech(by: string) {
    this.speakGen++;
    this.speaker.cancel();
    this.releaseWaits();
    this.framer.reset();
    this.playheadAt = this.clock.now();
    this.bargeIns++;
    this.send({ t: "flush" });
    this.trace(`barge-in by=${by}: agent audio stopped (the reply row stays whole)`);
  }

  // -------------------------------------------------------------------------
  // Figures, heartbeat, end
  // -------------------------------------------------------------------------

  private usage(): PipelineUsage {
    const listenSec = this.listener?.audioSec ?? 0;
    const cost = pipelineCostMicros(this.listener?.modelId ?? "", listenSec, this.speaker.modelId, this.spokenChars);
    const live = this.mode === "live";
    return {
      listenModel: this.listener?.modelId ?? "", thinkModel: this.thinkModel, speakModel: this.speaker.modelId,
      listenSec, spokenChars: this.spokenChars, listenCostMicros: live ? cost.listen : 0, speakCostMicros: live ? cost.speak : 0,
      turns: this.times.length,
      medianAnswerMs: median(this.times.map((x) => x.totalMs)),
      medianListenMs: median(this.times.flatMap((x) => (x.listenMs === null ? [] : [x.listenMs]))),
      medianThinkMs: median(this.times.map((x) => x.thinkMs)),
      medianSpeakMs: median(this.times.map((x) => x.speakMs)),
      bargeIns: this.bargeIns,
    };
  }

  private figures(endDetail?: VoiceEndDetail): { durationSec: number; costMicros: number; usage: VoiceUsage; answerMsAvg: number | null } {
    const durationSec = this.callStart === null ? 0 : Math.round(this.offsetMs() / 1000);
    const pipeline = this.usage();
    const usage = {
      audioInTokens: 0, audioOutTokens: 0, textInTokens: 0, textOutTokens: 0, cachedInTokens: 0,
      ...(endDetail ? { endDetail } : {}), pipeline,
    } as VoiceUsage;
    const totals = this.times.map((x) => x.totalMs);
    const answerMsAvg = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
    return { durationSec, costMicros: pipeline.listenCostMicros + pipeline.speakCostMicros, usage, answerMsAvg };
  }

  private statsLoop() {
    this.timer("stats", this.limits.statsEveryMs, () => {
      const f = this.figures();
      this.send({ t: "stats", durationSec: f.durationSec, costMicros: f.costMicros, answerMsAvg: f.answerMsAvg });
      this.statsLoop();
      void this.enqueue(() => this.checkEndedExternally());
    });
  }

  private heartbeatLoop() {
    this.timer("heartbeat", this.limits.heartbeatMs, () => {
      this.heartbeatLoop();
      void this.enqueue(async () => {
        if (this.ended || this.callStart === null) return;
        const { durationSec, usage, costMicros } = this.figures();
        await this.db.update(voiceSessions).set({ durationSec, usage, costMicros }).where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "live")));
      });
    });
  }

  private async checkEndedExternally() {
    const [row] = await this.db.select({ status: voiceSessions.status, endReason: voiceSessions.endReason }).from(voiceSessions).where(eq(voiceSessions.id, this.sessionId));
    if (row?.status !== "ended" || this.ended) return;
    this.endedExternally = true;
    void this.stop(row.endReason ?? "user_hangup", undefined, "ended_elsewhere");
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const h = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      p.then((v) => { clearTimeout(h); resolve(v); }, (e) => { clearTimeout(h); reject(e); });
    });
  }

  private async finish(reason: VoiceEndReason) {
    // A chat turn still running stores its reply first (it is not spoken), so the end line comes after it.
    if (this.running) {
      try {
        await this.withTimeout(this.running, TURN_FINISH_TIMEOUT_MS);
      } catch (e) {
        this.log.warn(voiceLine(this.sessionId, `pipeline turn still running at the end: ${errorSummary(e)}`));
      }
    }
    const endDetail: VoiceEndDetail = {
      by: this.endBy ?? BY_REASON[reason] ?? "error",
      ...(this.clientClose ? { clientClose: this.clientClose } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
    const f = this.figures(endDetail);
    const p = (f.usage as VoiceUsage & { pipeline: PipelineUsage }).pipeline;
    const ms = (v: number | null) => (v === null ? "-" : `${v}ms`);
    this.log.info(voiceLine(this.sessionId, `trace t=${this.offsetMs()} pipeline summary turns=${p.turns} median answer=${ms(p.medianAnswerMs)} listen=${ms(p.medianListenMs)} think=${ms(p.medianThinkMs)} speak=${ms(p.medianSpeakMs)} chars=${p.spokenChars} listenSec=${p.listenSec} bargeIns=${p.bargeIns} costMicros=${f.costMicros} (listen ${p.listenCostMicros} + speak ${p.speakCostMicros}; thinking is on the chat rows)`));
    this.log.info(voiceLine(this.sessionId, `ended reason=${reason} code=${this.errorCode ?? "-"} durationSec=${f.durationSec} by=${endDetail.by}${this.clientClose ? ` client=${this.clientClose.code ?? "-"}/"${this.clientClose.reason}"` : ""} engine=${PIPELINE_ENGINE}`));
    const set = { status: "ended" as const, endedAt: new Date(this.clock.now()), endReason: reason, errorCode: this.errorCode, durationSec: f.durationSec, usage: f.usage, costMicros: f.costMicros, answerMsAvg: f.answerMsAvg };
    const where = this.endedExternally
      ? and(eq(voiceSessions.id, this.sessionId), sql`coalesce(${voiceSessions.usage}->'endDetail'->>'by', '') <> 'relay_gone'`)
      : and(eq(voiceSessions.id, this.sessionId), ne(voiceSessions.status, "ended"));
    let ended = false;
    for (let attempt = 1; attempt <= 2 && !ended; attempt++) {
      try {
        const rows = await this.withTimeout(this.db.update(voiceSessions).set(set).where(where).returning({ id: voiceSessions.id }), FINAL_WRITE_TIMEOUT_MS);
        ended = rows.length > 0;
        if (!ended) break;
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `final row write failed (attempt ${attempt} of 2): ${errorSummary(e)}`));
      }
    }
    if (ended && this.callStart !== null && this.loaded) {
      try {
        await this.db.insert(messages).values({
          accountId: this.loaded.account.id, conversationId: this.loaded.conv.id, actor: "system", body: voiceCallEndedLine(f.durationSec), language: "en", createdAt: await this.stamp(),
        });
      } catch (e) {
        (this.log.error ?? this.log.warn).call(this.log, voiceLine(this.sessionId, `could not store the end line: ${errorSummary(e)}`));
      }
    }
    this.send({ t: "ended", reason, durationSec: f.durationSec, costMicros: f.costMicros, answerMsAvg: f.answerMsAvg });
    this.state = null;
    this.setState("ended");
  }
}

/** A speech stream consumed into a buffer as soon as it starts (the next sentence synthesizes while this one plays). */
type Prefetch = { chunks(): AsyncIterable<Uint8Array>; stop(): void };

function prefetch(source: AsyncIterable<Uint8Array>): Prefetch {
  const buf: Uint8Array[] = [];
  let done = false;
  let error: unknown = null;
  let stopped = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  void (async () => {
    try {
      for await (const c of source) {
        if (stopped) break;
        buf.push(c);
        notify();
      }
    } catch (e) {
      error = e;
    } finally {
      done = true;
      notify();
    }
  })();
  return {
    async *chunks() {
      for (;;) {
        if (buf.length) {
          yield buf.shift()!;
          continue;
        }
        if (error) throw error;
        if (done || stopped) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    stop() {
      stopped = true;
      notify();
    },
  };
}
