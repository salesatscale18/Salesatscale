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
import { PlaybackSchedule } from "./playback";
import { outputChoices, playbackRoute, type OutputDevice, type PlaybackRoute } from "./output";
import { INITIAL_SNAPSHOT, isIdlePhase, voiceReducer, type VoiceEvent, type VoiceSnapshot, type VoiceUnavailableReason } from "./state";
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "./worklet";

export type VoiceStartParams = {
  wsUrl: string;
  sessionId: string;
  ticket: string;
  /** The effective limit the server reported when it created the call (the relay confirms it). */
  maxSec?: number | null;
  mode?: "scripted" | "live" | null;
};

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
  private timers: { ping?: ReturnType<typeof setInterval>; lost?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> } = {};
  /** Bumped by every new call and by cancel: async steps of an older attempt stop. */
  private attempt = 0;
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

  private dispatch(e: VoiceEvent) {
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
   */
  begin(o: { maxSec?: number | null; mode?: "scripted" | "live" | null } = {}): void {
    this.attempt++;
    this.teardown();
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
      return true;
    } catch (e) {
      if (my !== this.attempt) return false;
      const name = (e as { name?: string })?.name;
      this.releaseMic();
      this.dispatch({ type: "phase", phase: name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError" ? "no_mic" : "mic_blocked" });
      return false;
    }
  }

  /** The server refused to create the call. */
  unavailable(reason: VoiceUnavailableReason, detail: { retryAt?: string | null; ownCall?: boolean } = {}) {
    this.attempt++;
    this.teardown();
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
      this.teardown();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (my !== this.attempt) return;
      ws.send(JSON.stringify({ t: "auth", sessionId: p.sessionId, ticket: p.ticket }));
      this.timers.ping = setInterval(() => this.sendMsg({ t: "ping" }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (my !== this.attempt) return;
      if (typeof ev.data === "string") {
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.t === "flush") this.flushPlayback();
        this.dispatch({ type: "server", msg, now: Date.now() });
        if (msg.t === "ended") this.onEnded();
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

  /** Typed text, used as the buyer's turn. */
  sendText(text: string): boolean {
    const clean = text.trim().slice(0, MAX_CLIENT_TEXT);
    if (!clean || this.snap.phase !== "live") return false;
    if (!this.sendMsg({ t: "text", text: clean })) return false;
    this.dispatch({ type: "typed", text: clean.replace(/\s+/g, " ") });
    return true;
  }

  /** Ends the call (or cancels it before it connected). */
  end() {
    const phase = this.snap.phase;
    if (phase === "ended" || phase === "unavailable" || phase === "idle") return;
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
    this.dispatch({ type: "reset", maxSec: this.snap.maxSec, mode: this.snap.mode });
  }

  /** Leaves the page: ends a running call and frees everything. */
  dispose() {
    if (!isIdlePhase(this.snap.phase)) this.sendMsg({ t: "end" });
    this.attempt++;
    this.teardown();
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
    const at = this.schedule.place(ctx.currentTime, buffer.duration);
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
    src.start(at);
  }

  private flushPlayback() {
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
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.lost);
    clearTimeout(this.timers.end);
    this.timers = {};
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
