/**
 * A call in which nothing was said (owner, 26 Nov 2026): no "Voice call ended · 0:00" line and no call row anywhere,
 * on every end path that stores the end line. PGlite, the FREE scripted models, a hand-moved clock; no paid call.
 * - Current (audio-out scripted model): the buyer hangs up before the agent's first word;
 * - Current, text-out + speaker (rt_eleven): hung up while the opener waits for the browser;
 * - Classic (frozen engine; this guard only): hung up before the first word;
 * - the pipeline engine (a chat that already has the agent's line: it listens first), hung up at once;
 * - the stale close (a heartbeat, then the relay went away) with no line stored;
 * - a call in which the agent spoke still gets its line and its rows (control);
 * - the buyer chat's call rows and the seller thread's markers leave such a call out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VOICE_CALL_ENDED_LINE, voiceMarkers } from "@/lib/agent/thread-markers";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { ClassicVoiceEngine } from "@/lib/voice-classic";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { closeStaleVoiceSessions, createVoiceSession, startVoiceTestConversation, STALE_HEARTBEAT_SEC } from "@/lib/voice/service";
import { buyerCallRows } from "@/lib/voice/buyer";
import { callHasLines } from "@/lib/voice/call-lines";
import { rtElevenProfile } from "@/lib/voice-rt-eleven/profile";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { handleVoiceSocket } from "@/lib/voice/socket";
import { ManualListener } from "@/lib/voice-pipeline/listener";
import { ScriptedLlm } from "@/lib/agent/llm";
import { EventEmitter } from "node:events";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

class FakeTextModel implements RealtimeModel {
  readonly modelId = "openai/gpt-realtime-2.1";
  readonly mode = "scripted" as const;
  async connect(_cfg: RealtimeSessionConfig, _onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, requestResponse: () => undefined, sendNote: () => undefined,
      cancelResponse: () => undefined, sendToolResult: () => undefined,
    };
  }
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "us", email: "us@p.test", firstName: "Uri", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "us-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  closed = false;
  send() {}
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit("close", code, ""));
  }
}

async function session(engine?: "classic" | "rt_eleven" | "pipeline") {
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(engine ? { engine } : {}) });
  if (!s.ok) throw new Error(s.reason);
  return { ...s, conversationId: c.conversationId };
}

/** What the call left: its end lines, its row, its call rows in the buyer chat and its markers in a seller thread. */
async function leftBy(sessionId: string, conversationId: string) {
  const endLines = (await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "system"))))
    .filter((m) => VOICE_CALL_ENDED_LINE.test(m.body));
  const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, sessionId));
  // The buyer chat shows real buyers' calls only: as one here.
  await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, sessionId));
  const buyerRows = await buyerCallRows(db, acc, [conversationId]);
  const lines = (await db.select().from(messages).where(eq(messages.voiceSessionId, sessionId))).length;
  const markers = voiceMarkers([{ ...row, lines }]);
  return { endLines, row, buyerRows, markers, lines };
}

const settleOf = (engine: { idle(): Promise<void> }) => async () => {
  for (let i = 0; i < 4; i++) {
    await flushAsync();
    await engine.idle();
  }
};

describe("a call in which nothing was said leaves no line and no row", () => {
  it("Current (audio-out): the model connected, the buyer hung up before the first word: no 0:00 line, no rows", async () => {
    const s = await session();
    const clock = new ManualClock();
    const engine = new VoiceEngine({ db, model: new ScriptedRealtime({ clock }), sessionId: s.sessionId, send: () => undefined, clock, limits: QUIET });
    const settle = settleOf(engine);
    await engine.start();
    await settle();
    engine.onClientMessage({ t: "end" });
    await settle();
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.row).toMatchObject({ status: "ended", durationSec: 0 });
    expect(r.row.connectedAt).not.toBeNull();
    expect(r.lines).toBe(0);
    expect(await callHasLines(db, acc, s.sessionId)).toBe(false);
    expect(r.endLines).toEqual([]);
    expect(r.buyerRows).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  it("Current, text-out + speaker (rt_eleven): hung up while the opener waited for the browser: no line, no rows", async () => {
    const s = await session("rt_eleven");
    const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0, 0));
    const engine = new VoiceEngine({
      db, model: new FakeTextModel(), sessionId: s.sessionId, send: () => undefined, clock, limits: { ...QUIET, waitForClientAudio: true },
      profile: rtElevenProfile("rt_eleven"), speaker: new ScriptedSpeaker("elevenlabs/eleven-v4-turbo"),
    });
    const settle = settleOf(engine);
    await engine.start();
    await settle();
    await clock.advance(2000, settle);
    engine.onClientMessage({ t: "end" });
    await settle();
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.row.status).toBe("ended");
    expect(r.endLines).toEqual([]);
    expect(r.buyerRows).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  it("Classic (frozen; this guard only): hung up before the first word: no line, no rows", async () => {
    const s = await session("classic");
    const clock = new ManualClock();
    const engine = new ClassicVoiceEngine({ db, model: new ScriptedRealtime({ clock }), sessionId: s.sessionId, send: () => undefined, clock, limits: QUIET });
    const settle = settleOf(engine);
    await engine.start();
    await settle();
    engine.onClientMessage({ t: "end" });
    await settle();
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.row.status).toBe("ended");
    expect(r.lines).toBe(0);
    expect(r.endLines).toEqual([]);
    expect(r.buyerRows).toEqual([]);
  });

  it("the pipeline engine: a call on a chat that already has the agent's line (it listens first), hung up at once: no line, no rows", async () => {
    const s = await session("pipeline");
    await db.insert(messages).values({ accountId: acc, conversationId: s.conversationId, actor: "agent", body: "Hi, how can I help?", language: "en" });
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 3));
      }
    };
    const done = handleVoiceSocket(ws as never, {
      db, deadlineSec: null, env: SCRIPTED, clock, log,
      pipeline: { listener: () => new ManualListener(), speaker: new ScriptedSpeaker("scripted"), llm: new ScriptedLlm([]) },
    });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.row.status).toBe("ended");
    expect(r.row.connectedAt).not.toBeNull();
    expect(r.lines).toBe(0);
    expect(r.endLines).toEqual([]);
    expect(r.buyerRows).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  it("the stale close (a heartbeat, then the relay went away) with nothing said: ended, no line", async () => {
    const s = await session();
    const connectedAt = new Date(Date.UTC(2026, 10, 26, 9, 0, 0));
    await db.update(voiceSessions).set({ status: "live", connectedAt, durationSec: 0 }).where(eq(voiceSessions.id, s.sessionId));
    expect(await closeStaleVoiceSessions(db, acc, new Date(connectedAt.getTime() + (STALE_HEARTBEAT_SEC + 5) * 1000))).toBeGreaterThanOrEqual(1);
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.row.status).toBe("ended");
    expect(r.endLines).toEqual([]);
    expect(r.buyerRows).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  it("control: a call in which the agent spoke keeps its end line and its rows", async () => {
    const s = await session();
    const clock = new ManualClock();
    const engine = new VoiceEngine({ db, model: new ScriptedRealtime({ clock }), sessionId: s.sessionId, send: () => undefined, clock, limits: QUIET });
    const settle = settleOf(engine);
    await engine.start();
    await settle();
    await clock.advance(15_000, settle);
    engine.onClientMessage({ t: "end" });
    await settle();
    const r = await leftBy(s.sessionId, s.conversationId);
    expect(r.lines).toBeGreaterThan(0);
    expect(r.endLines).toHaveLength(1);
    expect(r.buyerRows).toHaveLength(1);
    expect(r.markers.map((m) => m.kind)).toContain("voice_ended");
  });
});

describe("isUnsaidCall in the seller thread's markers", () => {
  const base = { connectedAt: new Date(1000), endedAt: new Date(2000), status: "ended", durationSec: 0 };
  it("no lines: no marker; lines unknown or some: as before; a running call keeps its start", () => {
    expect(voiceMarkers([{ ...base, lines: 0 }])).toEqual([]);
    expect(voiceMarkers([{ ...base }]).map((m) => m.kind)).toEqual(["voice_ended"]);
    expect(voiceMarkers([{ ...base, lines: 1 }]).map((m) => m.kind)).toEqual(["voice_ended"]);
    expect(voiceMarkers([{ ...base, status: "live", endedAt: null, lines: 0 }]).map((m) => m.kind)).toEqual(["voice_started"]);
  });
});
