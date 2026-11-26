/**
 * The browser side of a voice call (live voice), framework-free: microphone
 * capture (AudioWorklet → 24 kHz PCM16 frames of 40 ms), the socket to our
 * relay, gapless playback of the agent's audio with barge-in flushes, and the
 * call state (lib/voice/client/state.ts) for the UI to render. The agent
 * plays on the loudspeaker by default (lib/voice/client/output.ts), with
 * `outputDevices()` / `setOutputDevice()` where the browser lets a page pick
 * the output. One instance
 * can run several calls one after another.
 *
 * Release 1 has no resume: when the socket drops before the call ended, the
 * screen shows "Reconnecting…" briefly, then the ended state ("connection
 * lost") with the transcript kept. `onSocketLost` is the seam for a resume later.
 */
import { MAX_CLIENT_TEXT, VOICE_SAMPLE_RATE, parseServerMessage, type ClientMessage } from "../protocol";
import { FrameChunker, LinearResampler, floatToPcm16, levelOf, pcm16ToFloat, rmsOf } from "./audio";
import { PlaybackSchedule, elementReached } from "./playback";
import { outputChoices, playbackRoute, type OutputDevice, type PlaybackRoute } from "./output";
import { LiveSpeech, type LiveLine } from "./live-text";
import { INITIAL_SNAPSHOT, isIdlePhase, voiceReducer, type VoiceEvent, type VoiceSnapshot, type VoiceUnavailableReason } from "./state";
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "./worklet";
import { READY_PRIMER_MS, latencyMs, runReadiness, type ReadinessProbe, type ReadyReport } from "./readiness";

/** Where the output clocks were at a moment (the readiness and `heard` checks compare against it). */
type OutputMark = { ctxTime: number; outTime: number | null; elTime: number | null };

export type VoiceStartParams = {
  wsUrl: string;
  sessionId: string;
  ticket: string;
  /** The effective limit the server reported when it created the call (the relay confirms it). */
  maxSec?: number | null;
  mode?: "scripted" | "live" | null;
};

/** Why a call attempt did not get ready (the lead page hand-over's onFailed). */
export type CallFailReason = "mic_denied" | "mic_unavailable" | "connect_failed" | "busy" | "gate_refused" | "other";

/**
 * What a page may hear about one call attempt (the lead page hand-over keeps its "thinking" ring until onReady):
 * - onMicGranted: the microphone was granted (prepare succeeded).
 * - onReady: the microphone is granted, the relay accepted the ticket (`call`), the agent's model is connected (the
 *   relay's first `listening`) and the page's readiness check passed (lib/voice/client/readiness.ts: mic capture
 *   live, audio context running, output moving (on the <audio> element route: its currentTime advanced), the 150 ms
 *   silent primer; or its cap, so it never hangs). With `holdGreeting` the greeting is still
 *   held then: `{t:"ready"}` has not gone to the relay; releaseGreeting() sends it (or the 8 s safety net).
 * - onFailed(reason): at most once per attempt, never after onReady except "connect_failed" when the call drops
 *   before the greeting was released (the socket closes, the relay ends or refuses the call). Nothing fires for an
 *   attempt the page itself cancelled or ended, or one a newer attempt replaced.
 */
export type VoiceCallEvents = { onMicGranted?(): void; onReady?(): void; onFailed?(reason: CallFailReason): void };

/** With `holdGreeting`: the greeting goes this long after onReady when the page has not released it. */
export const HOLD_RELEASE_MS = 8_000;
/** With `holdGreeting`: not ready this long after the socket opened (the relay may wait up to 20 s for a chat turn): connect_failed. */
export const HOLD_CONNECT_MS = 30_000;

/** The relay's refusal codes as a hand-over failure reason. */
export function failReasonOfError(code: string): CallFailReason {
  if (code === "connection_lost" || code === "model_unavailable" || code === "model_closed_early" || code === "ticket_invalid") return "connect_failed";
  if (code === "spend_cap" || code === "platform_budget" || code === "account_paused" || code === "conversation_closed" || code === "human_handling") return "gate_refused";
  return "other";
}

/** A call the relay ended before it was ready, as a hand-over failure reason. */
function failReasonOfEnd(reason: string): CallFailReason {
  if (reason === "connection_lost" || reason === "not_started") return "connect_failed";
  if (reason === "budget") return "gate_refused";
  return "other";
}

export type VoiceClientOptions = {
  /** Mic constraints (echo cancellation, noise suppression and gain control by default). */
  audio?: MediaTrackConstraints;
  /** How long "Reconnecting…" shows after the socket dropped, before the ended state. */
  lostGraceMs?: number;
  /** End waits this long for the relay to confirm before it ends locally. */
  endTimeoutMs?: number;
  /** Seam for tests and the harness: where the mic comes from. */
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
};

/** The longest the page watches for its first agent audio to start playing (the `heard` report; log only). */
const HEARD_MAX_MS = 10_000;
const HEARD_POLL_MS = 20;
const DEFAULT_AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const PING_MS = 10_000;

type Listener = () => void;

export class VoiceClient {
  private snap: VoiceSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outGain: GainNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  /** Loudspeaker path (lib/voice/client/output.ts): the agent's audio as a stream, played by an <audio> element. */
  private outDest: MediaStreamAudioDestinationNode | null = null;
  private outEl: HTMLAudioElement | null = null;
  private route: PlaybackRoute = "context";
  /** The output the buyer picked (setOutputDevice), kept for the next call; "" = system default. */
  private sinkId = "";
  private resampler: LinearResampler | null = null;
  private chunker = new FrameChunker();
  private schedule = new PlaybackSchedule();
  private playing = new Set<AudioBufferSourceNode>();
  private ws: WebSocket | null = null;
  private timers: { ping?: ReturnType<typeof setInterval>; lost?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout>; heard?: ReturnType<typeof setInterval> } = {};
  /** The output clocks when the mic capture delivered its first frame (null: not yet this call). */
  private micLiveMark: OutputMark | null = null;
  /** The <audio> element of this call fired `playing`. */
  private elPlaying = false;
  /**
   * The first agent audio of this call: when it arrived, where it was scheduled, the lead-in silence in front of it
   * (playback.ts GREETING_LEAD_IN_MS); `sent` once `heard` went.
   */
  private firstChunk: { recvMs: number; startAt: number; queuedMs: number; leadInMs: number; mark: OutputMark; sent: boolean } | null = null;
  /** Bumped by every new call and by cancel: async steps of an older attempt stop. */
  private attempt = 0;
  /**
   * This attempt's events and greeting hold (begin): whether the relay accepted the ticket (`authed`), the readiness
   * report once the check passed, and where the hold is (ready fired, released, failed). Null: no events, no hold.
   */
  private call: {
    events: VoiceCallEvents; hold: boolean; authed: boolean; report: ReadyReport | null;
    ready: boolean; released: boolean; releaseWanted: boolean; failed: boolean;
    /** When the page first called releaseGreeting() (performance.now(): the hand-over's chat on screen); the `heard` report. */
    releaseCalledMs: number | null;
    timers: { release?: ReturnType<typeof setTimeout>; connect?: ReturnType<typeof setTimeout> };
  } | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly opts: Required<Omit<VoiceClientOptions, "getUserMedia">> & Pick<VoiceClientOptions, "getUserMedia">;

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = { audio: DEFAULT_AUDIO, lostGraceMs: 1500, endTimeoutMs: 5000, ...opts };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  // -- Store (useSyncExternalStore) ----------------------------------------

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): VoiceSnapshot => this.snap;

  /**
   * The agent's line as it is being spoken (the buyer chat's live text; display only): what the relay sent, paced by
   * the agent audio this page actually played. Read with liveLines(); fed here and in play().
   */
  private live = new LiveSpeech();

  /** The agent's lines of this call as they show now (lib/voice/client/live-text.ts). Read on a timer by the chat. */
  liveLines = (): LiveLine[] => this.live.lines(performance.now());

  private feedLive(e: VoiceEvent) {
    if (e.type === "reset") {
      this.live.reset();
      return;
    }
    if (e.type !== "server" || this.snap.phase === "ended") return;
    const m = e.msg;
    const now = performance.now();
    if (m.t === "transcript") this.live.transcript(m, now);
    else if (m.t === "agent_audio") this.live.mark(m.id, m.totalMs);
    else if (m.t === "state") this.live.state(m.state);
    // A flush (barge-in) reaches the live text through flushPlayback, as every other drop of the queued audio does.
  }

  private dispatch(e: VoiceEvent) {
    this.feedLive(e);
    const next = voiceReducer(this.snap, e);
    if (next === this.snap) return;
    this.snap = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** The current mic and agent levels, 0..1, for the animated bars (read per frame, no re-render). */
  levels = (): { mic: number; out: number } => ({ mic: this.levelOfNode(this.micAnalyser), out: this.levelOfNode(this.outAnalyser) });

  private levelOfNode(a: AnalyserNode | null): number {
    if (!a) return 0;
    if (!this.levelBuf || this.levelBuf.length !== a.fftSize) this.levelBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.levelBuf);
    return levelOf(rmsOf(this.levelBuf));
  }

  // -- Starting a call -----------------------------------------------------

  /**
   * Call this synchronously inside the click that starts a call: it creates
   * and resumes the AudioContext there (browsers only allow audio to start
   * from a user gesture) and resets the screen.
   *
   * `holdGreeting` (the lead page hand-over): the relay asks the model for the opening line only when the page calls
   * releaseGreeting() (or HOLD_RELEASE_MS after onReady). `events`: this attempt's VoiceCallEvents.
   */
  begin(o: { maxSec?: number | null; mode?: "scripted" | "live" | null; holdGreeting?: boolean; events?: VoiceCallEvents } = {}): void {
    this.attempt++;
    this.teardown();
    this.call = o.events || o.holdGreeting
      ? { events: o.events ?? {}, hold: !!o.holdGreeting, authed: false, report: null, ready: false, released: false, releaseWanted: false, failed: false, releaseCalledMs: null, timers: {} }
      : null;
    // This call's first agent chunk gets the lead-in (silence in front of the first word).
    this.schedule.newCall();
    this.dispatch({ type: "reset", maxSec: o.maxSec ?? null, mode: o.mode ?? null });
    this.dispatch({ type: "phase", phase: "starting" });
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive" });
      void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
    if (this.ctx) this.wireOutput(this.ctx);
  }

  /** Which way the agent's voice plays this call: "element" (loudspeaker by default) or "context". */
  get playbackRoute(): PlaybackRoute {
    return this.route;
  }

  /**
   * The outputs the buyer can pick from, or [] where the page cannot choose (iOS Safari, most
   * Android phones: the system routes audio; see output.ts). Labels need the mic permission.
   */
  async outputDevices(): Promise<OutputDevice[]> {
    try {
      const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      return outputChoices(devices, this.canSwitchOutput());
    } catch {
      return [];
    }
  }

  /** Plays the agent on this output (setSinkId). False where the browser cannot switch, or the device is gone. */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    if (!this.canSwitchOutput()) return false;
    try {
      if (this.route === "element" && this.outEl) await (this.outEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
      else if (this.ctx) await (this.ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
      this.sinkId = deviceId;
      return true;
    } catch {
      return false;
    }
  }

  private canSwitchOutput(): boolean {
    if (this.route === "element") return !!this.outEl && typeof (this.outEl as { setSinkId?: unknown }).setSinkId === "function";
    return !!this.ctx && typeof (this.ctx as { setSinkId?: unknown }).setSinkId === "function";
  }

  /**
   * The agent's audio: one gain (flushes stop the sources), an analyser for the bars, then the
   * loudspeaker path (a MediaStream played by an <audio> element), or straight to the context
   * where that is missing or the element may not play. Built inside the click (begin) so the
   * element's play() counts as started by the user.
   */
  private wireOutput(ctx: AudioContext) {
    this.outGain = ctx.createGain();
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.outGain.connect(this.outAnalyser);
    const route = playbackRoute({
      streamDestination: typeof ctx.createMediaStreamDestination === "function",
      elementSrcObject: typeof document !== "undefined" && typeof HTMLMediaElement !== "undefined" && "srcObject" in HTMLMediaElement.prototype,
    });
    if (route === "element") {
      try {
        const dest = ctx.createMediaStreamDestination();
        const el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("playsinline", "");
        el.srcObject = dest.stream;
        el.addEventListener("playing", () => {
          if (this.outEl === el) this.elPlaying = true;
        });
        this.outAnalyser.connect(dest);
        this.outDest = dest;
        this.outEl = el;
        this.route = "element";
        const analyser = this.outAnalyser;
        const my = this.attempt;
        if (this.sinkId) void this.setOutputDevice(this.sinkId);
        void el.play().catch(() => {
          // Autoplay refused: play through the context instead (the default output of the page).
          if (my !== this.attempt || this.outEl !== el) return;
          this.dropElement();
          try {
            analyser.connect(ctx.destination);
          } catch {
            // Closed context.
          }
        });
        return;
      } catch {
        this.dropElement();
      }
    }
    this.route = "context";
    this.outAnalyser.connect(ctx.destination);
  }

  private dropElement() {
    try {
      if (this.outDest) this.outAnalyser?.disconnect(this.outDest);
    } catch {
      // Not connected.
    }
    if (this.outEl) {
      this.outEl.pause();
      this.outEl.srcObject = null;
    }
    this.outEl = null;
    this.outDest = null;
    this.elPlaying = false;
    this.route = "context";
  }

  /**
   * Opens the microphone (the browser may ask). Returns false when it is
   * blocked or missing: the screen then shows what to do.
   */
  async prepare(): Promise<boolean> {
    const my = this.attempt;
    if (!this.ctx) this.begin();
    try {
      const status = await navigator.permissions?.query({ name: "microphone" as PermissionName }).catch(() => null);
      if (my !== this.attempt) return false;
      if (status?.state === "denied") {
        this.dispatch({ type: "phase", phase: "mic_blocked" });
        this.failCall("mic_denied");
        return false;
      }
      if (status?.state !== "granted") this.dispatch({ type: "phase", phase: "mic_prompt" });
      // Without mediaDevices (a page that is not a secure context) the mic cannot be used: shown as blocked.
      if (!this.opts.getUserMedia && !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no mediaDevices"), { name: "NotAllowedError" });
      const gum = this.opts.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
      const stream = await gum({ audio: this.opts.audio, video: false });
      if (my !== this.attempt) {
        stream.getTracks().forEach((tr) => tr.stop());
        return false;
      }
      this.stream = stream;
      await this.wireMic();
      if (my !== this.attempt) return false;
      this.dispatch({ type: "phase", phase: "starting" });
      this.emit("onMicGranted");
      return true;
    } catch (e) {
      if (my !== this.attempt) return false;
      const name = (e as { name?: string })?.name;
      this.releaseMic();
      const noMic = name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError";
      this.dispatch({ type: "phase", phase: noMic ? "no_mic" : "mic_blocked" });
      this.failCall(noMic ? "mic_unavailable" : "mic_denied");
      return false;
    }
  }

  /**
   * The greeting may go now (`holdGreeting`): sends the held `{t:"ready"}` with the readiness report, so the relay asks
   * the model for the opening line. Before onReady it goes as soon as the call is ready. Idempotent; a no-op without a hold.
   */
  releaseGreeting(): void {
    const c = this.call;
    if (!c || !c.hold || c.released || c.failed) return;
    c.releaseCalledMs ??= performance.now();
    if (!c.ready) {
      c.releaseWanted = true;
      return;
    }
    this.sendHeldReady();
  }

  /**
   * A page-level outcome of this attempt (the chat's POST that creates the call refused it, or failed): onFailed,
   * at most once. Call it before cancel() or unavailable(), which end the attempt.
   */
  failAttempt(reason: CallFailReason): void {
    this.failCall(reason);
  }

  private emit(name: "onMicGranted" | "onReady") {
    const c = this.call;
    if (!c || c.failed) return;
    try {
      c.events[name]?.();
    } catch (e) {
      console.error(`[voice] ${name} failed`, e);
    }
  }

  /**
   * onFailed once per attempt. After onReady only while the greeting is still held, and then always as
   * "connect_failed" (the call dropped or the relay ended it before the greeting went).
   */
  private failCall(reason: CallFailReason) {
    const c = this.call;
    if (!c || c.failed) return;
    if (c.ready) {
      if (!c.hold || c.released) return;
      reason = "connect_failed";
    }
    c.failed = true;
    this.clearCallTimers();
    try {
      c.events.onFailed?.(reason);
    } catch (e) {
      console.error("[voice] onFailed failed", e);
    }
  }

  /** Ready (see VoiceCallEvents.onReady): fires onReady; with a hold, the greeting goes when released or after HOLD_RELEASE_MS. */
  private checkReady() {
    const c = this.call;
    if (!c || c.ready || c.failed || !c.authed || !c.report || this.snap.phase !== "live") return;
    c.ready = true;
    clearTimeout(c.timers.connect);
    this.emit("onReady");
    if (!c.hold || c.released || this.call !== c) return;
    if (c.releaseWanted) return this.sendHeldReady();
    const my = this.attempt;
    c.timers.release = setTimeout(() => {
      if (my === this.attempt && this.call === c) this.sendHeldReady();
    }, HOLD_RELEASE_MS);
  }

  private sendHeldReady() {
    const c = this.call;
    if (!c || c.released || !c.report) return;
    c.released = true;
    clearTimeout(c.timers.release);
    this.sendMsg({ t: "ready", ...c.report });
  }

  private clearCallTimers() {
    const c = this.call;
    if (!c) return;
    clearTimeout(c.timers.release);
    clearTimeout(c.timers.connect);
    c.timers = {};
  }

  /** The server refused to create the call. */
  unavailable(reason: VoiceUnavailableReason, detail: { retryAt?: string | null; ownCall?: boolean } = {}) {
    // Without failAttempt first: "other" (the page said nothing more).
    this.failCall("other");
    this.attempt++;
    this.teardown();
    this.call = null;
    this.dispatch({ type: "unavailable", reason, ...detail });
  }

  /** Opens the socket and starts the call (after `begin` and a successful `prepare`). */
  start(p: VoiceStartParams): void {
    const my = this.attempt;
    if (p.maxSec || p.mode) this.dispatch({ type: "server", msg: { t: "call", maxSec: p.maxSec ?? this.snap.maxSec ?? 0, mode: p.mode ?? this.snap.mode ?? "live" }, now: Date.now() });
    this.dispatch({ type: "phase", phase: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(p.wsUrl);
    } catch {
      this.dispatch({ type: "server", msg: { t: "error", code: "connection_lost" }, now: Date.now() });
      this.dispatch({ type: "local_end", reason: "connection_lost" });
      this.failCall("connect_failed");
      this.teardown();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const call = this.call;
    const hold = !!call?.hold;
    if (call && hold) {
      // Not ready in time (the relay may first wait for a chat turn in flight): the attempt fails and the call ends.
      call.timers.connect = setTimeout(() => {
        if (my !== this.attempt || this.call !== call || call.ready) return;
        this.failCall("connect_failed");
        this.end();
      }, HOLD_CONNECT_MS);
    }
    ws.onopen = () => {
      if (my !== this.attempt) return;
      // waitAudio: the relay asks for the opening line once this page says it can play it (`ready`). holdGreeting:
      // and that `ready` is held until the page releases it (releaseGreeting); the relay then waits longer for it.
      ws.send(JSON.stringify({ t: "auth", sessionId: p.sessionId, ticket: p.ticket, waitAudio: true, ...(hold ? { holdGreeting: true } : {}) }));
      this.timers.ping = setInterval(() => this.sendMsg({ t: "ping" }), PING_MS);
      void this.whenOutputRuns(my).then((report) => {
        if (my !== this.attempt) return;
        // The lead-in counts from here: the first agent word starts GREETING_LEAD_IN_MS after the output was confirmed.
        if (this.ctx) this.schedule.outputRunning(this.ctx.currentTime);
        if (call && this.call === call) call.report = report;
        if (!hold) this.sendMsg({ t: "ready", ...report });
        this.checkReady();
      });
    };
    ws.onmessage = (ev) => {
      if (my !== this.attempt) return;
      if (typeof ev.data === "string") {
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.t === "flush") this.flushPlayback();
        // The relay accepted the ticket.
        if (msg.t === "call" && call && this.call === call) call.authed = true;
        this.dispatch({ type: "server", msg, now: Date.now() });
        if (msg.t === "error") this.failCall(failReasonOfError(msg.code));
        if (msg.t === "ended") {
          this.failCall(failReasonOfEnd(msg.reason));
          this.onEnded();
        }
        this.checkReady();
        return;
      }
      if (ev.data instanceof ArrayBuffer) this.play(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (my !== this.attempt) return;
      this.ws = null;
      clearInterval(this.timers.ping);
      const phase = this.snap.phase;
      if (phase === "ended" || phase === "unavailable") return;
      if (phase === "ending") {
        this.dispatch({ type: "local_end", reason: "user_hangup" });
        this.teardown();
        return;
      }
      this.onSocketLost();
    };
    ws.onerror = () => {
      // The close event follows.
    };
  }

  // -- During the call -----------------------------------------------------

  mute(on: boolean) {
    this.dispatch({ type: "mute", on });
    this.stream?.getAudioTracks().forEach((tr) => (tr.enabled = !on));
    this.sendMsg({ t: "mute", on });
  }

  /** A tap on the bar while the call is on standby: the agent reconnects now. */
  wake(): boolean {
    if (this.snap.phase !== "live" || this.snap.live !== "standby") return false;
    return this.sendMsg({ t: "wake" });
  }

  /** Typed text, used as the buyer's turn. */
  sendText(text: string): boolean {
    const clean = text.trim().slice(0, MAX_CLIENT_TEXT);
    if (!clean || this.snap.phase !== "live") return false;
    if (!this.sendMsg({ t: "text", text: clean })) return false;
    this.dispatch({ type: "typed", text: clean.replace(/\s+/g, " ") });
    return true;
  }

  /** The order form's step, from a form tab (the voice bubble's tab link): a quiet note for the call. Only while live. */
  sendContext(c: { step: string; label: string; event: "opened" | "step" | "submitted" }): boolean {
    if (this.snap.phase !== "live") return false;
    return this.sendMsg({ t: "context", kind: "order_form", step: c.step, label: c.label.slice(0, 80), event: c.event });
  }

  /** Ends the call (or cancels it before it connected). */
  end() {
    const phase = this.snap.phase;
    if (phase === "ended" || phase === "unavailable" || phase === "idle") return;
    // The page ended it: no events for this attempt from now on.
    this.clearCallTimers();
    this.call = null;
    this.releaseMic();
    this.flushPlayback();
    if (phase === "mic_prompt" || phase === "starting" || phase === "mic_blocked" || phase === "no_mic") {
      this.cancel();
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.dispatch({ type: "phase", phase: "ending" });
      this.sendMsg({ t: "end" });
      this.timers.end = setTimeout(() => {
        this.dispatch({ type: "local_end", reason: "user_hangup" });
        this.teardown();
      }, this.opts.endTimeoutMs);
      return;
    }
    this.dispatch({ type: "local_end", reason: "user_hangup" });
    this.teardown();
  }

  /** Back to Ready (Cancel on the microphone prompt, or before the socket opened). */
  cancel() {
    this.attempt++;
    this.teardown();
    this.call = null;
    this.dispatch({ type: "reset", maxSec: this.snap.maxSec, mode: this.snap.mode });
  }

  /** Leaves the page: ends a running call and frees everything. */
  dispose() {
    if (!isIdlePhase(this.snap.phase)) this.sendMsg({ t: "end" });
    this.attempt++;
    this.teardown();
    this.call = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  // -- Internals -----------------------------------------------------------

  private sendMsg(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private async wireMic() {
    const ctx = this.ctx;
    const stream = this.stream;
    if (!ctx || !stream) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.source = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.worklet = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    // A silent sink keeps the worklet pulled by the graph without playing the mic back.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.micAnalyser);
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.resampler = new LinearResampler(ctx.sampleRate, VOICE_SAMPLE_RATE);
    this.chunker.reset();
    this.worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onMicSamples(ev.data);
    // The agent's output was wired in begin() (wireOutput).
    if (!this.outGain) this.wireOutput(ctx);
  }

  private onMicSamples(samples: Float32Array) {
    // The capture runs: the audio route switch that starting the mic causes on a phone has happened (readiness).
    if (!this.micLiveMark && this.ctx) this.micLiveMark = this.outputMark(this.ctx);
    if (!this.resampler || this.snap.muted) return;
    // Audio goes out only while the call is live (the relay drops anything earlier).
    if (this.snap.phase !== "live") return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const frame of this.chunker.push(this.resampler.process(samples))) {
      // A congested socket drops mic audio rather than lagging behind.
      if (ws.bufferedAmount > VOICE_SAMPLE_RATE * 2) continue;
      ws.send(floatToPcm16(frame));
    }
  }

  private play(bytes: Uint8Array) {
    const ctx = this.ctx;
    const out = this.outGain;
    if (!ctx || !out || bytes.byteLength < 2) return;
    const samples = pcm16ToFloat(bytes);
    const buffer = ctx.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    const { start: at, leadIn } = this.schedule.placeChunk(ctx.currentTime, buffer.duration);
    // The call's first chunk: silence in front of it through the same output, so the route already sounds at the first word.
    if (leadIn && leadIn.sec > 0) this.playSilence(ctx, out, leadIn.from, leadIn.sec);
    // The live text's clock is the page's (ms): this frame starts playing `at - currentTime` from now.
    const now = performance.now();
    this.live.audio(buffer.duration * 1000, now + (at - ctx.currentTime) * 1000, now);
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
    src.start(at);
    if (!this.firstChunk) this.watchFirstAudio(ctx, at, leadIn ? leadIn.sec : 0);
  }

  /** Silence through the agent's output path (the lead-in), stopped by a flush like any queued audio. */
  private playSilence(ctx: AudioContext, out: AudioNode, from: number, sec: number) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, Math.max(1, Math.round(VOICE_SAMPLE_RATE * sec)), VOICE_SAMPLE_RATE);
      src.connect(out);
      this.playing.add(src);
      src.onended = () => this.playing.delete(src);
      src.start(from);
    } catch {
      // No silence: the first chunk still starts at its time.
    }
  }

  /** The output clocks now: the context's, its output timestamp's (where the browser has one), the element's. */
  private outputMark(ctx: AudioContext): OutputMark {
    let outTime: number | null = null;
    try {
      const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
      if (ts && typeof ts.contextTime === "number" && Number.isFinite(ts.contextTime)) outTime = ts.contextTime;
    } catch {
      // No output timestamp.
    }
    return { ctxTime: ctx.currentTime, outTime, elTime: this.route === "element" && this.outEl ? this.outEl.currentTime : null };
  }

  /**
   * The output has moved on since `since`: on the element route the context runs, the element plays and its
   * currentTime advanced by `minSec` (any advance when 0); on the direct route the context clock advanced by `minSec`
   * and, where the browser reports it, its output timestamp too.
   */
  private outputMovedSince(ctx: AudioContext, since: OutputMark, minSec: number): boolean {
    const now = this.outputMark(ctx);
    if (this.route === "element" && this.outEl) {
      const el = this.outEl;
      const plays = this.elPlaying || (!el.paused && el.readyState >= 2);
      if (ctx.state !== "running" || !plays || now.elTime === null) return false;
      const from = since.elTime ?? 0;
      return now.elTime > from && now.elTime - from >= minSec;
    }
    if (now.ctxTime - since.ctxTime < minSec) return false;
    return now.outTime === null || now.outTime > (since.outTime ?? 0);
  }

  /**
   * The `ready` check (lib/voice/client/readiness.ts): mic capture live, context running, output moving, then a
   * 150 ms silent primer through the agent's output path. Bounded (READY_MAX_MS); resolves with its diagnostics.
   */
  private whenOutputRuns(my: number) {
    const ctx = this.ctx;
    const startMark = ctx ? this.outputMark(ctx) : null;
    const self = this;
    const probe: ReadinessProbe = {
      get route() {
        return self.route === "element" ? "element" : "direct";
      },
      micLive: () => !!this.micLiveMark || (!this.worklet && !!this.stream?.getAudioTracks().some((tr) => tr.readyState === "live" && !tr.muted)),
      ctxRunning: () => !!ctx && ctx.state === "running",
      resumeCtx: () => void ctx?.resume().catch(() => undefined),
      outputMoving: () => !!ctx && !!startMark && this.outputMovedSince(ctx, this.micLiveMark ?? startMark, 0.1),
      // The element route: its currentTime moved at all since the check began (the report's outAdvance).
      outputAdvanced: () => !!this.outEl && !!startMark && this.outEl.currentTime > (startMark.elTime ?? 0),
      playPrimer: (done) => {
        const out = this.outGain;
        if (!ctx || !out) throw new Error("no output");
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, Math.round((VOICE_SAMPLE_RATE * READY_PRIMER_MS) / 1000), VOICE_SAMPLE_RATE);
        src.connect(out);
        src.onended = () => done();
        src.start();
      },
      latency: () => ({ baseLatencyMs: latencyMs(ctx?.baseLatency), outputLatencyMs: latencyMs((ctx as { outputLatency?: number } | null)?.outputLatency) }),
    };
    return runReadiness(probe, undefined, () => my === this.attempt).then((r) => {
      // No undefined fields on the wire.
      if (r.baseLatencyMs === undefined) delete r.baseLatencyMs;
      if (r.outputLatencyMs === undefined) delete r.outputLatencyMs;
      return r;
    });
  }

  /**
   * The first agent audio of the call: once its scheduled start has passed and the output has really played up to it
   * (on the element route: the element's currentTime advanced as far as the context had to go to its start), the
   * page tells the relay (`heard`, log only) how long that took since the chunk arrived, the lead-in silence played in
   * front of it and, on a hand-over, how long since the page released the greeting. Gives up after HEARD_MAX_MS.
   */
  private watchFirstAudio(ctx: AudioContext, startAt: number, leadInSec: number) {
    const fc = {
      recvMs: performance.now(), startAt, queuedMs: Math.max(0, Math.round((startAt - ctx.currentTime) * 1000)), leadInMs: Math.round(leadInSec * 1000),
      mark: this.outputMark(ctx), sent: false,
    };
    this.firstChunk = fc;
    const my = this.attempt;
    clearInterval(this.timers.heard);
    this.timers.heard = setInterval(() => {
      const waited = performance.now() - fc.recvMs;
      if (my !== this.attempt || this.ctx !== ctx || fc.sent || waited > HEARD_MAX_MS) {
        clearInterval(this.timers.heard);
        return;
      }
      if (ctx.currentTime < fc.startAt || !this.outputMovedSince(ctx, fc.mark, 0)) return;
      const out = this.outputMark(ctx);
      if (this.route === "element") {
        // The element itself has played up to the start (its currentTime, not just the context's clock).
        if (!elementReached(fc.mark, out.elTime, fc.startAt)) return;
      } else if (out.outTime !== null && out.outTime < fc.startAt) return; // the output clock reached the start
      fc.sent = true;
      clearInterval(this.timers.heard);
      const released = this.call?.releaseCalledMs ?? null;
      this.sendMsg({
        t: "heard", sinceFirstChunkMs: Math.round(waited), queuedMs: fc.queuedMs, leadInMs: fc.leadInMs,
        ...(released !== null ? { afterReleaseMs: Math.max(0, Math.round(performance.now() - released)) } : {}),
      });
    }, HEARD_POLL_MS);
  }

  private flushPlayback() {
    // The live text stops at what was played (a line never runs ahead of the voice it lost).
    this.live.flush(performance.now());
    for (const src of this.playing) {
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
    }
    this.playing.clear();
    this.schedule.flush();
  }

  private onEnded() {
    clearTimeout(this.timers.end);
    this.releaseMic();
    // Let the agent's last words finish, then free the audio.
    const ctx = this.ctx;
    const tail = ctx ? this.schedule.queuedSec(ctx.currentTime) : 0;
    const my = this.attempt;
    setTimeout(() => {
      if (my === this.attempt) this.teardown();
    }, Math.min(8000, tail * 1000 + 300));
  }

  /** The socket dropped before the call ended. Release 1: no resume, so the call is over (transcript kept). */
  private onSocketLost() {
    this.dispatch({ type: "socket_lost" });
    this.failCall("connect_failed");
    this.releaseMic();
    this.flushPlayback();
    const my = this.attempt;
    this.timers.lost = setTimeout(() => {
      if (my !== this.attempt) return;
      this.dispatch({ type: "local_end", reason: "connection_lost" });
      this.teardown();
    }, this.opts.lostGraceMs);
  }

  private onVisibility = () => {
    // iOS and some browsers suspend audio in the background: resume when the tab is back.
    if (document.visibilityState !== "visible" || isIdlePhase(this.snap.phase)) return;
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => undefined);
    if (this.outEl?.paused) void this.outEl.play().catch(() => undefined);
  };

  private releaseMic() {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    try {
      if (this.worklet) this.worklet.port.onmessage = null;
      this.source?.disconnect();
      this.worklet?.disconnect();
      this.sink?.disconnect();
      this.micAnalyser?.disconnect();
    } catch {
      // Nodes of a closed context.
    }
    this.source = null;
    this.worklet = null;
    this.sink = null;
    this.micAnalyser = null;
    this.resampler = null;
    this.chunker.reset();
  }

  /** Frees the socket, the mic and the audio context. The snapshot (transcript) stays. */
  private teardown() {
    this.clearCallTimers();
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.lost);
    clearTimeout(this.timers.end);
    clearInterval(this.timers.heard);
    this.timers = {};
    this.micLiveMark = null;
    this.elPlaying = false;
    this.firstChunk = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "client");
      } catch {
        // Closing a dead socket.
      }
    }
    this.releaseMic();
    this.flushPlayback();
    this.dropElement();
    try {
      this.outGain?.disconnect();
      this.outAnalyser?.disconnect();
    } catch {
      // Closed context.
    }
    this.outGain = null;
    this.outAnalyser = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
  }
}
