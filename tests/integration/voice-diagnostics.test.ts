/**
 * Live voice diagnostics (21 Nov 2026 incident: live calls that ended 0.3 s after connecting with no log line):
 * one-line logs through a fake logger, `usage.endDetail` on the session, the early-close retry with proven
 * session fields only, and one reconnect per closed connection (a session-closed and the socket's close are one
 * event). A fake model and the free scripted model; no paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rateLimits, users, voiceSessions, type User } from "@/db/schema";
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
  readonly modelId = "google/gemini-3.8-live";
  readonly mode = "scripted" as const; // never priced
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; responses: (string | undefined)[]; closed: boolean }[] = [];
  failNext = 0;
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("gateway said no");
    }
    const c = { cfg, emit: onEvent, responses: [] as (string | undefined)[], closed: false };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, sendToolResult: () => undefined,
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
    expect(text).toContain(`[voice] ${id} socket accepted mode=scripted model=scripted maxSec=270 test`);
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
    // No voice chosen: the start pins the family default; the safe retry leaves it out (the working live config).
    expect(model.conns.map((x) => x.cfg.voice)).toEqual(["Puck", undefined]);
    expect("voice" in model.conns[1].cfg).toBe(false);
    expect((await row(c.sessionId)).settings?.voice).toBe("model default");
    expect(c.engine.isEnded).toBe(false);
    expect(c.logs.text()).toContain(`[voice] ${short(c.sessionId)} model closed code=- reason="session ended" error=no after=300ms audio=no`);
    expect(c.logs.text()).toMatch(/retry without pinned default voice connected in \d+ms \(proven session fields only\)/);
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

  it("the pinned default voice: sent at the start (stored); after a retry that dropped it, later connections omit it too", async () => {
    const model = new FakeModel();
    const c = await engineCall(model);
    expect(model.conns[0].cfg.voice).toBe("Puck");
    expect((await row(c.sessionId)).settings?.voice).toBe("Puck");
    model.conns[0].emit({ type: "closed", code: 1007, reason: "invalid voice" });
    await c.settle();
    model.conns[1].emit({ type: "audio", pcm: new Uint8Array(480) });
    await c.run(1_000);
    // A later drop: the normal reconnect still has no pinned voice.
    model.conns[1].emit({ type: "closed", code: 1011, reason: "" });
    await c.settle();
    expect(model.conns).toHaveLength(3);
    expect(model.conns.map((x) => x.cfg.voice)).toEqual(["Puck", undefined, undefined]);
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
});
