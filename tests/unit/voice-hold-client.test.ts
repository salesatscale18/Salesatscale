/**
 * The browser side of the held greeting (lib/voice/client/voice-client.ts), against fake browser objects (an audio
 * context, the capture worklet, a socket) and fake timers: the hand-over's events (onMicGranted, onReady, onFailed
 * and its reasons), the held `{t:"ready"}` going only at releaseGreeting() or 8 s after onReady, and the default
 * (no hold) exactly as before: `ready` as soon as the readiness check passed, no holdGreeting on the auth.
 * The chat's POST refusals map to reasons too (startRefusal). No network, no audio, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_CONNECT_MS, HOLD_RELEASE_MS, VoiceClient, failReasonOfError, type CallFailReason, type VoiceCallEvents } from "@/lib/voice/client/voice-client";
import { startRefusal } from "@/app/chat/[token]/chat-client";

const node = <T extends object>(extra: T = {} as T) => ({ connect() {}, disconnect() {}, ...extra });

let t0 = 0;
class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  get currentTime() {
    return (Date.now() - t0) / 1000;
  }
  resume = async () => undefined;
  close = async () => void (this.state = "closed");
  createGain() {
    return node({ gain: { value: 1 } });
  }
  createAnalyser() {
    return node({ fftSize: 512, getFloatTimeDomainData() {} });
  }
  createMediaStreamSource() {
    return node();
  }
  createBuffer(_ch: number, len: number, rate: number) {
    return { duration: len / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const src = node({ buffer: null as unknown, onended: null as null | (() => void), start() { setTimeout(() => src.onended?.(), 150); }, stop() {} });
    return src;
  }
}

const worklets: { port: { onmessage: null | ((e: { data: Float32Array }) => void) } }[] = [];
class FakeWorkletNode {
  port = { onmessage: null as null | ((e: { data: Float32Array }) => void) };
  constructor() {
    worklets.push(this);
  }
  connect() {}
  disconnect() {}
}

const sockets: FakeSocket[] = [];
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: null | (() => void) = null;
  onmessage: null | ((e: { data: unknown }) => void) = null;
  onclose: null | (() => void) = null;
  onerror: null | (() => void) = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(d: unknown) {
    if (typeof d === "string") this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  server(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  msgs() {
    return this.sent.map((s) => JSON.parse(s) as { t: string } & Record<string, unknown>);
  }
  readies() {
    return this.msgs().filter((m) => m.t === "ready");
  }
}

const track = { stop() {}, enabled: true, readyState: "live", muted: false };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  worklets.length = 0;
  sockets.length = 0;
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function recorder() {
  const log: string[] = [];
  const events: VoiceCallEvents = {
    onMicGranted: () => void log.push("mic_granted"),
    onReady: () => void log.push("ready"),
    onFailed: (r: CallFailReason) => void log.push(`failed:${r}`),
  };
  return { log, events };
}

/** begin → prepare → start → socket open, mic live; then the readiness check runs (about 0.2 s). */
async function connect(o: { hold?: boolean; events?: VoiceCallEvents; gum?: () => Promise<MediaStream> } = {}) {
  const c = new VoiceClient({ getUserMedia: o.gum ?? (async () => stream) });
  c.begin({ holdGreeting: o.hold, events: o.events });
  const ok = await c.prepare();
  if (!ok) return { c, ws: null as unknown as FakeSocket, ok };
  c.start({ wsUrl: "ws://relay", sessionId: "s1", ticket: "t1" });
  const ws = sockets.at(-1)!;
  ws.open();
  // The capture delivered its first frame (the mic is live).
  worklets.at(-1)!.port.onmessage?.({ data: new Float32Array(128) });
  return { c, ws, ok };
}

/** The relay accepted the ticket and the agent's model is connected. */
const accepted = (ws: FakeSocket) => {
  ws.server({ t: "call", maxSec: 270, mode: "scripted" });
  ws.server({ t: "state", state: "listening" });
};

describe("held greeting: the browser", () => {
  it("mic granted, then ready only once the relay accepted the call AND the readiness check passed; the greeting stays held until releaseGreeting()", async () => {
    const r = recorder();
    const { c, ws } = await connect({ hold: true, events: r.events });
    expect(r.log).toEqual(["mic_granted"]);
    expect(ws.msgs()[0]).toMatchObject({ t: "auth", sessionId: "s1", ticket: "t1", waitAudio: true, holdGreeting: true });
    // The readiness check passed, but the relay has not accepted the call yet: not ready.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.log).toEqual(["mic_granted"]);
    ws.server({ t: "call", maxSec: 270, mode: "scripted" });
    expect(r.log).toEqual(["mic_granted"]);
    ws.server({ t: "state", state: "listening" });
    expect(r.log).toEqual(["mic_granted", "ready"]);
    // Held: no `ready` went to the relay.
    expect(ws.readies()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.readies()).toHaveLength(0);
    c.releaseGreeting();
    expect(ws.readies()).toHaveLength(1);
    // The readiness report goes with it.
    expect(ws.readies()[0]).toMatchObject({ t: "ready", route: "direct", steps: expect.any(Object), waitedMs: expect.any(Number) });
    // Idempotent; and the 8 s safety net does not send a second one.
    c.releaseGreeting();
    await vi.advanceTimersByTimeAsync(HOLD_RELEASE_MS + 1_000);
    expect(ws.readies()).toHaveLength(1);
    // After the release, a drop is the call's own business (no hand-over event).
    ws.drop();
    expect(r.log).toEqual(["mic_granted", "ready"]);
    c.dispose();
  });

  it("released before ready: the greeting goes the moment the call is ready", async () => {
    const r = recorder();
    const { c, ws } = await connect({ hold: true, events: r.events });
    c.releaseGreeting();
    accepted(ws);
    expect(ws.readies()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.log).toEqual(["mic_granted", "ready"]);
    expect(ws.readies()).toHaveLength(1);
    c.dispose();
  });

  it("not released: the greeting goes 8 s after onReady anyway (the client's safety net)", async () => {
    const r = recorder();
    const { c, ws } = await connect({ hold: true, events: r.events });
    accepted(ws);
    // Until onReady (the readiness check takes a few hundred ms here), in 10 ms steps.
    for (let i = 0; i < 200 && !r.log.includes("ready"); i++) await vi.advanceTimersByTimeAsync(10);
    expect(r.log).toEqual(["mic_granted", "ready"]);
    await vi.advanceTimersByTimeAsync(HOLD_RELEASE_MS - 20);
    expect(ws.readies()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(ws.readies()).toHaveLength(1);
    c.dispose();
  });

  it("without holdGreeting: exactly as before (no holdGreeting on the auth; ready as soon as the check passed, before the relay accepted)", async () => {
    const r = recorder();
    const { c, ws } = await connect({ events: r.events });
    expect(ws.msgs()[0]).toEqual({ t: "auth", sessionId: "s1", ticket: "t1", waitAudio: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws.readies()).toHaveLength(1);
    accepted(ws);
    expect(r.log).toEqual(["mic_granted", "ready"]);
    // releaseGreeting is a no-op without a hold.
    c.releaseGreeting();
    await vi.advanceTimersByTimeAsync(HOLD_RELEASE_MS + 1_000);
    expect(ws.readies()).toHaveLength(1);
    c.dispose();
    // And with no events at all (the chat's own "Talk to us", the test lab): the same wire.
    const plain = await connect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plain.ws.msgs()[0]).toEqual({ t: "auth", sessionId: "s1", ticket: "t1", waitAudio: true });
    expect(plain.ws.readies()).toHaveLength(1);
    plain.c.dispose();
  });

  describe("onFailed", () => {
    it("the microphone blocked (site settings) → mic_denied; refused at the prompt → mic_denied; missing → mic_unavailable", async () => {
      vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "denied" }) } });
      const a = recorder();
      expect((await connect({ hold: true, events: a.events })).ok).toBe(false);
      expect(a.log).toEqual(["failed:mic_denied"]);
      vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "prompt" }) } });
      const b = recorder();
      await connect({ hold: true, events: b.events, gum: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } });
      expect(b.log).toEqual(["failed:mic_denied"]);
      const n = recorder();
      await connect({ hold: true, events: n.events, gum: async () => { throw Object.assign(new Error("none"), { name: "NotFoundError" }); } });
      expect(n.log).toEqual(["failed:mic_unavailable"]);
    });

    it("the socket drops before ready → connect_failed, once", async () => {
      const r = recorder();
      const { c, ws } = await connect({ hold: true, events: r.events });
      ws.drop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(r.log).toEqual(["mic_granted", "failed:connect_failed"]);
      c.dispose();
    });

    it("the relay refuses: a gate → gate_refused; the model or the ticket → connect_failed; anything else → other", async () => {
      const r = recorder();
      const { c, ws } = await connect({ hold: true, events: r.events });
      ws.server({ t: "error", code: "spend_cap" });
      ws.drop();
      expect(r.log).toEqual(["mic_granted", "failed:gate_refused"]);
      c.dispose();
      expect(failReasonOfError("model_unavailable")).toBe("connect_failed");
      expect(failReasonOfError("ticket_invalid")).toBe("connect_failed");
      expect(failReasonOfError("conversation_closed")).toBe("gate_refused");
      expect(failReasonOfError("internal")).toBe("other");
    });

    it("after onReady: only connect_failed, and only while the greeting is held (a drop, or the relay ending it as not started)", async () => {
      const a = recorder();
      const one = await connect({ hold: true, events: a.events });
      accepted(one.ws);
      await vi.advanceTimersByTimeAsync(1_000);
      one.ws.server({ t: "ended", reason: "not_started", durationSec: 0, costMicros: 0, answerMsAvg: null });
      expect(a.log).toEqual(["mic_granted", "ready", "failed:connect_failed"]);
      one.c.dispose();
      const b = recorder();
      const two = await connect({ hold: true, events: b.events });
      accepted(two.ws);
      await vi.advanceTimersByTimeAsync(1_000);
      // The relay ends it for another reason before the release: still connect_failed (the call dropped).
      two.ws.server({ t: "error", code: "spend_cap" });
      two.ws.server({ t: "ended", reason: "budget", durationSec: 0, costMicros: 0, answerMsAvg: null });
      expect(b.log).toEqual(["mic_granted", "ready", "failed:connect_failed"]);
      two.c.dispose();
    });

    it("not ready in time (30 s from the socket) → connect_failed, and the call ends", async () => {
      const r = recorder();
      const { c, ws } = await connect({ hold: true, events: r.events });
      ws.server({ t: "call", maxSec: 270, mode: "scripted" });
      await vi.advanceTimersByTimeAsync(HOLD_CONNECT_MS + 10);
      expect(r.log).toEqual(["mic_granted", "failed:connect_failed"]);
      expect(ws.msgs().some((m) => m.t === "end")).toBe(true);
      c.dispose();
    });

    it("the page's own outcomes: failAttempt once (busy), then nothing more; a cancelled or ended attempt fires nothing", async () => {
      const r = recorder();
      const c = new VoiceClient({ getUserMedia: async () => stream });
      c.begin({ holdGreeting: true, events: r.events });
      await c.prepare();
      c.failAttempt("busy");
      c.unavailable("error");
      expect(r.log).toEqual(["mic_granted", "failed:busy"]);
      const q = recorder();
      const { c: c2, ws } = await connect({ hold: true, events: q.events });
      c2.end();
      ws.drop();
      await vi.advanceTimersByTimeAsync(HOLD_CONNECT_MS + 10);
      expect(q.log).toEqual(["mic_granted"]);
      c2.dispose();
    });

    it("the chat's POST refusals: unavailable → gate_refused; rate_limited, already_in_call → busy; others → other", () => {
      expect(startRefusal("unavailable")).toBe("gate_refused");
      expect(startRefusal("rate_limited")).toBe("busy");
      expect(startRefusal("already_in_call")).toBe("busy");
      expect(startRefusal("not_found")).toBe("other");
      expect(startRefusal(undefined)).toBe("other");
    });
  });
});
