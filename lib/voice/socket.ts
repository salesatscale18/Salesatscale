/**
 * The voice relay's socket side (live voice): one browser WebSocket ⇄ one
 * VoiceEngine. Transport-agnostic: it takes any socket with the small
 * interface below, so the Vercel route (`upgradeWebSocket`), the local dev
 * server (`scripts/voice-dev-server.ts`, a plain `ws` server) and the unit
 * tests (a fake socket) all run the same code. Server-only.
 *
 * Flow: the first frame must be `{t:'auth', sessionId, ticket}` within
 * AUTH_TIMEOUT_MS. The ticket is single-use and short-lived (lib/voice/service.ts),
 * created by a server action after the normal sign-in and role checks: it is
 * the only credential this socket takes. Then text frames are protocol
 * messages for the engine and binary frames are mic audio (PCM16 24 kHz).
 * Whatever happens (bad frames, a dropped socket, a failing engine), the
 * handlers never throw and the engine is always stopped, so a paid model
 * socket is never left open.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, conversations, type VoiceSession } from "@/db/schema";
import { VoiceEngine, type VoiceLimits } from "./engine";
import {
  AUTH_TIMEOUT_MS, MAX_CLIENT_AUDIO_BYTES, VOICE_CLOSE, VOICE_SAMPLE_RATE, parseAuthMessage, parseClientMessage, pcmDurationMs,
  type ClientMessage, type ServerMessage, type VoiceErrorCode,
} from "./protocol";
import { systemClock, type Clock, type RealtimeModel, type TimerHandle } from "./realtime";
import { endUnstartedVoiceSession, realtimeModelFor, redeemVoiceTicket } from "./service";
import type { WrittenOpenerFn } from "./written-opener";
import { maxCallSeconds, resolveVoiceSettings, voiceMode, type VoiceMode } from "./settings";
import { clip, consoleVoiceLog, errorSummary, voiceLine, type VoiceLog } from "./log";
import { ClassicVoiceEngine, classicRealtimeModelFor, sessionEngine } from "@/lib/voice-classic";
import { GUARDED_PROFILE, GUARDED_SILENT_PROFILE } from "@/lib/voice-guarded/profile";
import { BUYER_VOICE_ENGINE, GUARDED_SILENT_ENGINE, isGuardedEngine, isPipelineEngine, isRtElevenEngine, type PipelineEngineName, type VoiceEngineName } from "@/lib/voice-classic/engine-choice";
import { PipelineVoiceEngine, pipelinePartsFor, type PipelineOverrides, type PipelineParts } from "@/lib/voice-pipeline";
import type { Speaker } from "@/lib/voice-pipeline/speaker";
import { rtElevenProfile, rtElevenSpeakerFor } from "@/lib/voice-rt-eleven";
import { speechFor, speechIgnoredLine } from "@/lib/voice-rt-eleven/rule";
import { elevenAppliedOf } from "@/lib/voice-rt-eleven/speaker";
import { storeElevenApplied } from "@/lib/voice-rt-eleven/applied-store";
import { DEFAULT_ELEVEN_CHOICE, ELEVEN_PACE_SPEED_FOR_BUYER_CALLS, elevenSpeedFor, type ElevenChoice } from "@/lib/voice-rt-eleven/catalog";

/**
 * What the relay needs from an engine: today's VoiceEngine, the Classic (20 Nov) one a test-lab call picked, or the
 * pipeline proof (lib/voice-pipeline/engine.ts PipelineVoiceEngine, which implements the same methods).
 */
type RelayEngine = Pick<VoiceEngine, "sessionId" | "start" | "onClientMessage" | "onClientAudio" | "onClientGone" | "stop">;

/**
 * The engine a call runs on (one engine for every call, owner 26 Nov 2026). A buyer call: BUYER_VOICE_ENGINE, never
 * read from the row. A test call: the engine its start stored on the session (lib/voice/service.ts createVoiceSession,
 * written by the server moments before from labEngineChoice: BUYER_VOICE_ENGINE while LAB_ENGINE_SELECTOR is off; a
 * row with no engine stored is "current", which only a start with the select on can write).
 */
export function callEngineOf(session: Pick<VoiceSession, "isTest" | "settings">): VoiceEngineName {
  return session.isTest ? sessionEngine(session.settings) : BUYER_VOICE_ENGINE;
}

/** The part of a `ws` WebSocket the relay uses (a `ws` socket satisfies it). */
export interface VoiceSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // Listener arguments differ per event ('message': data and isBinary); `ws` declares them loosely too.
  on(event: "message" | "close" | "error" | "pong", listener: (...args: any[]) => void): unknown;
  /** Bytes queued but not yet sent (the backpressure signal). */
  readonly bufferedAmount: number;
  /** Protocol-level ping, where the socket has one. */
  ping?(): void;
}

/**
 * Agent audio queued beyond this is dropped (about 3 seconds at 24 kHz PCM16):
 * a slow connection then skips audio instead of the call falling behind.
 * JSON frames are never dropped.
 */
export const MAX_BUFFERED_AUDIO_BYTES = VOICE_SAMPLE_RATE * 2 * 3;
/** A browser that sends nothing (audio, ping, pong) for this long is gone. */
export const IDLE_TIMEOUT_MS = 45_000;
/** Protocol pings, so proxies keep the socket open and a dead peer is noticed. */
export const PING_EVERY_MS = 15_000;
/** Mic audio accepted per second of call, at most (twice real time): extra frames are dropped. */
export const MAX_AUDIO_RATE = 2;
/** Text frames buffered while the ticket is being checked. */
const MAX_EARLY_MESSAGES = 20;

export type VoiceSocketOptions = {
  db: Db;
  /** Seconds left in the hosting function (the Vercel route); null when there is no deadline (local dev server). */
  deadlineSec: number | null;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** Tests: the model to use instead of the one for the current mode. */
  model?: RealtimeModel;
  /** Tests: shorter engine timings. */
  limits?: Omit<VoiceLimits, "deadlineSec" | "env">;
  /** Tests: the pipeline engines' fakes (listener, speaker, chat model, chat turn, gateway client factory). */
  pipeline?: PipelineOverrides;
  /** Tests: the ElevenLabs speaker of a text-output call (default: ScriptedSpeaker when scripted, the Gateway chain when live). */
  rtSpeaker?: Speaker;
  /**
   * Runs once the call is stored, before the handler resolves (so the function stays alive for it):
   * the route answers a buyer turn the call left unanswered (lib/voice/after-call.ts). Never awaited past its own errors.
   */
  afterCall?: (sessionId: string) => Promise<unknown>;
  /** One-line operational logs (default: console). */
  log?: VoiceLog;
  /**
   * Keeps the host running until `work` settles (the Vercel route: `waitUntil`): the call's end (its row, last
   * turn, end line) and the after-call step are registered the moment the end starts, so they finish even when the
   * platform would otherwise stop or freeze the function once the browser's socket is gone.
   */
  keepAlive?: (work: Promise<unknown>) => void;
  /** Tests: the written opener after a call that said nothing (default lib/chat/start.ts ensureWrittenOpenerUnlessCall; lib/voice/written-opener.ts). */
  writtenOpener?: WrittenOpenerFn;
};

/** Raw `ws` message data as bytes (Buffer is a Uint8Array; a fragmented frame is a Buffer[]). */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) {
    const parts = data as Uint8Array[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
  return null;
}

function toText(data: unknown, isBinary: boolean): string | null {
  if (typeof data === "string") return data;
  if (isBinary) return null;
  const b = toBytes(data);
  return b ? new TextDecoder().decode(b) : null;
}

/**
 * Runs one voice call over a socket. Resolves when the socket has closed and
 * the engine (if one started) has stored the call. Never rejects.
 */
export function handleVoiceSocket(ws: VoiceSocket, opts: VoiceSocketOptions): Promise<void> {
  const clock = opts.clock ?? systemClock;
  /** Registers end-of-call work with the host; a host without the hook (local server, tests) runs it anyway. */
  const keepAlive = (work: Promise<unknown>) => {
    try {
      opts.keepAlive?.(work);
    } catch {
      // The host cannot extend its lifetime here: the work still runs.
    }
  };
  const env = opts.env ?? process.env;
  const log = opts.log ?? consoleVoiceLog;
  /** The session this socket carries, once the ticket was accepted (logs). */
  let sessionId: string | null = null;
  /** Agent audio not sent because the browser's socket was too far behind (backpressure). */
  let droppedAgentBytes = 0;
  /** The browser socket's close code and reason, and whether we closed it for silence. */
  let clientClose: { code: number | null; reason: string; idle?: boolean } | null = null;
  let phase: "auth" | "checking" | "live" | "closed" = "auth";
  let engine: RelayEngine | null = null;
  /** A call where ElevenLabs speaks: stores what its speech used, once the engine has stored the call. */
  let storeSpeech: (() => Promise<void>) | null = null;
  let early: ClientMessage[] = [];
  /**
   * A held greeting (auth `holdGreeting`, the lead page hand-over): since when (the auth frame) and when the page's
   * `ready` released it; logged once the call is accepted ("greeting held: …", then "greeting released after …").
   */
  let hold: { since: number; releasedAt: number | null; accepted: boolean; logged: boolean } | null = null;
  const logRelease = () => {
    if (!hold || hold.logged || !hold.accepted || hold.releasedAt === null) return;
    hold.logged = true;
    log.info(voiceLine(sessionId, `greeting released after ${Math.max(0, Math.round(hold.releasedAt - hold.since))}ms held`));
  };
  /** A `ready` from the page: with a hold, that is the release (the first one counts). */
  const noteReady = (msg: ClientMessage) => {
    if (msg.t !== "ready" || !hold || hold.releasedAt !== null) return;
    hold.releasedAt = clock.now();
    logRelease();
  };
  let lastSeen = clock.now();
  let audioBudget = { at: clock.now(), tokens: MAX_CLIENT_AUDIO_BYTES * MAX_AUDIO_RATE };
  const timers: { auth: TimerHandle | null; ping: TimerHandle | null; hard: TimerHandle | null } = { auth: null, ping: null, hard: null };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const safeSend = (data: string | Uint8Array) => {
    if (phase === "closed") return;
    try {
      ws.send(data);
    } catch (e) {
      console.error("[voice] socket send failed", e);
    }
  };
  const sendJson = (msg: ServerMessage) => safeSend(JSON.stringify(msg));
  // Read through a function: the socket's handlers change the phase while authentication awaits.
  const isClosed = () => phase === "closed";

  const clearTimers = () => {
    for (const k of Object.keys(timers) as (keyof typeof timers)[]) {
      clock.clearTimeout(timers[k]);
      timers[k] = null;
    }
  };

  const closeSocket = (code: number, reason: string) => {
    if (phase === "closed") return;
    try {
      ws.close(code, reason);
    } catch (e) {
      console.error("[voice] socket close failed", e);
    }
  };

  const refuse = (code: VoiceErrorCode) => {
    sendJson({ t: "error", code });
    closeSocket(VOICE_CLOSE.policy, code);
  };

  /** The socket is gone (closed by either side or errored): stop the engine once. */
  const finish = () => {
    if (phase === "closed") return;
    phase = "closed";
    clearTimers();
    early = [];
    if (droppedAgentBytes) log.warn(voiceLine(sessionId, `agent audio dropped in total: ${Math.round(pcmDurationMs(droppedAgentBytes))} ms`));
    const e = engine;
    if (!e) {
      resolveDone();
      return;
    }
    // The engine ends the call now ("connection_lost" unless it already ended for another reason).
    const work = e.onClientGone(clientClose ?? undefined).catch((err) => log.warn(voiceLine(sessionId, `engine stop failed: ${errorSummary(err)}`)))
      // ElevenLabs spoke: what it used (model, voice, a fallback), merged into the stored settings (the call card).
      .then(() => storeSpeech?.())
      .catch((err) => log.warn(voiceLine(sessionId, `rt speech record failed: ${errorSummary(err)}`)))
      // The call is stored: an unanswered last buyer turn may be answered in the chat now.
      .then(() => opts.afterCall?.(e.sessionId))
      .catch((err) => log.warn(voiceLine(sessionId, `after-call hook failed: ${errorSummary(err)}`)))
      .finally(resolveDone);
    keepAlive(work);
  };

  const pingLoop = () => {
    timers.ping = clock.setTimeout(() => {
      timers.ping = null;
      if (phase === "closed") return;
      if (clock.now() - lastSeen > IDLE_TIMEOUT_MS) {
        log.warn(voiceLine(sessionId, `client silent for ${Math.round((clock.now() - lastSeen) / 1000)}s: closing the socket`));
        clientClose = { code: VOICE_CLOSE.goingAway, reason: "idle (no frames from the browser)", idle: true };
        closeSocket(VOICE_CLOSE.goingAway, "idle");
        finish();
        return;
      }
      try {
        ws.ping?.();
      } catch {
        // A ping on a dying socket: the close event follows.
      }
      pingLoop();
    }, PING_EVERY_MS);
  };

  /** Mic audio within twice real time (a token bucket); anything faster is dropped (never billed to a live model). */
  const audioAllowed = (bytes: number) => {
    const now = clock.now();
    const rate = VOICE_SAMPLE_RATE * 2 * MAX_AUDIO_RATE; // bytes per second
    audioBudget = { at: now, tokens: Math.min(MAX_CLIENT_AUDIO_BYTES * MAX_AUDIO_RATE, audioBudget.tokens + ((now - audioBudget.at) / 1000) * rate) };
    if (bytes > audioBudget.tokens) return false;
    audioBudget.tokens -= bytes;
    return true;
  };

  /**
   * Starts a test-lab call on a pipeline engine ("pipeline": Gemini Flash thinking; "pipeline_lite": Gemini Flash-Lite; "pipeline_chat": the chat model).
   * Scripted mode: fakes and a scripted chat model, never paid. A thinking model that cannot be built refuses the call.
   */
  const startPipeline = async (session: VoiceSession, mode: VoiceMode, waitAudio: boolean, pipelineEngine: PipelineEngineName) => {
    const callMode = mode === session.mode && (mode === "live" || mode === "scripted") ? mode : null;
    // The call's agent version (the engine reads the same one): the session's, else its conversation's.
    const versionId = session.agentVersionId ?? (await opts.db.select({ id: conversations.agentVersionId }).from(conversations)
      .where(and(eq(conversations.id, session.conversationId), eq(conversations.accountId, session.accountId))))[0]?.id;
    const [version] = versionId
      ? await opts.db.select({ voiceSettings: agentVersions.voiceSettings, model: agentVersions.model, effort: agentVersions.effort }).from(agentVersions)
        .where(and(eq(agentVersions.id, versionId), eq(agentVersions.accountId, session.accountId)))
      : [];
    let parts: PipelineParts | null = null;
    try {
      parts = callMode ? await pipelinePartsFor(callMode, env, opts.pipeline, {
        engine: pipelineEngine, version: { model: version?.model ?? "", effort: version?.effort ?? null },
      }) : null;
    } catch (e) {
      log.warn(voiceLine(session.id, `pipeline parts unavailable (engine=${pipelineEngine}): ${errorSummary(e)}`));
    }
    if (!parts || !callMode) {
      await endUnstartedVoiceSession(opts.db, session.id, "model_unavailable", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
      return refuse("model_unavailable");
    }
    if (isClosed()) {
      await endUnstartedVoiceSession(opts.db, session.id, "connection_lost", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
      return;
    }
    const maxSec = maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env });
    sessionId = session.id;
    log.info(voiceLine(session.id, `socket accepted mode=${callMode} engine=${pipelineEngine} think=${parts.thinkModel ?? version?.model ?? "-"} maxSec=${maxSec}${session.isTest ? " test" : ""}`));
    sendJson({ t: "call", maxSec, mode: callMode });
    engine = new PipelineVoiceEngine({
      db: opts.db, sessionId: session.id, mode: callMode, clock, log, onEnding: keepAlive,
      send: (msg: ServerMessage | Uint8Array) => {
        if (msg instanceof Uint8Array) {
          // Backpressure as for the other engines (the pipeline paces its audio, so this should not trigger).
          if (ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
            if (!droppedAgentBytes) log.warn(voiceLine(session.id, "agent audio dropped: the browser's socket is more than 3 s behind"));
            droppedAgentBytes += msg.byteLength;
            return;
          }
          safeSend(msg);
          return;
        }
        sendJson(msg);
        if (msg.t === "ended") clock.setTimeout(() => closeSocket(VOICE_CLOSE.normal, "ended"), 0);
      },
      engine: pipelineEngine, listener: parts.listener, speaker: parts.speaker, llm: parts.llm, ...(parts.turn ? { turn: parts.turn } : {}),
      ...(parts.thinkModel ? { thinkModel: parts.thinkModel } : {}),
      limits: { deadlineSec: opts.deadlineSec, env, ...(waitAudio ? { waitForClientAudio: true } : {}) },
    });
    phase = "live";
    // A last guard beyond the engine's own limit, as for the other engines.
    timers.hard = clock.setTimeout(() => {
      timers.hard = null;
      log.warn(voiceLine(sessionId, "socket hard limit reached"));
      void engine?.stop("limit", undefined, "deadline");
      closeSocket(VOICE_CLOSE.normal, "limit");
    }, (maxSec + 30) * 1000);
    const queued = early;
    early = [];
    await engine.start();
    for (const m of queued) engine.onClientMessage(m);
  };

  const authenticate = async (raw: string) => {
    phase = "checking";
    clock.clearTimeout(timers.auth);
    timers.auth = null;
    const auth = parseAuthMessage(raw);
    if (!auth) return refuse("ticket_invalid");
    if (auth.holdGreeting) hold = { since: clock.now(), releasedAt: null, accepted: false, logged: false };
    const session = await redeemVoiceTicket(opts.db, auth.sessionId, auth.ticket, new Date(clock.now()));
    if (isClosed()) {
      if (session) await endUnstartedVoiceSession(opts.db, session.id, "connection_lost", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
      return;
    }
    if (!session) return refuse("ticket_invalid");
    // The mode the call was created in must still be on (a live call never runs as scripted, or the reverse).
    const mode = voiceMode(env);
    // The engine this call runs on (callEngineOf): a buyer call always BUYER_VOICE_ENGINE (the New engine); a test call
    // the one its start stored on the session (BUYER_VOICE_ENGINE too while the lab select is off).
    const stored = callEngineOf(session);
    // The pipeline engines (lib/voice-pipeline): no realtime model; a listener, the chat turn and a speaker. Retired
    // from the selector and test calls only: they have no held greeting, so a page that asks for one is refused
    // (never a greeting the page did not release).
    if (isPipelineEngine(stored)) {
      if (auth.holdGreeting) {
        log.warn(voiceLine(session.id, `holdGreeting refused: engine=${stored} cannot hold the greeting`));
        await endUnstartedVoiceSession(opts.db, session.id, "model_unavailable", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
        return refuse("model_unavailable");
      }
      return startPipeline(session, mode, auth.waitAudio === true, stored);
    }
    const classic = stored === "classic";
    // The realtime + ElevenLabs engines (lib/voice-rt-eleven): the guarded profile, text output, our speaker.
    const rtEngine = isRtElevenEngine(stored) ? stored : null;
    const rtEleven = rtEngine !== null;
    const guarded = isGuardedEngine(stored) || rtEleven;
    const modelFor = classic ? classicRealtimeModelFor : realtimeModelFor;
    // Transcripts cleaned on every engine (the New engine too since 26 Nov 2026: Current's cleaner, as its profile's
    // `clean`); the mapper's rawTranscripts option is no longer asked for.
    const model = opts.model ?? (mode === session.mode ? await modelFor(mode, { clock, env, modelId: session.model }) : null);
    if (!model) {
      await endUnstartedVoiceSession(opts.db, session.id, "model_unavailable", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
      return refuse("model_unavailable");
    }
    const [version] = session.agentVersionId
      ? await opts.db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
        .where(and(eq(agentVersions.id, session.agentVersionId), eq(agentVersions.accountId, session.accountId)))
      : [];
    if (isClosed()) {
      await endUnstartedVoiceSession(opts.db, session.id, "connection_lost", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
      return;
    }
    const maxSec = maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env });
    // Who speaks (lib/voice-rt-eleven/rule.ts, the one rule): the version's "Voice from" decides, the engine select only
    // the wiring. ElevenLabs runs when the session was created with it (createVoiceSession) and the rule still holds
    // here (a test call, a GPT-Realtime model, not Classic); the retired rt_eleven ids (older sessions) keep their path.
    const resolved = resolveVoiceSettings(version?.voiceSettings, session.model);
    const wanted = resolved.speech;
    // ElevenLabs' speaking model, voice and steadiness (Voice settings › Voice; the defaults on a retired rt_eleven call).
    const choice: ElevenChoice = {
      model: resolved.elevenModel ?? DEFAULT_ELEVEN_CHOICE.model, voice: resolved.elevenVoice ?? DEFAULT_ELEVEN_CHOICE.voice,
      stability: resolved.elevenStability ?? DEFAULT_ELEVEN_CHOICE.stability,
    };
    // The pace as a speaking rate for a plain text-to-speech model (test calls; ELEVEN_PACE_SPEED_FOR_BUYER_CALLS).
    const speed = session.isTest || ELEVEN_PACE_SPEED_FOR_BUYER_CALLS ? elevenSpeedFor(choice.model, resolved.pace) : undefined;
    if (speed !== undefined) choice.speed = speed;
    const speech = speechFor({ wanted, modelId: session.model, engine: stored, isTest: session.isTest });
    if (speech.ignored) log.info(voiceLine(session.id, speechIgnoredLine(speech.ignored)));
    const storedSpeech = (session.settings as { speech?: unknown } | null)?.speech;
    const eleven = rtEleven || (speech.speech === "elevenlabs" && storedSpeech === "elevenlabs" && !classic);
    // The speaker of a text-output call: free and local when scripted; the Gateway chain (paid) when live.
    let speaker: Speaker | null = null;
    if (eleven) {
      try {
        speaker = await rtElevenSpeakerFor(model.mode, env, opts.rtSpeaker, choice);
        const sp = speaker;
        storeSpeech = () => storeElevenApplied(opts.db, session.id, elevenAppliedOf(sp, choice));
      } catch (e) {
        log.warn(voiceLine(session.id, `rt speaker unavailable (engine=${stored} speech=elevenlabs): ${errorSummary(e)}`));
        await endUnstartedVoiceSession(opts.db, session.id, "model_unavailable", new Date(clock.now()), { log, writtenOpener: opts.writtenOpener });
        return refuse("model_unavailable");
      }
    }
    sessionId = session.id;
    // A scripted stand-in also names the version's model it stands in for.
    log.info(voiceLine(session.id, `socket accepted mode=${model.mode} model=${model.modelId}${session.model && session.model !== model.modelId ? ` for=${session.model}` : ""} maxSec=${maxSec}${session.isTest ? " test" : ""}${speaker ? " speech=elevenlabs" : ""}`));
    // Once per call: whether the page holds the greeting until it shows the chat (the hand-over), and if it was
    // already released (a `ready` that came while the ticket was checked), how long it was held.
    log.info(voiceLine(session.id, hold ? "greeting held: yes (hand-over)" : "greeting held: no"));
    if (hold) {
      hold.accepted = true;
      logRelease();
    }
    sendJson({ t: "call", maxSec, mode: model.mode });
    const deps = {
      db: opts.db, model, sessionId: session.id, clock, log, onEnding: keepAlive, writtenOpener: opts.writtenOpener,
      // holdGreeting (the lead page hand-over): the page's `ready` comes once it shows the chat (it implies waitAudio).
      limits: {
        ...opts.limits, deadlineSec: opts.deadlineSec, env, ...(auth.waitAudio || auth.holdGreeting ? { waitForClientAudio: true } : {}),
        ...(auth.holdGreeting ? { holdGreeting: true } : {}),
      },
      send: (msg: ServerMessage | Uint8Array) => {
        if (msg instanceof Uint8Array) {
          // Backpressure: drop agent audio, never protocol messages. A drop is a splice in what the buyer hears
          // (the recording still has it): logged on the first one, with the total at the end.
          if (ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
            if (!droppedAgentBytes) log.warn(voiceLine(session.id, "agent audio dropped: the browser's socket is more than 3 s behind"));
            droppedAgentBytes += msg.byteLength;
            return;
          }
          safeSend(msg);
          return;
        }
        // A buyer's browser never learns which tools the agent ran (only the "checking" state): tool messages are for the test lab.
        if (msg.t === "tool" && !session.isTest) return;
        sendJson(msg);
        // The call is over and stored: close the socket (queued frames are sent first).
        if (msg.t === "ended") clock.setTimeout(() => closeSocket(VOICE_CLOSE.normal, "ended"), 0);
      },
    };
    // The wiring (the engine select) × who speaks (the version): Classic is model-voice only; Current and New run
    // with the model's own voice, or with text output + the ElevenLabs player (`speaker`).
    const withSpeaker = speaker ? { speaker } : {};
    engine = classic ? new ClassicVoiceEngine(deps)
      : rtEngine && speaker ? new VoiceEngine({ ...deps, profile: rtElevenProfile(rtEngine), speaker })
        : guarded ? new VoiceEngine({ ...deps, profile: stored === GUARDED_SILENT_ENGINE ? GUARDED_SILENT_PROFILE : GUARDED_PROFILE, ...withSpeaker })
          : new VoiceEngine({ ...deps, ...withSpeaker });
    phase = "live";
    // A last guard beyond the engine's own limit: the socket never outlives the call by much.
    timers.hard = clock.setTimeout(() => {
      timers.hard = null;
      log.warn(voiceLine(sessionId, "socket hard limit reached"));
      void engine?.stop("limit", undefined, "deadline");
      closeSocket(VOICE_CLOSE.normal, "limit");
    }, (maxSec + 30) * 1000);
    const queued = early;
    early = [];
    await engine.start();
    for (const m of queued) engine.onClientMessage(m);
  };

  ws.on("message", (data: unknown, isBinary: boolean) => {
    try {
      lastSeen = clock.now();
      if (phase === "closed") return;
      const binary = isBinary === true || (typeof data !== "string" && isBinary !== false);
      if (phase === "auth") {
        const text = binary ? null : toText(data, false);
        if (text === null) return refuse("ticket_invalid");
        authenticate(text).catch((e) => {
          log.warn(voiceLine(sessionId, `socket auth failed: ${errorSummary(e)}`));
          refuse("internal");
        });
        return;
      }
      if (binary) {
        if (phase !== "live" || !engine) return; // audio before the call started is dropped
        const bytes = toBytes(data);
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_CLIENT_AUDIO_BYTES) return;
        const even = bytes.byteLength % 2 ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
        if (!audioAllowed(even.byteLength)) return;
        engine.onClientAudio(even);
        return;
      }
      const text = toText(data, false);
      const msg = text === null ? null : parseClientMessage(text);
      if (!msg) return; // unknown frames are ignored
      noteReady(msg);
      if (phase === "checking" || !engine) {
        if (early.length < MAX_EARLY_MESSAGES) early.push(msg);
        return;
      }
      engine.onClientMessage(msg);
    } catch (e) {
      console.error("[voice] socket message failed", e);
    }
  });
  ws.on("pong", () => {
    lastSeen = clock.now();
  });
  ws.on("close", (code?: unknown, reason?: unknown) => {
    try {
      const c = typeof code === "number" ? code : null;
      const r = clip(reason instanceof Uint8Array ? new TextDecoder().decode(reason) : reason);
      log.info(voiceLine(sessionId, `client socket closed code=${c ?? "-"} reason="${r}"`));
      clientClose ??= { code: c, reason: r };
      finish();
    } catch (e) {
      console.error("[voice] socket close handling failed", e);
      resolveDone();
    }
  });
  ws.on("error", (e: unknown) => {
    console.error("[voice] socket error", e);
    clientClose ??= { code: null, reason: clip(`socket error: ${e instanceof Error ? e.message : String(e)}`) };
    try {
      closeSocket(VOICE_CLOSE.internal, "error");
      finish();
    } catch {
      resolveDone();
    }
  });

  timers.auth = clock.setTimeout(() => {
    timers.auth = null;
    if (phase === "auth") refuse("ticket_invalid");
  }, AUTH_TIMEOUT_MS);
  pingLoop();
  return done;
}

export { routeDeadlineSec } from "./socket-limits";
