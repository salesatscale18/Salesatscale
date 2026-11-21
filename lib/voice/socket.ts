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
import { agentVersions } from "@/db/schema";
import { VoiceEngine, type VoiceLimits } from "./engine";
import {
  AUTH_TIMEOUT_MS, MAX_CLIENT_AUDIO_BYTES, VOICE_CLOSE, VOICE_SAMPLE_RATE, parseAuthMessage, parseClientMessage,
  type ClientMessage, type ServerMessage, type VoiceErrorCode,
} from "./protocol";
import { systemClock, type Clock, type RealtimeModel, type TimerHandle } from "./realtime";
import { endUnstartedVoiceSession, realtimeModelFor, redeemVoiceTicket } from "./service";
import { maxCallSeconds, voiceMode } from "./settings";
import { clip, consoleVoiceLog, voiceLine, type VoiceLog } from "./log";

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
  /**
   * Runs once the call is stored, before the handler resolves (so the function stays alive for it):
   * the route answers a buyer turn the call left unanswered (lib/voice/after-call.ts). Never awaited past its own errors.
   */
  afterCall?: (sessionId: string) => Promise<unknown>;
  /** One-line operational logs (default: console). */
  log?: VoiceLog;
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
  const env = opts.env ?? process.env;
  const log = opts.log ?? consoleVoiceLog;
  /** The session this socket carries, once the ticket was accepted (logs). */
  let sessionId: string | null = null;
  /** The browser socket's close code and reason, and whether we closed it for silence. */
  let clientClose: { code: number | null; reason: string; idle?: boolean } | null = null;
  let phase: "auth" | "checking" | "live" | "closed" = "auth";
  let engine: VoiceEngine | null = null;
  let early: ClientMessage[] = [];
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
    const e = engine;
    if (!e) {
      resolveDone();
      return;
    }
    // The engine ends the call now ("connection_lost" unless it already ended for another reason).
    e.onClientGone(clientClose ?? undefined).catch((err) => console.error("[voice] engine stop failed", err))
      // The call is stored: an unanswered last buyer turn may be answered in the chat now.
      .then(() => opts.afterCall?.(e.sessionId))
      .catch((err) => console.error("[voice] after-call hook failed", err))
      .finally(resolveDone);
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

  const authenticate = async (raw: string) => {
    phase = "checking";
    clock.clearTimeout(timers.auth);
    timers.auth = null;
    const auth = parseAuthMessage(raw);
    if (!auth) return refuse("ticket_invalid");
    const session = await redeemVoiceTicket(opts.db, auth.sessionId, auth.ticket, new Date(clock.now()));
    if (isClosed()) {
      if (session) await endUnstartedVoiceSession(opts.db, session.id, "connection_lost", new Date(clock.now()));
      return;
    }
    if (!session) return refuse("ticket_invalid");
    // The mode the call was created in must still be on (a live call never runs as scripted, or the reverse).
    const mode = voiceMode(env);
    const model = opts.model ?? (mode === session.mode ? await realtimeModelFor(mode, { clock, env }) : null);
    if (!model) {
      await endUnstartedVoiceSession(opts.db, session.id, "model_unavailable", new Date(clock.now()));
      return refuse("model_unavailable");
    }
    const [version] = session.agentVersionId
      ? await opts.db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
        .where(and(eq(agentVersions.id, session.agentVersionId), eq(agentVersions.accountId, session.accountId)))
      : [];
    if (isClosed()) {
      await endUnstartedVoiceSession(opts.db, session.id, "connection_lost", new Date(clock.now()));
      return;
    }
    const maxSec = maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env });
    sessionId = session.id;
    log.info(voiceLine(session.id, `socket accepted mode=${model.mode} model=${model.modelId} maxSec=${maxSec}${session.isTest ? " test" : ""}`));
    sendJson({ t: "call", maxSec, mode: model.mode });
    engine = new VoiceEngine({
      db: opts.db, model, sessionId: session.id, clock, log,
      limits: { ...opts.limits, deadlineSec: opts.deadlineSec, env },
      send: (msg) => {
        if (msg instanceof Uint8Array) {
          // Backpressure: drop agent audio, never protocol messages.
          if (ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) return;
          safeSend(msg);
          return;
        }
        // A buyer's browser never learns which tools the agent ran (only the "checking" state): tool messages are for the test lab.
        if (msg.t === "tool" && !session.isTest) return;
        sendJson(msg);
        // The call is over and stored: close the socket (queued frames are sent first).
        if (msg.t === "ended") clock.setTimeout(() => closeSocket(VOICE_CLOSE.normal, "ended"), 0);
      },
    });
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
          console.error("[voice] socket auth failed", e);
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
