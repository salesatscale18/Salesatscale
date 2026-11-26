/**
 * The held greeting (the lead page hand-over: the chat shows first, then the agent speaks), on the relay side, with
 * the FREE scripted realtime model, a hand-moved clock and PGlite. No paid call.
 *
 * - Auth `holdGreeting` (lib/voice/socket.ts → engine limits.holdGreeting): the opening line is not asked of the model
 *   until the browser's `ready` (the page's releaseGreeting), however long that takes up to 15 s; buyer audio does
 *   not reach the model meanwhile; the release asks for it at once.
 * - Not released within 15 s: the call ends as not started: no opening line, endReason not_started, no duration, no
 *   cost (a live-priced model too: never more than a call ended at once), no "call ended" line, no recording kept and
 *   the recording line still due on the next call.
 * - "Protect the opening line" applies from the release (the hold does not use up its 20 s cap).
 * - Without holdGreeting nothing changes (waitAudio: the opener at `ready` or after 3 s; without it: at once).
 * - Classic (Old baseline) holds too (its minimal hold); the retired pipeline engines refuse holdGreeting.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { VOICE_HOLD_GREETING_MS, VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { VOICE_SAMPLE_RATE, parseAuthMessage, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeModel } from "@/lib/voice/realtime";
import { expectBuyer, micPcm, say, ScriptedRealtime, type Script, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { OPENER_PROTECT_CAP_MS } from "@/lib/voice/settings";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import { MemoryRecordingStore } from "@/lib/voice/recording";
import { ClassicVoiceEngine } from "@/lib/voice-classic";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET = { standbyAfterQuietMs: 3_600_000 };
const SHORT: Script = [expectBuyer("anything"), say("Sure, happy to help.")];

class FakeSocket extends EventEmitter implements VoiceSocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;
  send(d: string | Uint8Array) {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    setImmediate(() => this.emit("close", code, reason));
  }
  text(o: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(o)), false);
  }
  json(): ServerMessage[] {
    return this.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as ServerMessage);
  }
}

describe("held greeting (scripted model, fake clock)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-hold", email: "hold@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "hold-acme@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  const row = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
  const endLines = async (conversationId: string) => (await db.select().from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "system")))).length;

  async function session(o: { buyerCall?: boolean; engine?: "classic" | "pipeline" } = {}) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(o.engine ? { engine: o.engine } : {}) });
    if (!s.ok) throw new Error(s.reason);
    if (o.buyerCall) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
    return { ...s, conversationId: c.conversationId, versionId: c.version.id };
  }

  /** A call on the engine itself. `live`: the scripted model priced as a live model (no paid call is made). */
  async function newCall(o: { limits?: VoiceLimits; wordMs?: number; live?: boolean; classic?: boolean; store?: MemoryRecordingStore; buyerCall?: boolean } = {}) {
    const s = await session({ buyerCall: o.buyerCall });
    const clock = new ManualClock();
    const scripted = new ScriptedRealtime({ clock, defaultScript: SHORT, wordMs: o.wordMs ?? 250 });
    const model: RealtimeModel = o.live
      ? { modelId: "google/gemini-3.8-live", mode: "live", connect: (cfg, on) => scripted.connect(cfg, on) }
      : scripted;
    const sent: (ServerMessage | Uint8Array)[] = [];
    const lines: string[] = [];
    const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) };
    const limits: VoiceLimits = { env: {}, ...QUIET, ...o.limits };
    const engine = o.classic
      ? new ClassicVoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits, log })
      : new VoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits, log, ...(o.store ? { recording: { store: o.store, reason: "test store" } } : {}) });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    const speak = async (ms: number) => {
      const pcm = micPcm(ms, true);
      const bytes = (VOICE_SAMPLE_RATE * 2 * 100) / 1000;
      for (let at = 0; at < pcm.byteLength; at += bytes) {
        engine.onClientAudio(pcm.subarray(at, Math.min(pcm.byteLength, at + bytes)));
        await run(100);
      }
    };
    await engine.start();
    await settle();
    const conn = () => scripted.connections.at(-1)! as ScriptedConnection;
    const json = () => sent.filter((m): m is ServerMessage => !(m instanceof Uint8Array));
    const audio = () => sent.filter((m) => m instanceof Uint8Array).length;
    return { ...s, engine, clock, lines, run, speak, conn, json, audio, settle };
  }

  const HOLD: VoiceLimits = { waitForClientAudio: true, holdGreeting: true };

  it("the opener is not asked for until the page releases it (10 s here); buyer audio does not reach the model meanwhile; the release asks at once", async () => {
    const c = await newCall({ limits: HOLD });
    expect(c.json().some((m) => m.t === "state" && m.state === "listening")).toBe(true);
    await c.run(5_000);
    await c.speak(1_000);
    await c.run(4_000);
    expect(c.conn().sent.responses).toHaveLength(0);
    expect(c.conn().sent.audioMs).toBe(0);
    expect(c.audio()).toBe(0);
    expect(c.engine.isEnded).toBe(false);
    c.engine.onClientMessage({ t: "ready", waitedMs: 120 });
    await c.settle();
    expect(c.conn().sent.responses).toHaveLength(1);
    await c.run(3_000);
    expect(c.audio()).toBeGreaterThan(0);
    expect(c.json().some((m) => m.t === "transcript" && m.role === "agent")).toBe(true);
    // A second ready changes nothing (one opener).
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(c.conn().sent.responses).toHaveLength(1);
    await c.engine.stop("user_hangup");
    expect(await row(c.sessionId)).toMatchObject({ status: "ended", endReason: "user_hangup" });
  });

  it("not released within 15 s: ended as not started, no opener, no duration, no cost, no end line; the recording is not kept and its line stays due", async () => {
    const store = new MemoryRecordingStore();
    const c = await newCall({ limits: HOLD, store });
    await c.run(VOICE_HOLD_GREETING_MS - 100);
    expect(c.engine.isEnded).toBe(false);
    await c.run(200);
    await c.engine.idle();
    expect(c.engine.isEnded).toBe(true);
    expect(c.conn().sent.responses).toHaveLength(0);
    expect(c.audio()).toBe(0);
    expect(c.conn().closed).toBe(true);
    expect(c.json().find((m) => m.t === "ended")).toMatchObject({ t: "ended", reason: "not_started", durationSec: 0, costMicros: 0 });
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ status: "ended", endReason: "not_started", durationSec: 0, costMicros: 0, recordingNoticeSaid: false, recordingState: "off", recordingChunks: 0 });
    expect(await store.list(r.recordingRef ?? "-")).toEqual([]);
    expect(c.lines.some((l) => l.includes("recording dropped: the call never started"))).toBe(true);
    expect((r.usage as { endDetail?: { by: string } } | null)?.endDetail?.by).toBe("not_started");
    expect(await endLines(c.conversationId)).toBe(0);
    expect(c.lines.some((l) => /held greeting not released after \d+ms: the call ends as not started/.test(l))).toBe(true);
    // A late ready does nothing.
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(c.conn().sent.responses).toHaveLength(0);
  });

  it("billing: a not-started call on a live-priced model costs nothing and is never billed beyond a call ended at once", async () => {
    const held = await newCall({ limits: HOLD, live: true });
    await held.run(VOICE_HOLD_GREETING_MS + 500);
    await held.engine.idle();
    const heldRow = await row(held.sessionId);
    expect(heldRow).toMatchObject({ endReason: "not_started", durationSec: 0, costMicros: 0 });
    // The same model, a call that ended at once (today's path).
    const now = await newCall({ live: true });
    await now.engine.stop("user_hangup");
    const nowRow = await row(now.sessionId);
    expect(heldRow.costMicros).toBeLessThanOrEqual(nowRow.costMicros ?? 0);
    expect(heldRow.durationSec).toBeLessThanOrEqual(nowRow.durationSec ?? 0);
    // Held for 15 s without the not-started rule it would have cost the duration floor: the rule is what keeps it at 0.
    const longer = await newCall({ live: true });
    await longer.run(VOICE_HOLD_GREETING_MS);
    await longer.engine.stop("user_hangup");
    expect((await row(longer.sessionId)).costMicros).toBeGreaterThan(0);
  });

  it("\"Protect the opening line\" starts at the release: held 12 s, the opener is still protected 9 s later (past 20 s from go-live)", async () => {
    // A word every 2 s: the opener plays for a long while.
    const c = await newCall({ limits: HOLD, wordMs: 2_000 });
    const protect = () => c.lines.filter((l) => l.includes("opener protected"));
    expect(protect()).toEqual([]);
    await c.run(12_000);
    expect(protect()).toEqual([]);
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(protect()).toEqual([expect.stringMatching(/opener protected: on$/)]);
    await c.run(9_000);
    // 21 s after go-live, 9 s after the release: the buyer still cannot cut the greeting.
    await c.speak(600);
    expect(c.conn().sent.audioMs).toBe(0);
    expect(c.json().some((m) => m.t === "flush")).toBe(false);
    // Released at the cap counted from the release.
    await c.run(OPENER_PROTECT_CAP_MS - 9_600 + 100);
    expect(protect().at(-1)).toMatch(/opener protected: off after 20000ms$/);
    await c.engine.stop("user_hangup");
  });

  it("without holdGreeting nothing changes: waitAudio asks for the opener at `ready` or after 3 s; without waitAudio at once", async () => {
    const wait = await newCall({ limits: { waitForClientAudio: true } });
    await wait.run(2_900);
    expect(wait.conn().sent.responses).toHaveLength(0);
    await wait.run(200);
    expect(wait.conn().sent.responses).toHaveLength(1);
    expect(wait.lines.some((l) => /opening waited \d+ms for the browser's audio \(timeout\)/.test(l))).toBe(true);
    await wait.engine.stop("user_hangup");
    const ready = await newCall({ limits: { waitForClientAudio: true } });
    ready.engine.onClientMessage({ t: "ready" });
    await ready.settle();
    expect(ready.conn().sent.responses).toHaveLength(1);
    await ready.engine.stop("user_hangup");
    const now = await newCall();
    expect(now.conn().sent.responses).toHaveLength(1);
    // Protection (a test call) from go-live, as before.
    expect(now.lines.some((l) => /opener protected: on$/.test(l))).toBe(true);
    await now.engine.stop("user_hangup");
  });

  it("Classic (Old baseline): the same hold (opener at the release; not released: not started, no cost); without it the opener at once", async () => {
    const c = await newCall({ classic: true, limits: HOLD });
    await c.run(8_000);
    await c.speak(500);
    expect(c.conn().sent.responses).toHaveLength(0);
    expect(c.conn().sent.audioMs).toBe(0);
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(c.conn().sent.responses).toHaveLength(1);
    await c.engine.stop("user_hangup");
    const late = await newCall({ classic: true, limits: HOLD });
    await late.run(VOICE_HOLD_GREETING_MS + 100);
    await late.engine.idle();
    expect(late.conn().sent.responses).toHaveLength(0);
    expect(await row(late.sessionId)).toMatchObject({ status: "ended", endReason: "not_started", durationSec: 0, costMicros: 0 });
    expect(await endLines(late.conversationId)).toBe(0);
    const plain = await newCall({ classic: true, limits: { waitForClientAudio: true } });
    expect(plain.conn().sent.responses).toHaveLength(1);
    await plain.engine.stop("user_hangup");
  });

  describe("through the relay socket", () => {
    function open(env = SCRIPTED) {
      const ws = new FakeSocket();
      const clock = new ManualClock();
      const model = new ScriptedRealtime({ clock, defaultScript: SHORT });
      const done = handleVoiceSocket(ws, { db, deadlineSec: null, env, clock, model, limits: QUIET, log: { info: () => undefined, warn: () => undefined } });
      const settle = async () => {
        for (let i = 0; i < 6; i++) {
          await flushAsync(4);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      return { ws, clock, model, done, settle, run: (ms: number) => clock.advance(ms, settle) };
    }

    it("auth holdGreeting is parsed (only a true boolean) and reaches the engine: no opener until the browser's ready", async () => {
      expect(parseAuthMessage(JSON.stringify({ t: "auth", sessionId: "s", ticket: "t", waitAudio: true, holdGreeting: true }))).toEqual({ t: "auth", sessionId: "s", ticket: "t", waitAudio: true, holdGreeting: true });
      expect(parseAuthMessage(JSON.stringify({ t: "auth", sessionId: "s", ticket: "t", holdGreeting: "yes" }))).toEqual({ t: "auth", sessionId: "s", ticket: "t" });
      const s = await session();
      const c = open();
      c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true, holdGreeting: true });
      await c.settle();
      await c.run(6_000);
      const conn = c.model.connections[0] as ScriptedConnection;
      expect(conn.sent.responses).toHaveLength(0);
      c.ws.text({ t: "ready", waitedMs: 200 });
      await c.settle();
      expect(conn.sent.responses).toHaveLength(1);
      c.ws.text({ t: "end" });
      await c.run(100);
      await c.done;
    });

    it("auth without holdGreeting: as before (the opener after 3 s without ready)", async () => {
      const s = await session();
      const c = open();
      c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true });
      await c.settle();
      await c.run(3_100);
      expect((c.model.connections[0] as ScriptedConnection).sent.responses).toHaveLength(1);
      c.ws.text({ t: "end" });
      await c.run(100);
      await c.done;
    });

    it("the socket closes on a not-started call with its `ended` (not_started) first", async () => {
      const s = await session();
      const c = open();
      c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true, holdGreeting: true });
      await c.settle();
      await c.run(VOICE_HOLD_GREETING_MS + 200);
      await c.done;
      expect(c.ws.json().find((m) => m.t === "ended")).toMatchObject({ reason: "not_started", durationSec: 0, costMicros: 0 });
      expect(c.ws.closed).not.toBeNull();
    });

    it("a retired pipeline engine refuses holdGreeting cleanly (no model, the session ended unstarted)", async () => {
      const s = await session({ engine: "pipeline" });
      const c = open();
      c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true, holdGreeting: true });
      await c.settle();
      await c.done;
      expect(c.ws.json()).toEqual([{ t: "error", code: "model_unavailable" }]);
      expect(await row(s.sessionId)).toMatchObject({ status: "ended", endReason: "error", errorCode: "model_unavailable", durationSec: 0 });
    });
  });
});
