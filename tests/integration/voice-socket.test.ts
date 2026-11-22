/**
 * Live voice, the relay's socket (lib/voice/socket.ts) with a fake socket, the
 * FREE scripted model, a hand-moved clock and PGlite: the ticket is the only
 * way in (once, in time), frames are capped, every close path stops the
 * engine and stores the call. No paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VOICE_CLOSE, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { micPcm, ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { closeStaleVoiceSessions, createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { FINAL_WRITE_TIMEOUT_MS } from "@/lib/voice/engine";
import type { VoiceLog } from "@/lib/voice/log";
import { handleVoiceSocket, IDLE_TIMEOUT_MS, MAX_BUFFERED_AUDIO_BYTES, type VoiceSocket } from "@/lib/voice/socket";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET = { standbyAfterQuietMs: 3_600_000 };

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

  function open(o: { deadlineSec?: number | null; clock?: ManualClock; env?: Record<string, string | undefined>; limits?: typeof QUIET } = {}) {
    const ws = new FakeSocket();
    const clock = o.clock ?? new ManualClock();
    const model = new ScriptedRealtime({ clock });
    let finished = false;
    const done = handleVoiceSocket(ws, { db, deadlineSec: o.deadlineSec ?? null, env: o.env ?? SCRIPTED, clock, model, limits: o.limits ?? QUIET }).then(() => (finished = true));
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

  it("standby through the socket: the model closes, a tap ({t:'wake'}) and speech wake it, the page closing ends it", async () => {
    const s = await newSession();
    const c = open({ limits: { standbyAfterQuietMs: 5_000 } });
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    await c.run(20_000); // opener, then 5 s of quiet
    const states = () => c.ws.json().filter((m): m is Extract<ServerMessage, { t: "state" }> => m.t === "state").map((m) => m.state);
    expect(states().at(-1)).toBe("standby");
    expect(c.model.connections[0].closed).toBe(true);
    // A tap on the bar.
    c.ws.text({ t: "wake" });
    await c.settle();
    expect(states().at(-1)).toBe("listening");
    expect(c.model.connections).toHaveLength(2);
    await c.run(6_000);
    expect(states().at(-1)).toBe("standby");
    // The buyer speaks: the mic audio keeps flowing to our server, which wakes the model.
    for (let i = 0; i < 6; i++) {
      c.ws.audio(micPcm(100, true));
      await c.run(100);
    }
    expect(c.model.connections).toHaveLength(3);
    expect(c.model.connections[2].sent.audioMs).toBeGreaterThanOrEqual(600);
    await c.run(5_000);
    // On standby again (or still answering): the page closes and the call ends at once.
    c.ws.emit("close");
    await c.settle();
    await c.done;
    expect(await row(s.sessionId)).toMatchObject({ status: "ended", endReason: "connection_lost" });
    expect(c.model.connections.every((x) => x.closed)).toBe(true);
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

  it("a browser that vanished without a close (process killed) is noticed within 45-60 s: model closed, real end time and duration stored", async () => {
    const s = await newSession();
    const c = open();
    c.ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await c.settle();
    // A live call: the browser pings every 10 s for a minute, then is gone (no close frame, no pong, nothing).
    for (let i = 0; i < 6; i++) {
      await c.run(10_000);
      c.ws.text({ t: "ping" });
    }
    const goneAt = c.clock.now();
    expect(c.ws.closed).toBeNull();
    await c.run(44_000);
    expect(c.ws.closed).toBeNull();
    await c.run(16_000);
    expect(c.ws.closed?.code).toBe(VOICE_CLOSE.goingAway);
    await c.settle();
    await c.done;
    expect(c.model.connections.every((x) => x.closed)).toBe(true);
    const r = await row(s.sessionId);
    expect(r).toMatchObject({ status: "ended", endReason: "connection_lost" });
    expect(r.usage?.endDetail).toMatchObject({ by: "client_idle" });
    // The end time is when the silence was noticed (45-60 s after the last frame), not a later cleanup.
    const endedMs = r.endedAt!.getTime() - r.connectedAt!.getTime();
    expect(endedMs).toBeGreaterThanOrEqual((goneAt - r.connectedAt!.getTime()) + 45_000);
    expect(endedMs).toBeLessThanOrEqual((goneAt - r.connectedAt!.getTime()) + 60_000);
    expect(r.durationSec).toBe(Math.round(endedMs / 1000));
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

  describe("the call's final row write survives a dropped browser (call dd2d537c, 22 Nov 2026)", () => {
    /** A Drizzle-like failure: the query text and its parameters in the message, the real reason on `cause`. */
    const dbError = () => Object.assign(new Error(`Failed query: update "voice_sessions" set "status" = $1\nparams: ended,{"audioInTokens":12,"secret":"usage json"}`), { cause: Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }) });
    /**
     * The test database, except the call's final row write ("status = ended" on voice_sessions): `plan` says what
     * each attempt does (fail, hang, or pass through to the database).
     */
    function scriptedDb(plan: ("fail" | "hang" | "ok")[]) {
      let n = 0;
      const attempts: string[] = [];
      const wrapped = new Proxy(db, {
        get(target, prop, recv) {
          // A stored agent line goes in one transaction (db/atomic.ts on PGlite).
          if (prop === "transaction") return (fn: never) => { attempts.push("tx"); return target.transaction(fn); };
          if (prop === "insert") return (table: unknown) => {
            if (table === messages) attempts.push("insert:messages");
            return target.insert(table as typeof messages);
          };
          if (prop !== "update") return Reflect.get(target, prop, recv);
          return (table: unknown) => {
            const real = target.update(table as typeof voiceSessions);
            if (table !== voiceSessions) return real;
            return new Proxy(real, {
              get(t, p2, r2) {
                if (p2 !== "set") return Reflect.get(t, p2, r2);
                return (values: Record<string, unknown>) => {
                  if (values.status !== "ended") return t.set(values as never);
                  const step = plan[n++] ?? "ok";
                  attempts.push(step);
                  if (step === "ok") return t.set(values as never);
                  const p = step === "fail" ? Promise.reject(dbError()) : new Promise(() => undefined);
                  p.catch(() => undefined);
                  const chain = { where: () => chain, returning: () => p, then: (a: never, b: never) => p.then(a, b) };
                  return chain;
                };
              },
            });
          };
        },
      });
      return { db: wrapped as TestDb, attempts };
    }
    function lines() {
      const out: { level: string; line: string }[] = [];
      const log: VoiceLog = { info: (l) => out.push({ level: "info", line: l }), warn: (l) => out.push({ level: "warn", line: l }), error: (l) => out.push({ level: "error", line: l }) };
      return { out, log };
    }
    async function call(plan: ("fail" | "hang" | "ok")[], untilMs = 30_000) {
      const s = await newSession();
      const ws = new FakeSocket();
      const clock = new ManualClock();
      const model = new ScriptedRealtime({ clock });
      const sdb = scriptedDb(plan);
      const l = lines();
      const kept: Promise<unknown>[] = [];
      const done = handleVoiceSocket(ws, { db: sdb.db, deadlineSec: null, env: SCRIPTED, clock, model, limits: QUIET, log: l.log, keepAlive: (w) => void kept.push(w) });
      const settle = async () => {
        for (let i = 0; i < 6; i++) {
          await flushAsync(4);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
      await settle();
      await clock.advance(untilMs, settle); // a heartbeat at 20 s
      return { s, ws, clock, model, done, settle, kept, attempts: sdb.attempts, logs: l.out };
    }
    const endLines = async (conversationId: string) => (await db.select().from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "system")))).filter((m) => m.body.startsWith("Voice call ended"));

    it("a browser that drops (1001): the end is handed to the host at once; a failed write is retried; the log has the cause, never the parameters", async () => {
      const c = await call(["fail", "ok"]);
      c.ws.emit("close", 1001, Buffer.from(""));
      expect(c.kept.length).toBeGreaterThan(0); // registered the moment the end started
      await c.settle();
      await c.done;
      await Promise.all(c.kept);
      expect(c.attempts.filter((x) => x !== "insert:messages" && x !== "tx")).toEqual(["fail", "ok"]);
      const r = await row(c.s.sessionId);
      expect(r).toMatchObject({ status: "ended", endReason: "connection_lost", durationSec: 30 });
      expect(r.usage?.endDetail).toMatchObject({ by: "client_closed", clientClose: { code: 1001 } });
      const failed = c.logs.find((x) => x.line.includes("final row write failed"))!;
      expect(failed.level).toBe("error");
      expect(failed.line).toMatch(/final row write failed \(attempt 1 of 2\): fetch failed code=ECONNRESET$/);
      expect(c.logs.map((x) => x.line).join("\n")).not.toMatch(/params|audioInTokens|usage json/);
      expect(await endLines(c.s.conversationId)).toHaveLength(1);
      expect(c.model.connections.every((x) => x.closed)).toBe(true);
    });

    it("a browser that drops while the agent speaks: the row is written first, then the cut line and the end line", async () => {
      const c = await call([], 1_500);
      const before = c.attempts.length;
      c.ws.emit("close", 1001, Buffer.from(""));
      await c.settle();
      await c.done;
      // The final row ("ok"), then the agent's cut line (its transaction) and the end line.
      expect(c.attempts.slice(before)).toEqual(["ok", "tx", "insert:messages"]);
      const said = await db.select().from(messages).where(and(eq(messages.conversationId, c.s.conversationId), eq(messages.actor, "agent")));
      expect(said.at(-1)?.body.endsWith("…")).toBe(true);
    });

    it("a write that hangs is given up after the timeout and tried again", async () => {
      const c = await call(["hang", "ok"]);
      c.ws.emit("close", 1001, Buffer.from(""));
      await c.settle();
      expect((await row(c.s.sessionId)).status).toBe("live");
      await c.clock.advance(FINAL_WRITE_TIMEOUT_MS, c.settle);
      await c.done;
      expect(c.attempts.filter((x) => x !== "insert:messages" && x !== "tx")).toEqual(["hang", "ok"]);
      expect(await row(c.s.sessionId)).toMatchObject({ status: "ended", endReason: "connection_lost", durationSec: 30 });
      expect(c.logs.some((x) => x.line.endsWith("final row write failed (attempt 1 of 2): timed out after 8000 ms"))).toBe(true);
    });

    it("both attempts fail: the row stays live for the stale close, which ends it at the last heartbeat with one end line", async () => {
      const c = await call(["fail", "fail"]);
      c.ws.emit("close", 1001, Buffer.from(""));
      await c.settle();
      await c.done;
      const live = await row(c.s.sessionId);
      expect(live).toMatchObject({ status: "live", durationSec: 20 });
      expect(c.logs.some((x) => x.line.endsWith("final row write failed (attempt 2 of 2): fetch failed code=ECONNRESET; left to the stale close"))).toBe(true);
      expect(await endLines(c.s.conversationId)).toHaveLength(0);
      // (Every account's stale rows: other tests here may leave some.)
      expect(await closeStaleVoiceSessions(db, null, new Date(live.connectedAt!.getTime() + 20_000 + 100_000))).toBeGreaterThanOrEqual(1);
      const r = await row(c.s.sessionId);
      expect(r).toMatchObject({ status: "ended", durationSec: 20 });
      expect(r.usage?.endDetail).toEqual({ by: "relay_gone" });
      expect(await endLines(c.s.conversationId)).toHaveLength(1);
    });

    it("the stale close got there first: the late final write leaves its row as it is (and the stale close never touches an ended row)", async () => {
      const c = await call([]);
      const live = await row(c.s.sessionId);
      // The function was frozen: the cron closed the row at its last heartbeat.
      expect(await closeStaleVoiceSessions(db, null, new Date(live.connectedAt!.getTime() + 20_000 + 100_000))).toBeGreaterThanOrEqual(1);
      expect((await row(c.s.sessionId)).status).toBe("ended");
      // The instance thaws and the browser's close arrives: the final write finds the row ended.
      c.ws.emit("close", 1001, Buffer.from(""));
      await c.settle();
      await c.done;
      const r = await row(c.s.sessionId);
      expect(r).toMatchObject({ status: "ended", durationSec: 20 });
      expect(r.usage?.endDetail).toEqual({ by: "relay_gone" });
      expect(c.logs.some((x) => x.line.includes("final row write: the row was already ended"))).toBe(true);
      expect(await endLines(c.s.conversationId)).toHaveLength(1);
      // And the other way: a row the call ended itself is never closed again.
      const d = await call([]);
      d.ws.emit("close", 1001, Buffer.from(""));
      await d.settle();
      await d.done;
      const ended = await row(d.s.sessionId);
      await closeStaleVoiceSessions(db, null, new Date(Date.now() + 3_600_000));
      expect(await row(d.s.sessionId)).toEqual(ended);
    });
  });
});
