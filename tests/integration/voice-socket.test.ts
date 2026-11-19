/**
 * Live voice, the relay's socket (lib/voice/socket.ts) with a fake socket, the
 * FREE scripted model, a hand-moved clock and PGlite: the ticket is the only
 * way in (once, in time), frames are capped, every close path stops the
 * engine and stores the call. No paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VOICE_CLOSE, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { micPcm, ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { handleVoiceSocket, IDLE_TIMEOUT_MS, MAX_BUFFERED_AUDIO_BYTES, type VoiceSocket } from "@/lib/voice/socket";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET = { silenceAskMs: 3_600_000, silenceEndMs: 3_600_000 };

class FakeSocket extends EventEmitter implements VoiceSocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;
  pings = 0;
  send(d: string | Uint8Array) {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    setImmediate(() => this.emit("close", code, reason));
  }
  ping() {
    this.pings++;
  }
  text(o: unknown) {
    this.emit("message", Buffer.from(typeof o === "string" ? o : JSON.stringify(o)), false);
  }
  audio(bytes: Uint8Array) {
    this.emit("message", Buffer.from(bytes), true);
  }
  json(): ServerMessage[] {
    return this.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as ServerMessage);
  }
  binary() {
    return this.sent.filter((x) => typeof x !== "string").length;
  }
}

describe("voice relay socket (fake socket, scripted model)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "s", email: "s@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());

  async function newSession(createdAt?: Date) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, now: createdAt });
    if (!s.ok) throw new Error(s.reason);
    return { ...s, conversationId: c.conversationId };
  }

  function open(o: { deadlineSec?: number | null; clock?: ManualClock; env?: Record<string, string | undefined> } = {}) {
    const ws = new FakeSocket();
    const clock = o.clock ?? new ManualClock();
    const model = new ScriptedRealtime({ clock });
    let finished = false;
    const done = handleVoiceSocket(ws, { db, deadlineSec: o.deadlineSec ?? null, env: o.env ?? SCRIPTED, clock, model, limits: QUIET }).then(() => (finished = true));
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return { ws, clock, model, done, settle, run: (ms: number) => clock.advance(ms, settle), finished: () => finished };
  }

  const row = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];

  it("accepts a valid ticket, reports the call limit, runs the call and stores it when the browser ends it", async () => {
    const s = await newSession();
    const c = open({ deadlineSec: 270 });
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    expect(c.ws.json()[0]).toEqual({ t: "call", maxSec: 270, mode: "scripted" });
    expect(c.ws.json().map((m) => m.t)).toContain("state");
    await c.run(10_000); // the opener plays
    expect(c.ws.binary()).toBeGreaterThan(0);
    expect(c.ws.json().some((m) => m.t === "transcript" && m.role === "agent")).toBe(true);
    c.ws.text({ t: "end" });
    await c.run(100);
    await c.done;
    const ended = c.ws.json().find((m) => m.t === "ended");
    expect(ended).toMatchObject({ t: "ended", reason: "user_hangup", costMicros: 0 });
    expect(c.ws.closed?.code).toBe(VOICE_CLOSE.normal);
    expect((await row(s.sessionId))).toMatchObject({ status: "ended", endReason: "user_hangup" });
    expect(c.model.connections[0].closed).toBe(true);
  });

  it("refuses a wrong ticket, a used ticket and an expired one with a policy close", async () => {
    const s = await newSession();
    const bad = open();
    bad.ws.text({ t: "auth", sessionId: s.sessionId, ticket: "A".repeat(43) });
    await bad.settle();
    expect(bad.ws.json()).toEqual([{ t: "error", code: "ticket_invalid" }]);
    expect(bad.ws.closed?.code).toBe(VOICE_CLOSE.policy);
    await bad.done;
    expect((await row(s.sessionId)).ticketUsedAt).toBeNull();

    const first = open();
    first.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await first.settle();
    const reuse = open();
    reuse.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await reuse.settle();
    expect(reuse.ws.json()).toEqual([{ t: "error", code: "ticket_invalid" }]);
    expect(reuse.ws.closed?.code).toBe(VOICE_CLOSE.policy);
    first.ws.emit("close");
    await first.settle();
    await first.done;

    const old = await newSession(new Date(Date.now() - 61_000));
    const late = open();
    late.ws.text({ t: "auth", sessionId: old.sessionId, ticket: old.ticket });
    await late.settle();
    expect(late.ws.json()).toEqual([{ t: "error", code: "ticket_invalid" }]);
  });

  it("closes a socket that does not authenticate in time, or sends audio or junk first", async () => {
    const slow = open();
    await slow.run(5_001);
    expect(slow.ws.json()).toEqual([{ t: "error", code: "ticket_invalid" }]);
    expect(slow.ws.closed?.code).toBe(VOICE_CLOSE.policy);
    await slow.done;

    const audioFirst = open();
    audioFirst.ws.audio(micPcm(40, true));
    await audioFirst.settle();
    expect(audioFirst.ws.closed?.code).toBe(VOICE_CLOSE.policy);

    const junk = open();
    junk.ws.text("not json");
    await junk.settle();
    expect(junk.ws.closed?.code).toBe(VOICE_CLOSE.policy);
  });

  it("refuses a session whose mode is no longer on (never builds a model) and ends it", async () => {
    const s = await newSession();
    const ws = new FakeSocket();
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: {}, clock: new ManualClock() });
    ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ws.json()).toEqual([{ t: "error", code: "model_unavailable" }]);
    await done;
    expect(await row(s.sessionId)).toMatchObject({ status: "ended", errorCode: "model_unavailable" });
  });

  it("caps audio frames: too big dropped, odd byte trimmed, faster than twice real time dropped", async () => {
    const s = await newSession();
    const c = open();
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    const conn = () => c.model.connections[0];
    c.ws.audio(new Uint8Array(48_000 + 2)); // over 1 s: dropped
    await c.settle();
    expect(conn().sent.audioMs).toBe(0);
    c.ws.audio(new Uint8Array(961)); // odd: 960 bytes kept = 20 ms
    await c.settle();
    expect(conn().sent.audioMs).toBe(20);
    // 5 s of audio at once, no time passing: only about 2 s gets through.
    for (let i = 0; i < 125; i++) c.ws.audio(micPcm(40, false));
    await c.settle();
    expect(conn().sent.audioMs).toBeGreaterThan(1500);
    expect(conn().sent.audioMs).toBeLessThan(2500);
    c.ws.emit("close");
    await c.settle();
    await c.done;
  });

  it("drops agent audio (never JSON) when the socket backs up", async () => {
    const s = await newSession();
    const c = open();
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    c.ws.bufferedAmount = MAX_BUFFERED_AUDIO_BYTES + 1;
    await c.run(10_000);
    expect(c.ws.binary()).toBe(0);
    expect(c.ws.json().some((m) => m.t === "transcript")).toBe(true);
    c.ws.emit("close");
    await c.settle();
    await c.done;
  });

  it("a dropped socket or a socket error ends the call (connection_lost) and closes the model", async () => {
    for (const how of ["close", "error"] as const) {
      const s = await newSession();
      const c = open();
      c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
      await c.run(3_000);
      if (how === "close") c.ws.emit("close");
      else c.ws.emit("error", new Error("boom"));
      await c.settle();
      await c.done;
      expect(c.finished()).toBe(true);
      expect(await row(s.sessionId)).toMatchObject({ status: "ended", endReason: "connection_lost" });
      expect(c.model.connections[0].closed).toBe(true);
    }
  });

  it("a browser that goes silent (no frames, no pongs) is closed and the call ends", async () => {
    const s = await newSession();
    const c = open();
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    await c.run(IDLE_TIMEOUT_MS + 16_000);
    expect(c.ws.pings).toBeGreaterThan(0);
    expect(c.ws.closed?.code).toBe(VOICE_CLOSE.goingAway);
    await c.settle();
    await c.done;
    expect(await row(s.sessionId)).toMatchObject({ status: "ended", endReason: "connection_lost" });
  });

  it("messages that arrive while the ticket is checked are kept; junk after auth is ignored; handlers never throw", async () => {
    const s = await newSession();
    const c = open();
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    c.ws.text({ t: "mute", on: true });
    c.ws.text("{bad");
    c.ws.emit("message", 42, false);
    await c.settle();
    await c.run(5_000);
    c.ws.audio(micPcm(1000, true));
    await c.settle();
    // Muted (the early message reached the engine): the model heard nothing.
    expect(c.model.connections[0].sent.audioMs).toBe(0);
    expect(c.ws.closed).toBeNull();
    c.ws.text({ t: "end" });
    await c.run(100);
    await c.done;
    expect(await row(s.sessionId)).toMatchObject({ status: "ended", endReason: "user_hangup" });
  });
});
