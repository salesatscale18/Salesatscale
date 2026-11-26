/**
 * The hand-over's adapter (app/h/[token]/call-ready.ts) against the chat's REAL controls (chat-client.tsx
 * chatControls + startChatCall, the same functions ChatClient uses), the REAL browser voice client
 * (lib/voice/client/voice-client.ts, on fake audio objects) and the REAL relay (lib/voice/socket.ts) with the FREE
 * scripted model on PGlite: supportsHold is true, and startHeldCall drives a call to onReady with the greeting held
 * (the model is not asked for the opener), then release() makes the agent speak. No network, no paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { expectBuyer, say, ScriptedRealtime, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import { VoiceClient, type VoiceCallEvents } from "@/lib/voice/client/voice-client";
import { chatControls, listenerEvents, startChatCall } from "@/app/chat/[token]/chat-client";
import { startHeldCall, supportsHold } from "@/app/h/[token]/call-ready";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };

// -- The browser's audio objects (fakes; the clock is the real one) --------------------------------------------
const node = <T extends object>(extra: T = {} as T) => ({ connect() {}, disconnect() {}, ...extra });
const t0 = Date.now();
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

// -- The relay's side of the socket, and the browser's WebSocket bridged to it ------------------------------------
class ServerSocket extends EventEmitter implements VoiceSocket {
  bufferedAmount = 0;
  closed = false;
  constructor(private readonly toBrowser: (d: string | Uint8Array) => void, private readonly onClose: () => void) {
    super();
  }
  send(d: string | Uint8Array) {
    if (!this.closed) this.toBrowser(d);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      this.emit("close", code, reason);
      this.onClose();
    });
  }
}

let relay: { db: TestDb; clock: ManualClock; model: ScriptedRealtime } | null = null;
const browserSockets: BrowserSocket[] = [];
class BrowserSocket {
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
  readonly server: ServerSocket;
  done: Promise<void>;
  constructor(readonly url: string) {
    browserSockets.push(this);
    this.server = new ServerSocket(
      (d) => this.onmessage?.({ data: typeof d === "string" ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) }),
      () => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.();
      },
    );
    const r = relay!;
    this.done = handleVoiceSocket(this.server, { db: r.db, deadlineSec: null, env: SCRIPTED, clock: r.clock, model: r.model, limits: { standbyAfterQuietMs: 3_600_000 }, log: { info: () => undefined, warn: () => undefined } });
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: unknown) {
    if (this.readyState !== 1) return;
    if (typeof d === "string") {
      this.sent.push(d);
      this.server.emit("message", Buffer.from(d), false);
    } else if (d instanceof Uint8Array) this.server.emit("message", Buffer.from(d), true);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.emit("close", 1000, "client");
  }
}

const track = { stop() {}, enabled: true, readyState: "live", muted: false };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;

describe("the hand-over's adapter on the chat's real controls (scripted call)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-adapter", email: "adapter@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "adapter-acme@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    vi.stubGlobal("WebSocket", BrowserSocket);
    vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("supportsHold is true; startHeldCall: mic granted, ready with the greeting held (no opener asked), then release → the agent speaks", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock, defaultScript: [expectBuyer("anything"), say("Sure.")] });
    relay = { db, clock, model };
    const client = new VoiceClient({ getUserMedia: async () => stream });
    const listeners = new Set<VoiceCallEvents>();
    // The chat's POST /chat/<token>/voice, answered by the same function the route's gates end in (a ticket).
    const fetchImpl = (async () => {
      const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
      if (!s.ok) throw new Error(s.reason);
      return { json: async () => ({ ok: true, sessionId: s.sessionId, ticket: s.ticket, wsUrl: "ws://relay", mode: "scripted", maxSec: 270 }) };
    }) as unknown as typeof fetch;
    const controls = chatControls({
      startCall: (opts) => startChatCall(client, { token: "tok", holdGreeting: opts?.holdGreeting, events: listenerEvents(listeners), fetchImpl }),
      client: () => client, listeners, focusComposer: () => undefined,
    });

    expect(controls.canCall).toBe(true);
    expect(supportsHold(controls)).toBe(true);
    const log: string[] = [];
    const held = startHeldCall(controls, {
      onMicGranted: () => void log.push("mic_granted"),
      onReady: () => void log.push("ready"),
      onFailed: (r) => void log.push(`failed:${r}`),
      onNoEvents: () => void log.push("no_events"),
    });
    expect(held.mode).toBe("hold");
    // startCall ran synchronously inside startHeldCall: the audio context exists before anything was awaited.
    expect(client.getSnapshot().phase).not.toBe("idle");

    // The capture's first frame once the worklet exists (the mic is live).
    await vi.waitFor(() => expect(worklets.length).toBeGreaterThan(0), { timeout: 5_000 });
    worklets.at(-1)!.port.onmessage?.({ data: new Float32Array(128) });
    await vi.waitFor(() => expect(log).toContain("ready"), { timeout: 10_000, interval: 20 });
    expect(log).toEqual(["mic_granted", "ready"]);
    const ws = browserSockets.at(-1)!;
    expect(JSON.parse(ws.sent[0])).toMatchObject({ t: "auth", holdGreeting: true, waitAudio: true });
    // Held: nothing asked of the model, no `ready` from the browser, even as the relay's clock moves.
    await clock.advance(3_000, () => flushAsync(4));
    const conn = model.connections[0] as ScriptedConnection;
    expect(conn.sent.responses).toHaveLength(0);
    expect(ws.sent.some((m) => JSON.parse(m).t === "ready")).toBe(false);

    // The chat is on screen: release.
    if (held.mode === "hold") held.release();
    await vi.waitFor(() => expect(conn.sent.responses).toHaveLength(1), { timeout: 5_000, interval: 10 });
    expect(ws.sent.filter((m) => JSON.parse(m).t === "ready")).toHaveLength(1);
    // The agent's greeting reaches the page.
    for (let i = 0; i < 20 && !client.getSnapshot().items.some((it) => it.kind === "line" && it.role === "agent"); i++) {
      await clock.advance(500, () => flushAsync(4));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(client.getSnapshot().items.some((it) => it.kind === "line" && it.role === "agent")).toBe(true);
    expect(log).toEqual(["mic_granted", "ready"]);

    client.end();
    await clock.advance(200, () => flushAsync(4));
    await ws.done;
    client.dispose();
  });
});
