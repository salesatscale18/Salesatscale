/**
 * The browser side of the first agent word (lib/voice/client/voice-client.ts) on the <audio> element route, against
 * fake browser objects (an audio context with a MediaStream destination, an <audio> element whose currentTime runs
 * or stands still, the capture worklet, a socket) and fake timers:
 * - the `ready` check's output step needs the element's currentTime to advance (play() resolving is not enough);
 *   a stalled element still lets `ready` go within the cap, reporting outAdvance=no; on a hand-over onReady fires
 *   only after the check.
 * - the lead-in: the call's first agent chunk starts >= 300 ms after the output was confirmed and after it arrived,
 *   with silence scheduled in front of it through the same output; the next chunk follows back to back.
 * - the `heard` report: sent once the element's own time reached the first chunk, with leadInMs and afterReleaseMs
 *   (from releaseGreeting(), the hand-over's chat on screen).
 * No network, no audio, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { GREETING_LEAD_IN_MS } from "@/lib/voice/client/playback";
import { READY_MAX_MS } from "@/lib/voice/client/readiness";

const node = <T extends object>(extra: T = {} as T) => ({ connect() {}, disconnect() {}, ...extra });

let t0 = 0;
/** Every buffer source started: when, and how long its buffer is (silence or agent audio). */
let starts: { at: number; dur: number; silent: boolean }[] = [];

class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  baseLatency = 0.01;
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
  createMediaStreamDestination() {
    return node({ stream: { id: "agent" } });
  }
  createBuffer(_ch: number, len: number, rate: number) {
    const b = { duration: len / rate, filled: false, copyToChannel() { b.filled = true; } };
    return b;
  }
  createBufferSource() {
    const src = node({
      buffer: null as null | { duration: number; filled: boolean }, onended: null as null | (() => void),
      start(at?: number) {
        starts.push({ at: at ?? (Date.now() - t0) / 1000, dur: src.buffer?.duration ?? 0, silent: !src.buffer?.filled });
        setTimeout(() => src.onended?.(), 150);
      },
      stop() {},
    });
    return src;
  }
}

/** The <audio> element: after play() its currentTime runs with the clock, unless `stalled` (Android's slow route). */
const audioEls: FakeAudio[] = [];
let stalled = false;
class FakeAudio {
  autoplay = false;
  srcObject: unknown = null;
  paused = true;
  readyState = 0;
  private playedAt: number | null = null;
  private listeners: Record<string, (() => void)[]> = {};
  constructor() {
    audioEls.push(this);
  }
  get currentTime() {
    return this.playedAt === null || stalled ? 0 : (Date.now() - this.playedAt) / 1000;
  }
  setAttribute() {}
  addEventListener(name: string, fn: () => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  play() {
    this.paused = false;
    this.readyState = 4;
    this.playedAt = Date.now();
    // "playing" fires even when the output does not really sound yet (what the page's old measure trusted).
    for (const fn of this.listeners.playing ?? []) fn();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
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
  audio(ms: number) {
    this.onmessage?.({ data: new ArrayBuffer(Math.round((24_000 * 2 * ms) / 1000)) });
  }
  msgs() {
    return this.sent.map((s) => JSON.parse(s) as { t: string } & Record<string, unknown>);
  }
  first(t: string) {
    return this.msgs().find((m) => m.t === t);
  }
}

const track = { stop() {}, enabled: true, readyState: "live", muted: false };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  starts = [];
  stalled = false;
  audioEls.length = 0;
  worklets.length = 0;
  sockets.length = 0;
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  vi.stubGlobal("document", { createElement: () => new FakeAudio(), addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  vi.stubGlobal("HTMLMediaElement", { prototype: { srcObject: null } });
  // The page's clock (the `heard` figures) runs with the fake timers.
  vi.stubGlobal("performance", { now: () => Date.now() - t0 });
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** begin → prepare → start → socket open, mic live (the readiness check starts). */
async function connect(o: { hold?: boolean; onReady?: () => void } = {}) {
  const c = new VoiceClient({ getUserMedia: async () => stream });
  c.begin({ holdGreeting: o.hold, events: o.onReady ? { onReady: o.onReady } : undefined });
  expect(await c.prepare()).toBe(true);
  expect(c.playbackRoute).toBe("element");
  c.start({ wsUrl: "ws://relay", sessionId: "s1", ticket: "t1" });
  const ws = sockets.at(-1)!;
  ws.open();
  worklets.at(-1)!.port.onmessage?.({ data: new Float32Array(128) });
  return { c, ws };
}
const accepted = (ws: FakeSocket) => {
  ws.server({ t: "call", maxSec: 270, mode: "scripted" });
  ws.server({ t: "state", state: "listening" });
};

describe("the first agent word on the <audio> element route", () => {
  it("ready: the output step waits for the element's currentTime to advance (>= 100 ms), then the primer; outAdvance=yes", async () => {
    const { ws } = await connect();
    await vi.advanceTimersByTimeAsync(READY_MAX_MS + 50);
    const ready = ws.first("ready")!;
    expect(ready).toMatchObject({ route: "element", outAdvance: "yes" });
    expect(ready.timedOut).toBeUndefined();
    const steps = ready.steps as Record<string, number>;
    // The element started playing at begin() (inside the tap); its time had to move 100 ms past the mic going live.
    expect(steps.out).toBeGreaterThanOrEqual(90);
    expect(steps.primer - steps.out).toBeGreaterThanOrEqual(150);
  });

  it("ready: an element whose currentTime never moves (play() resolved, `playing` fired): ready still goes within the cap, outAdvance=no; onReady only after the check", async () => {
    stalled = true;
    const log: string[] = [];
    const { c, ws } = await connect({ hold: true, onReady: () => void log.push(`ready@${Date.now() - t0}`) });
    accepted(ws);
    await vi.advanceTimersByTimeAsync(200);
    // The relay is ready, the element says "playing", but its time stands still: not ready yet.
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(READY_MAX_MS);
    expect(log).toHaveLength(1);
    expect(Number(log[0].split("@")[1])).toBeGreaterThanOrEqual(450);
    expect(Number(log[0].split("@")[1])).toBeLessThanOrEqual(READY_MAX_MS + 30);
    // Held: nothing sent until the release; then the report says the output never advanced.
    expect(ws.first("ready")).toBeUndefined();
    c.releaseGreeting();
    expect(ws.first("ready")).toMatchObject({ route: "element", timedOut: "out", outAdvance: "no", steps: { out: null } });
  });

  it("lead-in and heard on a hand-over: the first chunk 300 ms after it arrived (and after the output was confirmed), silence in front; heard with leadIn and afterRelease", async () => {
    const { c, ws } = await connect({ hold: true });
    accepted(ws);
    await vi.advanceTimersByTimeAsync(READY_MAX_MS + 50);
    const readyAtSec = (Date.now() - t0) / 1000;
    // The chat is on screen: the page releases the greeting.
    await vi.advanceTimersByTimeAsync(400);
    c.releaseGreeting();
    expect(ws.first("ready")).toBeDefined();
    // The relay's first agent audio arrives 250 ms after the release, a second chunk 40 ms later.
    await vi.advanceTimersByTimeAsync(250);
    starts = [];
    const arrived = (Date.now() - t0) / 1000;
    ws.audio(200);
    await vi.advanceTimersByTimeAsync(40);
    ws.audio(200);
    const [silence, first, second] = starts;
    expect(silence).toMatchObject({ silent: true });
    expect(silence.at).toBeCloseTo(arrived, 3);
    expect(silence.dur).toBeCloseTo(GREETING_LEAD_IN_MS / 1000, 2);
    expect(first.silent).toBe(false);
    expect(first.at - arrived).toBeCloseTo(0.3, 3);
    expect(first.at - readyAtSec).toBeGreaterThanOrEqual(0.3);
    // The second chunk follows the first back to back (no second lead-in).
    expect(second.at).toBeCloseTo(first.at + 0.2, 3);
    expect(starts).toHaveLength(3);
    // heard: once the element's own time reached the first chunk's start (~300 ms after arrival).
    await vi.advanceTimersByTimeAsync(200);
    expect(ws.first("heard")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    const heard = ws.first("heard")!;
    expect(heard).toMatchObject({ queuedMs: 300, leadInMs: 300 });
    expect(heard.sinceFirstChunkMs).toBeGreaterThanOrEqual(300);
    expect(heard.sinceFirstChunkMs).toBeLessThan(340);
    // From the release (the chat on screen) to the first word playing: 250 ms to arrive + the 300 ms lead-in.
    expect(heard.afterReleaseMs).toBeGreaterThanOrEqual(550);
    expect(heard.afterReleaseMs).toBeLessThan(600);
  });

  it("without a hold: the same lead-in; heard has no afterRelease", async () => {
    const { ws } = await connect();
    await vi.advanceTimersByTimeAsync(READY_MAX_MS + 50);
    accepted(ws);
    starts = [];
    ws.audio(200);
    expect(starts.map((s) => s.silent)).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(500);
    const heard = ws.first("heard")!;
    expect(heard.leadInMs).toBe(300);
    expect(heard).not.toHaveProperty("afterReleaseMs");
  });

  it("a stalled element: heard is not sent while its currentTime stands still (the context clock alone does not count)", async () => {
    const { ws } = await connect();
    await vi.advanceTimersByTimeAsync(READY_MAX_MS + 50);
    accepted(ws);
    stalled = true;
    ws.audio(200);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws.first("heard")).toBeUndefined();
  });
});
