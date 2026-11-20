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
import { and, eq, exists, ne } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, leads, messages, sellerAccounts, toolCalls, voiceSessions,
  type AgentVersion, type Conversation, type Lead, type SellerAccount, type VoiceEndReason, type VoiceSession,
} from "@/db/schema";
import { readDealState } from "@/lib/agent/service";
import { runTool, type ToolContext, type ToolResult, type TurnMemo } from "@/lib/agent/tools";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { voiceStageText, voiceToolResultMessage } from "@/lib/agent/core/voice";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { RealtimeUsageAccumulator, voiceCallCost, type VoiceCallUsageRecord } from "@/lib/ai/models";
import type { ServerMessage, VoiceErrorCode, VoiceState } from "./protocol";
import { systemClock, type Clock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig, type TimerHandle } from "./realtime";
import { isSpokenOptOut, maskCardNumbers, maskPartialDigits } from "./safety";
import { loadVoiceInstructions, RECAP_LINES, type TranscriptLine } from "./instructions";
import { maxCallSeconds, resolveVoiceSettings, turnTakingFor } from "./settings";
import { realtimeTools, schemaFamilyOf, toolLabel, VOICE_TOOL_NAMES } from "./tool-schema";
import { FormContextNotes } from "./form-context";

/** Timings of a call. Defaults are the product's; tests shorten them. */
export type VoiceLimits = {
  /** Seconds left in the hosting function: the call ends before it. */
  deadlineSec?: number | null;
  /** Env for VOICE_MAX_CALL_SECONDS (default process.env). */
  env?: Record<string, string | undefined>;
  /** Warn this many seconds before the time limit. */
  limitWarnSec?: number;
  /** Quiet buyer after the agent finished: ask once after this… */
  silenceAskMs?: number;
  /** …and end the call this long after asking. */
  silenceEndMs?: number;
  /** One reconnect must succeed within this. */
  reconnectMs?: number;
  /** After a hand-off or opt-out, the agent may finish its sentence for this long. */
  endGraceMs?: number;
  /** How often `{t:'stats'}` goes out. */
  statsEveryMs?: number;
};

const DEFAULTS = { limitWarnSec: 45, silenceAskMs: 25_000, silenceEndMs: 20_000, reconnectMs: 8_000, endGraceMs: 6_000, statsEveryMs: 5_000 };

export type VoiceEngineDeps = {
  db: Db;
  model: RealtimeModel;
  sessionId: string;
  /** To the browser: a protocol message (JSON) or agent audio (binary, PCM16 24 kHz). */
  send: (msg: ServerMessage | Uint8Array) => void;
  clock?: Clock;
  limits?: VoiceLimits;
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
type StoredLine = { messageId: string; turnId: string; raw: string; cut: boolean; tools: number; startMs: number };

/** Text compared for "the same line": lower case, words only. */
export const normLine = (s: string) => s.toLowerCase().replace(/…/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
/** `longer` starts with `shorter` (normalised, whole words), and `shorter` has at least two words. */
export function startsWithLine(longer: string, shorter: string): boolean {
  const a = normLine(longer);
  const b = normLine(shorter);
  return b.split(" ").length >= 2 && (a === b || a.startsWith(`${b} `));
}
/** A line the buyer cut short, as stored: the words actually said, ending with "…". */
export const cutLine = (s: string) => `${s.trim().replace(/[\s,;:–—-]+$/u, "")}…`;

type Loaded = { session: VoiceSession; conv: Conversation; lead: Lead; version: AgentVersion; account: SellerAccount };

/** The engine's closing system note, "Voice call ended · m:ss" (exported for the demo seeds). */
export const CALL_ENDED_TEXT = (sec: number) => `Voice call ended · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export class VoiceEngine {
  private readonly db: Db;
  private readonly model: RealtimeModel;
  private readonly clock: Clock;
  private readonly limits: Required<Omit<VoiceLimits, "deadlineSec" | "env">> & Pick<VoiceLimits, "deadlineSec" | "env">;
  private readonly out: (msg: ServerMessage | Uint8Array) => void;
  readonly sessionId: string;

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
  /** Tool calls of a turn that said nothing yet (cut before its first word), for the next line. */
  private carriedTools: ToolRun[] = [];
  /** Usage snapshots, totalled whether the provider reports them per session or per turn. */
  private usageAcc = new RealtimeUsageAccumulator();
  private providerSessionId: string | null = null;
  private pendingEnd: VoiceEndReason | null = null;
  private optedOut = false;
  private reconnectUsed = false;
  private reconnecting = false;
  private silenceChecked = false;
  private lastStamp = 0;
  private errorCode: VoiceErrorCode | null = null;
  private timers: Record<"warn" | "limit" | "silenceAsk" | "silenceEnd" | "grace" | "stats" | "reconnect", TimerHandle | null> = {
    warn: null, limit: null, silenceAsk: null, silenceEnd: null, grace: null, stats: null, reconnect: null,
  };

  constructor(deps: VoiceEngineDeps) {
    this.db = deps.db;
    this.model = deps.model;
    this.clock = deps.clock ?? systemClock;
    this.out = deps.send;
    this.sessionId = deps.sessionId;
    this.limits = { ...DEFAULTS, ...deps.limits };
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

  /** The order form open in another tab (lib/voice/form-context.ts): a quiet note to the model, throttled, never answered aloud. */
  private formNotes: FormContextNotes | null = null;
  private onFormContext(msg: Extract<import("./protocol").ClientMessage, { t: "context" }>): void {
    this.formNotes ??= new FormContextNotes(this.clock, (note) => {
      if (!this.ended && !this.reconnecting) this.conn?.sendNote?.(note);
    });
    this.formNotes.push({ step: msg.step, event: msg.event });
  }

  onClientAudio(bytes: Uint8Array): void {
    if (this.ended || this.muted || !this.conn || this.reconnecting) return;
    this.conn.sendAudio(bytes);
  }

  /** The browser's socket dropped: the call ends now (never keep a paid model socket open). */
  onClientGone(): void {
    void this.stop("connection_lost");
  }

  /** Ends the call. Idempotent: a second call returns the first one's promise. */
  stop(reason: VoiceEndReason, code?: VoiceErrorCode): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ended = true;
    if (code) this.errorCode = code;
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) {
      this.clock.clearTimeout(this.timers[k]);
      this.timers[k] = null;
    }
    this.closeModel();
    this.stopping = this.enqueue(() => this.finish(reason), true);
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
    const run = async () => {
      if (this.ended && !evenIfEnded) return;
      await fn();
    };
    const p = this.queue.then(run).catch((e) => {
      console.error("[voice] engine error", e);
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

  /** Cost so far, from the latest usage snapshot (0 for the scripted model). */
  private costSoFar(): number {
    if (this.model.mode === "scripted" || this.callStart === null) return 0;
    return voiceCallCost(this.model.modelId, this.usageAcc, Math.round(this.offsetMs() / 1000)).costMicros;
  }

  private sendStats() {
    this.send({ t: "stats", durationSec: Math.round(this.offsetMs() / 1000), costMicros: this.costSoFar(), answerMsAvg: this.answerMsAvg() });
  }

  private statsLoop() {
    this.timer("stats", this.limits.statsEveryMs, () => {
      this.sendStats();
      this.statsLoop();
      void this.enqueue(() => this.checkEndedExternally());
    });
  }

  /** On each stats tick: a session row ended elsewhere ("End that call") stops this call. */
  private async checkEndedExternally() {
    const [row] = await this.db.select({ status: voiceSessions.status, endReason: voiceSessions.endReason }).from(voiceSessions)
      .where(eq(voiceSessions.id, this.sessionId));
    if (row?.status !== "ended" || this.ended) return;
    this.endedExternally = true;
    void this.stop(row.endReason ?? "user_hangup");
  }

  private fail(reason: VoiceEndReason, code: VoiceErrorCode) {
    this.errorCode = code;
    this.send({ t: "error", code });
    void this.stop(reason, code);
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
      if (await spendCapped(this.db, accountId)) return this.fail("budget", "spend_cap");
      if ((await platformBudget(this.db)).exceeded) return this.fail("budget", "platform_budget");
    }
    this.loaded = { session, conv, lead, version, account };
    this.maxSec = maxCallSeconds({ settings: version.voiceSettings, deadlineSec: this.limits.deadlineSec, env: this.limits.env });
    this.agentMessages = (await this.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "agent")))).length;

    const ctx = await loadVoiceInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) });
    const gen = ++this.gen;
    let conn: RealtimeConnection;
    try {
      conn = await this.model.connect(this.sessionConfig(ctx.instructions), (e) => this.onModelEvent(e, gen));
    } catch (e) {
      console.error("[voice] model connect failed", e);
      return this.fail("error", "model_unavailable");
    }
    if (this.ended || gen !== this.gen) {
      conn.close();
      return;
    }
    this.conn = conn;
    this.callStart = this.clock.now();
    await this.db.update(voiceSessions)
      .set({ status: "live", connectedAt: new Date(this.callStart), model: this.model.modelId, mode: this.model.mode, settings: { ...version.voiceSettings, maxCallSec: this.maxSec } })
      .where(and(eq(voiceSessions.id, this.sessionId), eq(voiceSessions.status, "pending")));
    // Limits: an announcement before the end, then the end.
    if (this.maxSec > this.limits.limitWarnSec) this.timer("warn", (this.maxSec - this.limits.limitWarnSec) * 1000, () => this.warnLimit());
    this.timer("limit", this.maxSec * 1000, () => void this.stop("limit"));
    this.statsLoop();
    this.setState("listening");
    // The agent speaks first: the chat's opener, in its voice.
    // A call that continues a chat starts with the short disclosure line instead (lib/voice/instructions.ts).
    this.conn.requestResponse(ctx.openerPrompt);
  }

  private sessionConfig(instructions: string): RealtimeSessionConfig {
    const version = this.loaded!.version;
    const settings = resolveVoiceSettings(version.voiceSettings);
    const family = schemaFamilyOf(this.model.modelId);
    const tt = turnTakingFor(settings.style, this.model.modelId);
    return {
      instructions, tools: realtimeTools(family), language: "en", toolBehavior: "blocking", pace: settings.pace,
      ...(settings.voice ? { voice: settings.voice } : {}),
      ...(tt ? { turnTaking: tt } : {}),
      scenario: this.loaded!.conv.scenario,
    };
  }

  private warnLimit() {
    this.send({ t: "notice", kind: "limit_soon" });
    this.conn?.requestResponse("The call is close to its time limit. Tell the buyer the call is about to end and offer to continue in the chat.");
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
        this.agentSpeaking = true;
        this.clearSilence();
        this.setState("speaking");
        this.send(e.pcm);
        return;
      }
      case "agent-transcript": {
        const fresh = !this.agentTurn || !this.agentTurn.text;
        const turn = this.ensureAgentTurn();
        turn.awaitingContinuation = false;
        turn.text = maskCardNumbers(e.text).text;
        if (e.final) turn.finalText = true;
        // The model resumes (or re-says) the line the buyer cut: the live transcript keeps it on one line.
        const last = this.lastLine;
        if (fresh && last?.cut && (startsWithLine(turn.text, last.raw) || startsWithLine(last.raw, turn.text))) turn.id = last.turnId;
        if (!e.final) this.send({ t: "transcript", id: turn.id, role: "agent", text: maskPartialDigits(turn.text), final: false, atMs: turn.startMs });
        return;
      }
      case "buyer-transcript": {
        this.buyerActivity();
        if (!this.buyerTurn) this.buyerTurn = { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
        if (e.final) {
          void this.enqueue(() => this.handleBuyerFinal(e.text, false));
        } else {
          this.send({ t: "transcript", id: this.buyerTurn.id, role: "buyer", text: maskPartialDigits(e.text), final: false, atMs: this.buyerTurn.startMs });
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
        void this.enqueue(() => this.reconnect());
        return;
      case "closed":
        void this.enqueue(() => this.reconnect());
        return;
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

  /** The buyer spoke or typed: the silence checks start over. */
  private buyerActivity() {
    this.clearSilence();
    this.silenceChecked = false;
  }

  private clearSilence() {
    this.clearTimer("silenceAsk");
    if (!this.silenceChecked) this.clearTimer("silenceEnd");
  }

  private startSilence() {
    if (this.ended || this.pendingEnd) return;
    if (this.silenceChecked) return; // already asked: the end timer runs
    this.timer("silenceAsk", this.limits.silenceAskMs, () => {
      this.silenceChecked = true;
      this.send({ t: "notice", kind: "silence_check" });
      this.conn?.requestResponse("The buyer has been quiet for a while. Ask once, briefly, whether they are still there.");
      this.timer("silenceEnd", this.limits.silenceEndMs, () => void this.stop("silence"));
    });
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
      this.agentSpeaking = false;
    }
    // What the agent said before this buyer turn is stored first, so the thread keeps its order.
    await this.finalizeAgentTurn("buyer");
    const turn = this.buyerTurn ?? { id: `b${++this.turnSeq}`, startMs: this.offsetMs() };
    this.buyerTurn = null;
    await this.db.insert(messages).values({
      accountId: account.id, conversationId: conv.id, actor: "buyer", body: masked.text, language: conv.language,
      voiceSessionId: this.sessionId, spokenAtMs: turn.startMs, typedInCall: typed, createdAt: await this.stamp(),
    });
    this.lines.push({ role: "buyer", text: masked.text });
    this.send({ t: "transcript", id: turn.id, role: "buyer", text: masked.text, final: true, atMs: turn.startMs, ...(typed ? { typed: true as const } : {}) });
    this.buyerEndedAt = this.clock.now();
    this.buyerActivity();
    if (!this.conn) return;
    // A person took the conversation over during the call: the agent stops (the buyer's words are kept).
    const [now] = await this.db.select({ status: conversations.status, takenOverByUserId: conversations.takenOverByUserId }).from(conversations)
      .where(and(eq(conversations.id, conv.id), eq(conversations.accountId, account.id)));
    if (now?.status === "human" && !this.pendingEnd) {
      void this.stop(now.takenOverByUserId ? "take_over" : "handoff");
      return;
    }
    if (isSpokenOptOut(masked.text)) {
      await this.codeOptOut(masked.text);
    } else if (masked.found) {
      // Card details never belong in a call: the fixed security reply, as in chat.
      this.conn.requestResponse(`The buyer started reading out a card number. Stop them politely and say exactly this and nothing else: "${CARD_REPLY.en}"`);
    } else if (typed) {
      this.conn.sendText(masked.text);
    }
  }

  /** The buyer opted out in words the code recognises: the same effect as the record_opt_out tool. */
  private async codeOptOut(said: string) {
    if (this.optedOut) return;
    const turn = this.ensureAgentTurn();
    const r = await this.runRecorded(turn, `optout-${this.turnSeq}`, "record_opt_out", { reason: said.slice(0, 200) });
    if (r.outcome !== "ok") return;
    this.afterOptOut();
    this.conn?.requestResponse(`The buyer asked not to be contacted again and is now opted out. Say exactly this and nothing else: "${OPT_OUT_REPLY.en}"`);
  }

  private afterOptOut() {
    this.optedOut = true;
    this.endSoon("opt_out");
  }

  /** The call ends once the agent finishes its sentence, at most endGraceMs from now. */
  private endSoon(reason: VoiceEndReason) {
    this.pendingEnd = reason;
    this.clearSilence();
    this.clearTimer("silenceEnd");
    this.timer("grace", this.limits.endGraceMs, () => void this.stop(reason));
  }

  private async runRecorded(turn: AgentTurn, callId: string, name: string, args: unknown): Promise<ToolResult> {
    let r: ToolResult;
    await this.stamp(); // rows the tool writes come after everything stored so far
    if (!VOICE_TOOL_NAMES.has(name)) {
      r = { outcome: "failed", result: { ok: false, error: `Unknown tool ${name}` } };
    } else {
      try {
        r = await runTool(name, args, this.toolCtx(callId, turn.memo));
      } catch (e) {
        console.error(`[voice] tool ${name} failed`, e);
        r = { outcome: "failed", result: { ok: false, error: "The tool failed. Tell the buyer you will check and get back to them." } };
      }
    }
    turn.tools.push({ name, input: args, r });
    return r;
  }

  private async handleTool(callId: string, name: string, args: unknown) {
    if (this.ended || !this.loaded) return;
    const turn = this.ensureAgentTurn();
    const label = toolLabel(name);
    this.setState("checking");
    this.send({ t: "tool", id: callId, name, label, status: "running" });
    const r = await this.runRecorded(turn, callId, name, args);
    let forModel: Record<string, unknown> = r.result;
    if (r.outcome === "ok") {
      if (name === "create_quote" && typeof r.result.quote_message_id === "string") this.send({ t: "message", messageId: r.result.quote_message_id });
      if (name === "send_order_form" && typeof r.result.link === "string") {
        // The link goes into the chat; the model is told it is there and never reads it out.
        const id = await this.storeAppMessage(`Your order form: ${r.result.link}`);
        this.send({ t: "message", messageId: id });
        forModel = {
          ...r.result, link: "shown in the chat",
          message: "The order form link is in the chat. Say so in one short sentence, with what the buyer does there: fill in their company details, sign and pay. Never read the link aloud.",
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
    }
    // Every result message in call wording ("confirm it here" → "by message", …).
    if (typeof forModel.message === "string") forModel = { ...forModel, message: voiceToolResultMessage(forModel.message) };
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
    if (this.pendingEnd) {
      void this.stop(this.pendingEnd);
      return;
    }
    this.setState("listening");
    this.startSilence();
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
    const resumes = !!last && last.cut && !!raw && startsWithLine(raw, last.raw);
    const repeatsCut = !!last && cut && !resumes && startsWithLine(last.raw, raw);
    if (last && (resumes || repeatsCut)) {
      // Resumed after the cut: the earlier row becomes the whole line. A cut copy of the line just said adds nothing.
      const now = await this.stamp();
      const newBody = resumes ? body : (last.cut ? cutLine(last.raw) : last.raw);
      await atomic(this.db, (q) => [
        ...(resumes ? [q.update(messages).set({ body: newBody }).where(and(eq(messages.id, last.messageId), eq(messages.accountId, account.id)))] : []),
        ...(turn.tools.length ? [q.insert(toolCalls).values(toolRows(last.messageId, last.tools))] : []),
        q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, account.id))),
      ]);
      this.lastLine = resumes ? { ...last, raw, cut, tools: last.tools + turn.tools.length } : { ...last, tools: last.tools + turn.tools.length };
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
        id: messageId, accountId: account.id, conversationId: conv.id, actor: "agent", body, language: conv.language, agentVersionId: version.id,
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
    if (raw) this.lastLine = { messageId, turnId: turn.id, raw, cut, tools: turn.tools.length, startMs: turn.startMs };
    if (body) this.lines.push({ role: "agent", text: body });
    this.send({ t: "transcript", id: turn.id, role: "agent", text: body, final: true, atMs: turn.startMs });
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  /** The provider is going away or dropped: ONE fresh connection within reconnectMs, with a recap; else the call ends. */
  private async reconnect() {
    if (this.ended || this.reconnecting || !this.loaded) return;
    if (this.reconnectUsed) {
      this.fail("connection_lost", "connection_lost");
      return;
    }
    this.reconnectUsed = true;
    this.reconnecting = true;
    this.setState("reconnecting");
    this.closeModel();
    await this.finalizeAgentTurn("stop");
    this.agentSpeaking = false;
    const { account, version, conv, lead } = this.loaded;
    const gen = this.gen;
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => this.timer("reconnect", this.limits.reconnectMs, () => { timedOut = true; resolve(null); }));
    const attempt = (async () => {
      const deal = await readDealState(this.db, account.id, conv.leadId);
      const ctx = await loadVoiceInstructions(this.db, { account, version, conv, lead, deal, now: new Date(this.clock.now()) }, {
        recap: this.lines.slice(-RECAP_LINES), resumed: true,
      });
      return this.model.connect(this.sessionConfig(ctx.instructions), (e) => this.onModelEvent(e, gen));
    })().catch((e) => {
      console.error("[voice] reconnect failed", e);
      return null;
    });
    const conn = await Promise.race([attempt, timeout]);
    this.clearTimer("reconnect");
    if (!conn || timedOut || this.ended || gen !== this.gen) {
      // A connection that opens after the deadline is closed at once.
      void attempt.then((late) => late?.close());
      this.reconnecting = false;
      if (!this.ended) this.fail("connection_lost", "connection_lost");
      return;
    }
    this.conn = conn;
    this.reconnecting = false;
    this.setState("listening");
  }

  // -------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------

  private async finish(reason: VoiceEndReason) {
    try {
      await this.finalizeAgentTurn("stop");
      // Tool calls still waiting for a line go with the call's last line.
      if (this.carriedTools.length) {
        this.ensureAgentTurn();
        await this.finalizeAgentTurn("stop");
      }
    } catch (e) {
      console.error("[voice] could not store the last turn", e);
    }
    const connected = this.callStart !== null;
    const durationSec = connected ? Math.round(this.offsetMs() / 1000) : 0;
    // Live: the larger of the usage-based and the duration-based cost, both kept with the basis (never undercounted).
    // Scripted: always 0; the fake counts are kept with basis "none".
    let usage: VoiceCallUsageRecord | null = null;
    let costMicros = 0;
    if (this.model.mode === "live" && connected) {
      ({ costMicros, usage } = voiceCallCost(this.model.modelId, this.usageAcc, durationSec));
    } else if (this.usageAcc.events > 0) {
      const a = this.usageAcc;
      usage = { ...a.total, usageCostMicros: 0, durationCostMicros: 0, basis: "none", usageEvents: a.events, firstSnapshot: a.first, lastSnapshot: a.last };
    }
    const answerMsAvg = this.answerMsAvg();
    await this.db.update(voiceSessions).set({
      status: "ended", endedAt: new Date(this.clock.now()), endReason: reason, errorCode: this.errorCode, durationSec,
      usage, costMicros, answerMsAvg, providerSessionId: this.providerSessionId,
    }).where(this.endedExternally ? eq(voiceSessions.id, this.sessionId) : and(eq(voiceSessions.id, this.sessionId), ne(voiceSessions.status, "ended")));
    if (connected && this.loaded) {
      // Like the other operational notes in a thread (system messages): when and how long.
      const { conv, account } = this.loaded;
      await this.db.insert(messages).values({
        accountId: account.id, conversationId: conv.id, actor: "system", body: CALL_ENDED_TEXT(durationSec), language: "en", createdAt: await this.stamp(),
      });
    }
    this.send({ t: "ended", reason, durationSec, costMicros, answerMsAvg });
    this.state = null;
    this.setState("ended");
  }
}
