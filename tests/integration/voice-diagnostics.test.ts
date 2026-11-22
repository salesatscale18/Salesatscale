/**
 * Live voice diagnostics (21 Nov 2026 incident: live calls that ended 0.3 s after connecting with no log line):
 * one-line logs through a fake logger, `usage.endDetail` on the session, the early-close retry with proven
 * session fields only, and one reconnect per closed connection (a session-closed and the socket's close are one
 * event). A fake model and the free scripted model; no paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine } from "@/lib/voice/engine";
import type { VoiceLog } from "@/lib/voice/log";
import { endDetailText } from "@/lib/voice/client/view";
import type { ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };

/** A fake logger: the lines, in order. */
function fakeLog() {
  const lines: { level: "info" | "warn"; line: string }[] = [];
  const log: VoiceLog = { info: (line) => lines.push({ level: "info", line }), warn: (line) => lines.push({ level: "warn", line }) };
  return { log, lines, text: () => lines.map((l) => l.line).join("\n") };
}

/** A model that says nothing on its own: the test drives its events. */
class FakeModel implements RealtimeModel {
  constructor(readonly modelId = "google/gemini-3.8-live") {}
  readonly mode = "scripted" as const; // never priced
  readonly conns: {
    cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; responses: (string | undefined)[]; closed: boolean;
    notes: string[]; toolResults: { name: string; result: Record<string, unknown> }[];
  }[] = [];
  failNext = 0;
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("gateway said no");
    }
    const c = { cfg, emit: onEvent, responses: [] as (string | undefined)[], closed: false, notes: [] as string[], toolResults: [] as { name: string; result: Record<string, unknown> }[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined,
      sendToolResult: (_id, name, result) => void c.toolResults.push({ name, result: result as Record<string, unknown> }),
      sendNote: (n) => void c.notes.push(n),
      requestResponse: (i) => void c.responses.push(i),
      close: () => void (c.closed = true),
    };
  }
}

class FakeSocket extends EventEmitter implements VoiceSocket {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  bufferedAmount = 0;
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit("close", code, Buffer.from(reason ?? "")));
  }
  text(o: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(o)), false);
  }
}

describe("voice diagnostics (fake logger, fake and scripted models)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "d", email: "d@p.test", firstName: "Dee", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "d-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  async function newSession() {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    return { ...s, conversationId: c.conversationId };
  }

  async function engineCall(model: RealtimeModel) {
    const s = await newSession();
    const clock = new ManualClock();
    const logs = fakeLog();
    const sent: (ServerMessage | Uint8Array)[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, log: logs.log, send: (m) => sent.push(m), limits: { env: {}, standbyAfterQuietMs: 600_000 } });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    await engine.start();
    await settle();
    return { ...s, engine, clock, logs, sent, settle, run: (ms: number) => clock.advance(ms, settle) };
  }

  const row = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
  const short = (id: string) => id.slice(0, 8);

  it("logs one line per step through the socket (accepted, model connected, client close, ended), never transcript text", async () => {
    const s = await newSession();
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const logs = fakeLog();
    const model = new ScriptedRealtime({ clock });
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model, log: logs.log, limits: { standbyAfterQuietMs: 600_000 } });
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    ws.text({ t: "auth", sessionId: s.sessionId, ticket: s.ticket });
    await settle();
    await clock.advance(10_000, settle);
    // The page closes (as a phone browser does): code 1001, "going away".
    ws.emit("close", 1001, Buffer.from("tab closed"));
    await settle();
    await done;
    const id = short(s.sessionId);
    const text = logs.text();
    expect(text).toContain(`[voice] ${id} socket accepted mode=scripted model=scripted for=google/gemini-3.8-live maxSec=270 test`);
    expect(text).toMatch(new RegExp(`\\[voice\\] ${id} model connected in \\d+ms \\(scripted\\)`));
    expect(text).toContain(`[voice] ${id} client socket closed code=1001 reason="tab closed"`);
    expect(text).toMatch(new RegExp(`\\[voice\\] ${id} ended reason=connection_lost code=- durationSec=10 activeSec=10 by=client_closed client=1001/"tab closed"`));
    expect(logs.lines.every((l) => l.line.startsWith(`[voice] ${id} `))).toBe(true);
    // The opener was spoken, but no spoken text, name or token reaches the logs.
    expect(text).not.toMatch(/automated assistant|Hi |ticket/i);
    expect(text).not.toContain(s.ticket);
    const r = await row(s.sessionId);
    expect(r.usage?.endDetail).toEqual({ by: "client_closed", clientClose: { code: 1001, reason: "tab closed" } });
  });

  it("the incident path: a clean model close before any audio is no normal end; one retry with proven fields and the opener again", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    expect(model.conns).toHaveLength(1);
    expect(model.conns[0].cfg.safe).toBeUndefined();
    expect(model.conns[0].responses).toHaveLength(1); // the opener
    await c.clock.advance(300);
    // Gemini closes the session cleanly 0.3 s in: a session-closed and then the socket's close, for ONE connection.
    model.conns[0].emit({ type: "closed", reason: "session ended" });
    model.conns[0].emit({ type: "closed", code: 1000, reason: "" });
    await c.settle();
    // One retry (not two reconnects that end the call): proven session fields only, and it says the opener.
    expect(model.conns).toHaveLength(2);
    expect(model.conns[1].cfg.safe).toBe(true);
    expect(model.conns[1].responses).toHaveLength(1);
    // No voice chosen on Gemini: no voice field on either connection (Gemini's own default, as before 21 Nov).
    expect(model.conns.map((x) => "voice" in x.cfg)).toEqual([false, false]);
    expect((await row(c.sessionId)).settings?.voice).toBe("model default");
    expect(c.engine.isEnded).toBe(false);
    expect(c.logs.text()).toContain(`[voice] ${short(c.sessionId)} model closed code=- reason="session ended" error=no after=300ms audio=no`);
    expect(c.logs.text()).toMatch(/retry after early close connected in \d+ms \(proven session fields only\)/);
    // It closes early again: the call ends as an error, model_closed_early, with the details stored.
    await c.clock.advance(200);
    model.conns[1].emit({ type: "closed", code: 1008, reason: "unsupported field", error: "invalid_request: unsupported field" });
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ endReason: "error", errorCode: "model_closed_early" });
    expect(r.usage?.endDetail).toEqual({
      by: "model_closed_early",
      modelClose: { code: 1008, reason: "unsupported field", msAfterConnect: 200, error: true },
      lastError: "invalid_request: unsupported field",
    });
    expect(c.sent).toContainEqual({ t: "error", code: "model_closed_early" });
    const text = c.logs.text();
    expect(text).toContain("call failing: model_closed_early (model_closed_early)");
    expect(text).toMatch(/ended reason=error code=model_closed_early durationSec=\d+ activeSec=\d+ by=model_closed_early model=1008\/"unsupported field"@200ms/);
    // The review shows it: the summary carries the detail, and the admin line reads it.
    const sum = await voiceSessionSummary(db, acc, c.conversationId);
    expect(sum?.endDetail?.by).toBe("model_closed_early");
    expect(endDetailText(sum?.endDetail)).toBe('by model_closed_early · model closed 1008 "unsupported field" after 200 ms with an error · error: invalid_request: unsupported field');
  });

  it("Gemini with no voice chosen sends no voice field (its own default), on the start and on every reconnect", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    expect("voice" in model.conns[0].cfg).toBe(false);
    expect((await row(c.sessionId)).settings?.voice).toBe("model default");
    model.conns[0].emit({ type: "audio", pcm: new Uint8Array(480) });
    await c.run(1_000);
    model.conns[0].emit({ type: "closed", code: 1011, reason: "" });
    await c.settle();
    expect(model.conns).toHaveLength(2);
    expect("voice" in model.conns[1].cfg).toBe(false);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("OpenAI's pinned default voice (alloy): sent at the start (stored); after a retry that dropped it, later connections omit it too", async () => {
    const model = new FakeModel("openai/gpt-realtime-2");
    const c = await engineCall(model);
    expect(model.conns[0].cfg.voice).toBe("alloy");
    expect((await row(c.sessionId)).settings?.voice).toBe("alloy");
    model.conns[0].emit({ type: "closed", code: 1007, reason: "invalid voice" });
    await c.settle();
    model.conns[1].emit({ type: "audio", pcm: new Uint8Array(480) });
    await c.run(1_000);
    // A later drop: the normal reconnect still has no pinned voice.
    model.conns[1].emit({ type: "closed", code: 1011, reason: "" });
    await c.settle();
    expect(model.conns).toHaveLength(3);
    expect(model.conns.map((x) => x.cfg.voice)).toEqual(["alloy", undefined, undefined]);
    expect(c.logs.text()).toMatch(/retry without pinned default voice connected in \d+ms \(proven session fields only\)/);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a voice the seller chose is kept on the safe retry", async () => {
    const s0 = await newSession();
    const [sess] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s0.sessionId));
    const { agentVersions } = await import("@/db/schema");
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.id, sess.agentVersionId!));
    await db.update(agentVersions).set({ voiceSettings: { ...v.voiceSettings, voice: "Kore" } }).where(eq(agentVersions.id, v.id));
    try {
      const model = new FakeModel();
      const c = await engineCall(model);
      model.conns[0].emit({ type: "closed", code: 1000, reason: "" });
      await c.settle();
      expect(model.conns.map((x) => x.cfg.voice)).toEqual(["Kore", "Kore"]);
      expect(model.conns[1].cfg.safe).toBe(true);
      expect(c.logs.text()).toMatch(/retry after early close connected/);
      expect((await row(c.sessionId)).settings?.voice).toBe("Kore");
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
    } finally {
      await db.update(agentVersions).set({ voiceSettings: v.voiceSettings }).where(eq(agentVersions.id, v.id));
    }
  });

  it("a close after the agent spoke is a normal drop: one reconnect (resumed, full config); a second drop ends it (connection_lost)", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    model.conns[0].emit({ type: "audio", pcm: new Uint8Array(480) });
    await c.clock.advance(5_000);
    model.conns[0].emit({ type: "closed", code: 1011, reason: "internal" });
    model.conns[0].emit({ type: "closed", code: 1011, reason: "internal" }); // the same connection again: ignored
    await c.settle();
    expect(model.conns).toHaveLength(2);
    expect(model.conns[1].cfg.safe).toBeUndefined();
    expect(model.conns[1].responses).toHaveLength(0);
    expect(c.engine.isEnded).toBe(false);
    model.conns[1].emit({ type: "audio", pcm: new Uint8Array(480) });
    model.conns[1].emit({ type: "closed", code: 1006, reason: "" });
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ endReason: "connection_lost", errorCode: "connection_lost" });
    expect(r.usage?.endDetail).toMatchObject({ by: "model_closed", modelClose: { code: 1006, reason: "", error: false } });
  });

  it("an early close that the retry fixes: the call goes on and ends normally (client end); the close stays on record", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    model.conns[0].emit({ type: "closed", code: 1000, reason: "bye" });
    await c.settle();
    model.conns[1].emit({ type: "audio", pcm: new Uint8Array(480) });
    await c.run(3_000);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ endReason: "user_hangup", errorCode: null });
    expect(r.usage?.endDetail).toMatchObject({ by: "client_end", modelClose: { code: 1000, reason: "bye", msAfterConnect: 0 } });
  });

  it("provider events we do not use and error events are logged once per type; the error is stored", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    // Mid-call (the model has spoken): errors are logged, not a refused setup (that case: voice-standby.test.ts).
    model.conns[0].emit({ type: "audio", pcm: new Uint8Array(480) });
    for (let i = 0; i < 3; i++) model.conns[0].emit({ type: "provider-event", kind: "unknown", name: "session-usage" });
    model.conns[0].emit({ type: "provider-event", kind: "error", name: "error:rate", message: "rate limited ".repeat(40) });
    model.conns[0].emit({ type: "provider-event", kind: "error", name: "error:rate", message: "again" });
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    const lines = c.logs.lines.filter((l) => l.line.includes("provider"));
    expect(lines.map((l) => l.level)).toEqual(["info", "warn"]);
    expect(lines[0].line).toBe(`[voice] ${short(c.sessionId)} provider unknown event session-usage`);
    expect(lines[1].line.length).toBeLessThan(300);
    expect((await row(c.sessionId)).usage?.endDetail?.lastError).toBe("again");
  });

  it("a model that cannot connect: logged with the error; the session keeps it (no tokens, endDetail only)", async () => {
    const model = new FakeModel();
    model.failNext = 1;
    const c = await engineCall(model);
    expect(c.engine.isEnded).toBe(true);
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ endReason: "error", errorCode: "model_unavailable" });
    expect(r.usage?.endDetail).toEqual({ by: "error", lastError: "gateway said no" });
    expect(c.logs.text()).toMatch(/model connect failed after \d+ms: gateway said no/);
  });

  describe("OpenAI realtime: the buyer's transcription completes after the answer started (live calls of 22 Nov 2026)", () => {
    type Sdk = Parameters<ServerEventMapper["map"]>[0];
    /** Feeds normalized SDK events through the real adapter mapping, as the Gateway connection does. */
    function openai(model: FakeModel) {
      const mapper = new ServerEventMapper();
      return (e: Record<string, unknown>) => { for (const x of mapper.map({ raw: {}, ...e } as Sdk)) model.conns[model.conns.length - 1].emit(x); };
    }
    const stored = async (sessionId: string) => (await db.select({ actor: messages.actor, body: messages.body, spokenAtMs: messages.spokenAtMs }).from(messages)
      .where(and(eq(messages.voiceSessionId, sessionId), eq(messages.accountId, acc))).orderBy(asc(messages.createdAt))).map((m) => [m.actor, m.body]);
    async function opener(c: Awaited<ReturnType<typeof engineCall>>, send: (e: Record<string, unknown>) => void) {
      send({ type: "response-created", responseId: "r0" });
      send({ type: "audio-delta", delta: "AAAA" });
      send({ type: "audio-transcript-delta", delta: "Hi, this is Maya from Acme." });
      send({ type: "audio-transcript-done", transcript: "Hi, this is Maya from Acme." });
      send({ type: "response-done", responseId: "r0", status: "completed" });
      await c.run(2_000);
    }

    it("the buyer's line is stored and shown before the answer that started before its transcription came", async () => {
      const model = new FakeModel("openai/gpt-realtime-2.1");
      const c = await engineCall(model);
      const send = openai(model);
      await opener(c, send);
      send({ type: "speech-started" });
      await c.run(1_500);
      send({ type: "response-created", responseId: "r1" });
      send({ type: "audio-delta", delta: "AAAA" });
      send({ type: "audio-transcript-delta", delta: "It starts at about 590 shekels per sensor." });
      await c.run(13);
      // The transcription of what the buyer said, after the answer to it started.
      send({ type: "input-transcription-completed", itemId: "i1", transcript: "How much is it?" });
      await c.settle();
      send({ type: "audio-transcript-done", transcript: "It starts at about 590 shekels per sensor." });
      send({ type: "response-done", responseId: "r1", status: "completed" });
      await c.run(1_000);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
      expect(await stored(c.sessionId)).toEqual([
        ["agent", "Hi, this is Maya from Acme."], ["buyer", "How much is it?"], ["agent", "It starts at about 590 shekels per sensor."],
      ]);
      // The live transcript: the buyer's line is timed from when they started speaking, before the answer.
      const finals = c.sent.filter((m): m is Extract<ServerMessage, { t: "transcript" }> => !(m instanceof Uint8Array) && m.t === "transcript" && m.final);
      const buyer = finals.find((m) => m.role === "buyer")!;
      const answer = finals.filter((m) => m.role === "agent").at(-1)!;
      expect(buyer.atMs).toBeLessThan(answer.atMs);
      // The answer was never stored as cut ("…") by the late buyer line.
      expect(finals.filter((m) => m.role === "agent").map((m) => m.text).some((t) => t.endsWith("…"))).toBe(false);
    });

    it("the buyer's speech overlaps the start of the answer: ONE agent line, as far as it was said (cut), after the buyer's line", async () => {
      const model = new FakeModel("openai/gpt-realtime-mini");
      const c = await engineCall(model);
      const send = openai(model);
      await opener(c, send);
      send({ type: "speech-started" });
      await c.run(1_500);
      send({ type: "response-created", responseId: "r1" });
      send({ type: "audio-delta", delta: "AAAA" });
      send({ type: "audio-transcript-delta", delta: "It starts at about 590 shek" });
      await c.run(300);
      // The buyer is still talking: OpenAI reports speech again, then the whole cancelled response's transcript.
      send({ type: "speech-started" });
      await c.settle();
      send({ type: "audio-transcript-done", transcript: "It starts at about 590 shekels per sensor, and the total depends" });
      send({ type: "response-done", responseId: "r1", status: "cancelled" });
      await c.run(1_000);
      send({ type: "input-transcription-completed", itemId: "i1", transcript: "How much is it per sensor?" });
      await c.run(1_000);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
      expect(await stored(c.sessionId)).toEqual([
        ["agent", "Hi, this is Maya from Acme."], ["buyer", "How much is it per sensor?"], ["agent", "It starts at about 590 shek…"],
      ]);
    });

    it("Gemini's order is unchanged: its buyer turn closes before the answer, and a barge-in keeps the cut line first", async () => {
      const model = new FakeModel();
      const c = await engineCall(model);
      const send = openai(model);
      await opener(c, send);
      send({ type: "transcript-fragment", speaker: "user", delta: "How much " });
      send({ type: "transcript-fragment", speaker: "user", delta: "is it?" });
      await c.run(1_000);
      // Each event arrives on its own (as over the socket): the engine's queue runs between them.
      send({ type: "audio-delta", delta: "AAAA" });
      await c.settle();
      send({ type: "transcript-fragment", speaker: "assistant", delta: "It starts at about 590 shekels per sensor, and" });
      await c.run(500);
      // The buyer cuts in, then speaks a new line.
      send({ type: "speech-started" });
      send({ type: "transcript-fragment", speaker: "user", delta: "Per month?" });
      await c.run(500);
      send({ type: "audio-delta", delta: "AAAA" });
      await c.settle();
      send({ type: "transcript-fragment", speaker: "assistant", delta: "No, once." });
      send({ type: "response-done", responseId: "r2", status: "completed" });
      await c.run(500);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
      expect(await stored(c.sessionId)).toEqual([
        ["agent", "Hi, this is Maya from Acme."], ["buyer", "How much is it?"], ["agent", "It starts at about 590 shekels per sensor, and…"],
        ["buyer", "Per month?"], ["agent", "No, once."],
      ]);
    });
  });

  describe("the language the call speaks, and an answer said twice after a cut with no words (22 Nov 2026 call 965cf4af)", () => {
    type Sdk = Parameters<ServerEventMapper["map"]>[0];
    function openai(model: FakeModel) {
      const mapper = new ServerEventMapper();
      return (e: Record<string, unknown>) => { for (const x of mapper.map({ raw: {}, ...e } as Sdk)) model.conns[model.conns.length - 1].emit(x); };
    }
    const spokenRows = async (sessionId: string) => (await db.select({ actor: messages.actor, body: messages.body, language: messages.language }).from(messages)
      .where(and(eq(messages.voiceSessionId, sessionId), eq(messages.accountId, acc))).orderBy(asc(messages.createdAt))).map((m) => [m.actor, m.body, m.language]);
    const HE_Q = "אתה יכולה לדבר גם בעברית?";
    const HE_CUT = "בוודאי. אז רק כדי לוודא, איך אתם בודקים את";
    const EN_REDO = "Sure, no problem. How do you currently check your fridge temperatures?";
    async function answer(c: Awaited<ReturnType<typeof engineCall>>, send: (e: Record<string, unknown>) => void, id: string, text: string, o: { done?: boolean } = {}) {
      send({ type: "response-created", responseId: id });
      send({ type: "audio-delta", delta: "AAAA" });
      await c.settle();
      send({ type: "audio-transcript-delta", delta: text });
      await c.settle();
      if (o.done !== false) {
        send({ type: "audio-transcript-done", transcript: text });
        send({ type: "response-done", responseId: id, status: "completed" });
        await c.run(500);
      }
    }
    async function hebrewThenFalseCut(gapMs: number, between?: string) {
      const model = new FakeModel("openai/gpt-realtime-mini");
      const c = await engineCall(model);
      const send = openai(model);
      await answer(c, send, "r0", "Hi, this is Maya from Acme.");
      send({ type: "speech-started" });
      await c.run(1_000);
      send({ type: "input-transcription-completed", itemId: "i1", transcript: HE_Q });
      await c.run(300);
      await answer(c, send, "r1", HE_CUT, { done: false });
      await c.run(700);
      // The echo of the agent's own voice on a loudspeaker: speech, then an empty transcription.
      send({ type: "speech-started" });
      await c.run(300);
      send({ type: "input-transcription-completed", itemId: "i2", transcript: between ?? "" });
      await c.run(gapMs);
      await answer(c, send, "r2", EN_REDO);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
      return { c, model };
    }

    it("a cut with no words, then another answer: both lines stay in the record (every line the buyer heard)", async () => {
      const { c, model } = await hebrewThenFalseCut(1_500);
      // A line that merely follows a cut one (different words) is never merged into it: a time-based merge hid
      // whole spoken lines from the record (22 Nov 2026).
      expect(await spokenRows(c.sessionId)).toEqual([
        ["agent", "Hi, this is Maya from Acme.", "en"], ["buyer", HE_Q, "he"], ["agent", `${HE_CUT}…`, "he"], ["agent", EN_REDO, "en"],
      ]);
      const finals = c.sent.filter((m): m is Extract<ServerMessage, { t: "transcript" }> => !(m instanceof Uint8Array) && m.t === "transcript" && m.final && m.role === "agent");
      const cutId = finals.find((m) => m.text.startsWith("בוודאי"))!.id;
      expect(finals.filter((m) => m.id === cutId).at(-1)!.text).toBe(`${HE_CUT}…`);
      // The model was told at once that the buyer now speaks Hebrew (OpenAI takes notes mid-call).
      expect(model.conns[0].notes).toEqual([expect.stringContaining("the buyer now speaks Hebrew. Speak Hebrew from now on, also after an interruption")]);
    });

    it("the buyer really spoke between, or the new line came much later: both lines are kept", async () => {
      const spoke = await hebrewThenFalseCut(1_500, "כן");
      expect((await spokenRows(spoke.c.sessionId)).map((r) => r[0])).toEqual(["agent", "buyer", "agent", "buyer", "agent"]);
      const later = await hebrewThenFalseCut(9_000);
      const rows = await spokenRows(later.c.sessionId);
      expect(rows.map((r) => r[0])).toEqual(["agent", "buyer", "agent", "agent"]);
      expect(String(rows[2][1]).endsWith("…")).toBe(true);
    });

    it("every instruction the engine injects names the language the call speaks now: tool guidance, the card reply, a reconnect", async () => {
      const model = new FakeModel("openai/gpt-realtime-mini");
      const c = await engineCall(model);
      const send = openai(model);
      await answer(c, send, "r0", "Hi, this is Maya from Acme.");
      send({ type: "speech-started" });
      await c.run(500);
      send({ type: "input-transcription-completed", itemId: "i1", transcript: "כמה זה עולה?" });
      await c.run(300);
      send({ type: "function-call-arguments-done", responseId: "r1", itemId: "f1", callId: "call-1", name: "search_catalog", arguments: JSON.stringify({ query: "" }) });
      await c.run(500);
      expect(model.conns[0].toolResults[0].result.message).toMatch(/Say it in Hebrew, the language you are speaking with the buyer\.$/);
      // A card number read out in Hebrew: the fixed reply in Hebrew.
      send({ type: "speech-started" });
      await c.run(500);
      send({ type: "input-transcription-completed", itemId: "i2", transcript: "הכרטיס שלי 4111 1111 1111 1111" });
      await c.run(300);
      expect(model.conns[0].responses.at(-1)).toContain("לביטחונך");
      // A reconnect starts in the language the call speaks now.
      model.conns[0].emit({ type: "audio", pcm: new Uint8Array(480) });
      model.conns[0].emit({ type: "closed", code: 1006, reason: "gone" });
      await c.run(1_000);
      expect(model.conns[1].cfg.instructions).toContain("Language: start in Hebrew");
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
    });

    it("Gemini: no note mid-call (it reads the language at its next connection); English calls get no language line", async () => {
      const model = new FakeModel();
      const c = await engineCall(model);
      const send = openai(model);
      send({ type: "transcript-fragment", speaker: "user", delta: "כמה זה עולה?" });
      send({ type: "audio-delta", delta: "AAAA" });
      await c.run(500);
      expect(model.conns[0].notes).toEqual([]);
      const en = new FakeModel("openai/gpt-realtime-mini");
      const e = await engineCall(en);
      const sendEn = openai(en);
      sendEn({ type: "speech-started" });
      await e.run(500);
      sendEn({ type: "input-transcription-completed", itemId: "i1", transcript: "How much is it?" });
      await e.run(300);
      sendEn({ type: "function-call-arguments-done", responseId: "r1", itemId: "f1", callId: "call-1", name: "search_catalog", arguments: JSON.stringify({ query: "" }) });
      await e.run(500);
      expect(String(en.conns[0].toolResults[0].result.message ?? "")).not.toContain("Say it in");
      expect(en.conns[0].notes).toEqual([]);
      for (const x of [c, e]) { x.engine.onClientMessage({ t: "end" }); await x.settle(); }
    });
  });

  describe("live call fixes of 22 Nov 2026 (evening)", () => {
    type Sdk = Parameters<ServerEventMapper["map"]>[0];
    function sdk(model: FakeModel) {
      const mapper = new ServerEventMapper();
      return (e: Record<string, unknown>) => { for (const x of mapper.map({ raw: {}, ...e } as Sdk)) model.conns[model.conns.length - 1].emit(x); };
    }
    const rows = async (sessionId: string) => (await db.select({ actor: messages.actor, body: messages.body }).from(messages)
      .where(and(eq(messages.voiceSessionId, sessionId), eq(messages.accountId, acc))).orderBy(asc(messages.createdAt))).map((m) => [m.actor, m.body]);

    it("a cut line re-said from its middle after an echo (\"Ja.\"): both lines stored, in order, with the buyer's line between", async () => {
      const model = new FakeModel();
      const c = await engineCall(model);
      const send = sdk(model);
      send({ type: "audio-delta", delta: "AAAA" });
      await c.settle();
      send({ type: "transcript-fragment", speaker: "assistant", delta: "Some calls may be recorded for quality review; I don't control the recording myself. So, how many fridges do you need" });
      await c.run(800);
      send({ type: "speech-started" });
      send({ type: "transcript-fragment", speaker: "user", delta: "Ja." });
      await c.run(300);
      send({ type: "audio-delta", delta: "AAAA" });
      await c.settle();
      send({ type: "transcript-fragment", speaker: "assistant", delta: "for quality review; I don't control the recording myself. So, how many fridges do you need to cover?" });
      send({ type: "response-done", responseId: "r2", status: "completed" });
      await c.run(500);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
      expect(await rows(c.sessionId)).toEqual([
        ["agent", "Some calls may be recorded for quality review; I don't control the recording myself. So, how many fridges do you need…"],
        ["buyer", "Ja."],
        ["agent", "for quality review; I don't control the recording myself. So, how many fridges do you need to cover?"],
      ]);
    });

    it("a Hebrew call books by the card: the guidance says the free times are in this chat (not a link) with the Hebrew line", async () => {
      const { BOOKING_CARD_LINE_HE } = await import("@/lib/voice/engine");
      const model = new FakeModel("openai/gpt-realtime-mini");
      const c = await engineCall(model);
      const send = sdk(model);
      send({ type: "speech-started" });
      await c.run(500);
      send({ type: "input-transcription-completed", itemId: "i1", transcript: "אני רוצה לקבוע שיחה עם נציג" });
      await c.run(300);
      send({ type: "function-call-arguments-done", responseId: "r1", itemId: "f1", callId: "call-1", name: "request_callback", arguments: JSON.stringify({ brief: "Wants to talk to a person", time: null }) });
      await c.run(500);
      const r = model.conns[0].toolResults.find((x) => x.name === "request_callback")!.result;
      expect(r.ok).toBe(true);
      expect(r.message).toContain("The booking card with the free times is now in this chat (a card to pick a time on, not a link you sent).");
      expect(r.message).toContain("Never say you sent a link");
      expect(r.message).toContain(`For example, in Hebrew: "${BOOKING_CARD_LINE_HE}"`);
      expect(r.message).toMatch(/Say it in Hebrew, the language you are speaking with the buyer\.$/);
      c.engine.onClientMessage({ t: "end" });
      await c.settle();
    });
  });

  it("control flow is visible: config at start, one line per note and per tool call, cleaned transcripts and audio anomalies (Gemini)", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    const mapper = new ServerEventMapper();
    const send = (e: Record<string, unknown>) => {
      for (const ev of mapper.map({ raw: null, ...e } as never)) model.conns.at(-1)!.emit(ev);
    };
    const id = short(c.sessionId);
    const text = () => c.logs.text();
    const cfg = model.conns[0].cfg;
    expect(text()).toContain(`model connected in 0ms (google/gemini-3.8-live) config=full instructions=${cfg.instructions.length} tools=${cfg.tools.length}`);
    expect(text()).toContain(`[voice] ${id} note sent: opener`);
    // An odd audio piece, a transcript with a marker, a tool call.
    send({ type: "response-created", responseId: "r0" });
    send({ type: "audio-delta", responseId: "r0", itemId: "a", delta: Buffer.from([1, 2, 3]).toString("base64") });
    send({ type: "audio-transcript-delta", delta: "<noise> Hi, this is Maya." });
    send({ type: "response-done", responseId: "r0", status: "completed" });
    await c.run(300);
    send({ type: "function-call-arguments-done", responseId: "r1", itemId: "f", callId: "call-1", name: "search_catalog", arguments: JSON.stringify({ query: "sensor" }) });
    await c.run(300);
    expect(text()).toContain(`[voice] ${id} agent audio: a piece with an odd byte count (carried to the next piece)`);
    expect(text()).toContain(`[voice] ${id} cleaned agent transcript: marker in a line`);
    expect(text()).toMatch(new RegExp(`\\[voice\\] ${id} tool search_catalog (ok|refused|failed) \\d+ms`));
    // A typed line is a note too; never its words.
    c.engine.onClientMessage({ t: "text", text: "Two sites please" });
    await c.run(300);
    expect(text()).toContain(`[voice] ${id} note sent: typed line`);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    expect(text()).toMatch(/ended reason=user_hangup .* diagnostics=audio-odd-bytes:1,cleaned-transcript:1/);
    expect(text()).not.toMatch(/Two sites|Maya|sensor"/);
  });
});
