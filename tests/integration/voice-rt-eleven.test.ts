/**
 * The realtime + ElevenLabs engines (lib/voice-rt-eleven: "rt_eleven" on GPT-Realtime 2.1, "rt_eleven_mini" on
 * GPT-Realtime mini) on PGlite with free fakes and a hand-moved clock: a model whose TEXT events the test emits (or the
 * scripted realtime model in text mode) and the scripted speaker (a tone). No paid call, no network.
 * - the session is configured for text output (no voice), with the guarded profile (instructions, tools);
 * - the opener is spoken after the browser's ready; a plain reply is spoken once and stored as the exact text handed
 *   to the speaker, with its answer time;
 * - a response with text AND a tool call: its text is dropped (never spoken, never stored); the response after the
 *   results is spoken once (one agent line);
 * - the guards fire as in guarded (the order form held; a held quote's say_this, then spoken);
 * - barge-in mid-speech: audio stops, flush, one note to the model, the stored line keeps what played ("…");
 * - the recording's agent channel holds the spoken audio; the cost counts the speech characters;
 * - the relay runs the engine for an rt_eleven session (text output, the scripted speaker, logs, settings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { HELD_QUOTE_SAY, VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { micPcm, ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import { MemoryRecordingStore } from "@/lib/voice/recording";
import type { VoiceLog } from "@/lib/voice/log";
import { guardedTools } from "@/lib/voice-guarded/profile";
import { rtElevenProfile } from "@/lib/voice-rt-eleven/profile";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { PIPELINE_VOICE_NAME, SPEAK_MICROS_PER_CHAR } from "@/lib/voice-pipeline/models";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

const memLog = () => {
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  return { lines, log };
};

type Conn = { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[]; responses: (string | undefined)[]; notes: string[]; texts: string[]; cancels: number };

/** A text-output model whose events the test emits by hand; records everything the engine sends it. */
class FakeTextModel implements RealtimeModel {
  readonly conns: Conn[] = [];
  constructor(readonly modelId = "openai/gpt-realtime-2.1", readonly mode: "scripted" | "live" = "scripted") {}
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c: Conn = { cfg, emit: onEvent, results: [], responses: [], notes: [], texts: [], cancels: 0 };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: (t) => void c.texts.push(t), close: () => undefined,
      requestResponse: (t) => void c.responses.push(t), sendNote: (n) => void c.notes.push(n), cancelResponse: () => void c.cancels++,
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: result as Record<string, unknown> }),
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
  [me] = await db.insert(users).values({ clerkId: "r", email: "r@p.test", firstName: "Rae", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "r-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [{ sku: "SENSOR", name: "Temperature sensor", unit: "unit" }]);
  await seedPricing(db, acc, [{ sku: "SENSOR", oneTime: 45_000, recurring: 1_770 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const agentRows = async (conversationId: string) => (await db.select().from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt)))
  .filter((m) => m.voiceSessionId);
const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
const isFrame = (m: unknown): m is Uint8Array => m instanceof Uint8Array;

async function rtCall(o: { engine?: "rt_eleven" | "rt_eleven_mini"; mode?: "scripted" | "live"; store?: MemoryRecordingStore | null; speaker?: ScriptedSpeaker | null; current?: boolean } = {}) {
  const engineName = o.engine ?? "rt_eleven";
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: engineName });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock(Date.UTC(2026, 10, 24, 10, 0, 0));
  const model = new FakeTextModel(engineName === "rt_eleven" ? "openai/gpt-realtime-2.1" : "openai/gpt-realtime-mini", o.mode ?? "scripted");
  const speaker = o.speaker === null ? null : o.speaker ?? new ScriptedSpeaker("elevenlabs/eleven-v4-turbo");
  const { lines: logs, log } = memLog();
  const sent: unknown[] = [];
  const store = o.store ?? null;
  const engine = new VoiceEngine({
    db, model, sessionId: s.sessionId, clock, send: (m) => void sent.push(m), log, limits: { ...QUIET, waitForClientAudio: true },
    recording: { store, reason: store ? "test store" : "no store (test)" },
    // `current`: Current's wiring (no profile) with ElevenLabs output; else the retired rt engine (the guarded profile).
    ...(o.current ? {} : { profile: rtElevenProfile(engineName) }), ...(speaker ? { speaker } : {}),
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  const conn = () => model.conns.at(-1)!;
  /** One complete model response: its text (and tool calls), then its end. */
  const respond = async (text: string, toolCalls = 0, ms = 100) => {
    conn().emit({ type: "response-started" });
    conn().emit({ type: "response-text", text, toolCalls });
    conn().emit({ type: "turn-done" });
    await run(ms);
  };
  /** The buyer said a line (OpenAI: speech stopped, then the transcription). */
  const buyerSays = async (text: string) => {
    conn().emit({ type: "speech-started" });
    conn().emit({ type: "trace", what: "buyer speech stopped" });
    conn().emit({ type: "buyer-transcript", text, final: true });
    await run(50);
  };
  const tool = async (callId: string, name: string, args: unknown, preText = "") => {
    conn().emit({ type: "tool-call", callId, name, args });
    await respond(preText, 1, 300);
    return conn().results.filter((r) => r.name === name).at(-1)!.result;
  };
  await engine.start();
  await settle();
  return {
    ...s, conversationId: c.conversationId, engine, clock, model, speaker: speaker!, logs, sent, settle, run, conn, respond, buyerSays, tool,
    frames: () => sent.filter(isFrame),
    end: async () => { engine.onClientMessage({ t: "end" }); await settle(); },
  };
}

const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };

describe("realtime + ElevenLabs (rt_eleven)", () => {
  it("text output, the guarded profile; the opener waits for ready and is spoken; a plain reply is spoken once and stored exactly", async () => {
    const c = await rtCall();
    const cfg = c.conn().cfg;
    expect(cfg.outputModality).toBe("text");
    expect(cfg.voice).toBeUndefined();
    expect(cfg.tools.map((x) => x.name)).toEqual(guardedTools("openai").map((x) => x.name));
    // The opener waits for the browser.
    expect(c.conn().responses).toHaveLength(0);
    c.engine.onClientMessage({ t: "ready", waitedMs: 10 } as never);
    await c.run(10);
    expect(c.conn().responses).toHaveLength(1);
    await c.respond("Hi, this is Ava from Acme. How can I help you today?");
    // One speech stream for the whole reply (never one request per sentence).
    expect(c.speaker.said.map((x) => x.text)).toEqual(["Hi, this is Ava from Acme. How can I help you today?"]);
    await c.run(3_000);
    expect(c.frames().length).toBeGreaterThan(0);
    // A plain turn: spoken once, the row is the exact text, with its answer time (speech stopped → first audio).
    await c.buyerSays("How much is a sensor?");
    await c.run(400);
    await c.respond("A sensor is four hundred and fifty shekels, plus seventeen seventy a month. Shall I make you a quote?");
    await c.run(3_000);
    const rows = await agentRows(c.conversationId);
    expect(rows.map((r) => r.body)).toEqual([
      "Hi, this is Ava from Acme. How can I help you today?",
      "A sensor is four hundred and fifty shekels, plus seventeen seventy a month. Shall I make you a quote?",
    ]);
    expect(rows[1].answerMs).toBeGreaterThanOrEqual(400);
    expect(c.speaker.said.filter((x) => x.text.startsWith("A sensor"))).toHaveLength(1);
    expect(c.logs.some((l) => /trace t=\d+ rt turn think=\d+ms toolRounds=0 speak=\d+ms total=\d+ms/.test(l))).toBe(true);
    expect(c.logs.some((l) => / rt output=text model=openai\/gpt-realtime-2\.1 speak=elevenlabs\/eleven-v4-turbo voice=Rachel \(ElevenLabs\)$/.test(l))).toBe(true);
    // Once per call: one stream per reply and the stability sent.
    expect(c.logs.filter((l) => l.endsWith(" rt speech one stream per reply stability=1 (dialogue mode only)"))).toHaveLength(1);
    await c.end();
    const row = await sessionRow(c.sessionId);
    expect(row.settings).toMatchObject({ engine: "rt_eleven", voice: PIPELINE_VOICE_NAME, fillers: false, model: "openai/gpt-realtime-2.1", rtEleven: { realtimeModel: "openai/gpt-realtime-2.1", voice: PIPELINE_VOICE_NAME } });
    expect(row.usage).toMatchObject({ rtEleven: { turns: 1, droppedTexts: 0, speakModel: "elevenlabs/eleven-v4-turbo" } });
    const summary = await voiceSessionSummary(db, acc, c.conversationId);
    expect(summary?.engine).toBe("rt_eleven");
    expect(summary?.rtEleven).toMatchObject({ realtimeModel: "openai/gpt-realtime-2.1", speakModel: "elevenlabs/eleven-v4-turbo" });
    expect(summary?.voiceUsed.voice).toBe(PIPELINE_VOICE_NAME);
    expect(c.logs.some((l) => / rt summary turns=1 median think=\d+ms speak=\d+ms total=\d+ms toolRounds=0 dropped=0 bargeIns=0 chars=\d+ speakModel=elevenlabs\/eleven-v4-turbo costMicros=0 /.test(l))).toBe(true);
  });

  it("a response with text and a tool call: its text is dropped; the response after the results is spoken once (one agent line)", async () => {
    const c = await rtCall();
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    await c.respond("Hello!");
    await c.run(2_000);
    await c.buyerSays("We run two restaurants.");
    const r = await c.tool("u1", "update_deal_state", { ...noUpdate, updates: [{ key: "sites", value: "2", provenance: "buyer" }] }, "Let me note that down for you.");
    expect(r).toBeTruthy();
    expect(c.speaker.said.some((x) => x.text.includes("note that down"))).toBe(false);
    expect(c.logs.some((l) => l.endsWith("rt text before tool dropped len=30 tools=1"))).toBe(true);
    await c.respond("Two restaurants, got it. What kind of food do you serve?");
    await c.run(3_000);
    const rows = await agentRows(c.conversationId);
    expect(rows.map((x) => x.body)).toEqual(["Hello!", "Two restaurants, got it. What kind of food do you serve?"]);
    expect(c.speaker.said.filter((x) => x.text.startsWith("Two restaurants"))).toHaveLength(1);
    await c.end();
    expect((await sessionRow(c.sessionId)).usage).toMatchObject({ rtEleven: { droppedTexts: 1, medianToolRounds: 1 } });
  });

  it("the guards fire as in guarded: the order form held on a vague yes; a held quote's say_this is the reply spoken", async () => {
    const c = await rtCall();
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    await c.respond("Hello!");
    await c.run(2_000);
    await c.buyerSays("Yeah, I guess so.");
    const held = await c.tool("f1", "send_order_form", { quote: "Q-1" });
    expect(held).toMatchObject({ ok: false, rule: "Not agreed yet" });
    await c.tool("u1", "update_deal_state", { ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }] });
    await c.buyerSays("Can you do ten percent off six sensors?");
    const q = await c.tool("q1", "create_quote", { lines: [{ sku: "SENSOR", qty: 6 }], discount_percent: 10, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null });
    expect(q).toMatchObject({ ok: true, status: "awaiting_seller_approval", quote_held: true, say_this: HELD_QUOTE_SAY.en });
    await c.respond(String(q.say_this));
    await c.run(4_000);
    expect(c.speaker.said.map((x) => x.text).join(" ")).toContain("I've asked the team to approve this price.");
    expect((await agentRows(c.conversationId)).at(-1)?.body).toBe(HELD_QUOTE_SAY.en);
    await c.end();
  });

  it("barge-in mid-stream: frames stop at once, flush, one note with the estimated heard text (a prefix ending at a word); the row ends with …", async () => {
    // 182 characters × 25 ms = 4.6 s of audio in ONE stream.
    const c = await rtCall({ speaker: new ScriptedSpeaker("elevenlabs/eleven-v4-turbo", { maxMs: 10_000, msPerChar: 25 }) });
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    const reply = "Our sensors check the fridge temperature every minute of the day. They send an alert to your phone when something is wrong. Most kitchens need one sensor for each fridge and freezer.";
    await c.respond(reply, 0, 0);
    await c.run(1_500);
    expect(c.speaker.said.map((x) => x.text)).toEqual([reply]);
    const before = c.frames().length;
    expect(before).toBeGreaterThan(0);
    c.conn().emit({ type: "speech-started" });
    await c.run(10);
    expect(c.sent.some((m) => (m as { t?: string }).t === "flush")).toBe(true);
    expect(c.speaker.cancels).toBeGreaterThan(0);
    const at = c.frames().length;
    await c.run(5_000);
    expect(c.frames().length).toBe(at);
    expect(c.conn().notes).toHaveLength(1);
    const m = /^\(Note from the system, not from the buyer: the buyer interrupted you, so they did not hear all of your last reply\. They heard only: "([^"]+)" Do not answer this note\.\)$/.exec(c.conn().notes[0]);
    expect(m).not.toBeNull();
    const heard = m![1];
    // A prefix of the reply ending at a word boundary, about the 1.5 s played of 4.6 s (the unplayed lead is not counted).
    expect(reply.startsWith(heard)).toBe(true);
    expect(reply[heard.length]).toBe(" ");
    expect(heard.length).toBeGreaterThan(40);
    expect(heard.length).toBeLessThan(80);
    const rows = await agentRows(c.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(`${heard}…`);
    expect(c.logs.some((l) => /rt barge-in: speech stopped sentMs=\d+ unplayedMs=\d+ heard=\d+\/182 chars basis=total$/.test(l))).toBe(true);
    await c.end();
    expect((await sessionRow(c.sessionId)).usage).toMatchObject({ rtEleven: { bargeIns: 1 } });
  });

  for (const wiring of ["rt_eleven (guarded profile)", "Current (no profile)"] as const) {
    it(`end_call with its goodbye in the same response (${wiring}): the goodbye is spoken, then the call ends once it played`, async () => {
      const c = await rtCall({ current: wiring.startsWith("Current") });
      c.engine.onClientMessage({ t: "ready" } as never);
      await c.run(10);
      await c.respond("Hello!");
      await c.run(2_000);
      await c.buyerSays("That's all, thanks, bye.");
      const goodbye = "Thanks for your time, have a great day. Goodbye!";
      c.conn().emit({ type: "tool-call", callId: "e1", name: "end_call", args: {} });
      await c.respond(goodbye, 1, 300);
      // Spoken (not dropped), as ONE stream.
      expect(c.speaker.said.map((x) => x.text)).toContain(goodbye);
      expect(c.logs.some((l) => l.includes("rt text before tool dropped"))).toBe(false);
      expect(c.logs.some((l) => /rt response with end_call len=\d+: its goodbye is spoken/.test(l))).toBe(true);
      // The call ends after the goodbye played (not cut by the 2.5 s goodbye timer while frames still go out).
      await c.run(10_000);
      expect(c.engine.isEnded).toBe(true);
      const total = c.frames().reduce((n, f) => n + f.byteLength, 0);
      expect(total).toBeGreaterThan(0);
      const rows = await agentRows(c.conversationId);
      expect(rows.at(-1)?.body).toBe(goodbye);
      expect((await sessionRow(c.sessionId)).endReason).toBe("agent_closed");
    });
  }

  it("Current (no profile) with text output: Current's instructions and tools; the ONE difference from audio output is the filler lines", async () => {
    const instructionsOf = async (o: { speaker: boolean; fillers: boolean }) => {
      const { ensureDraftVersion: draft } = await import("@/lib/agent/service");
      const d = await draft(db, acc);
      const { agentVersions } = await import("@/db/schema");
      await db.update(agentVersions).set({ voiceSettings: { model: "openai/gpt-realtime-2.1", fillers: o.fillers } }).where(eq(agentVersions.id, d.id));
      const c = await rtCall({ current: true, ...(o.speaker ? {} : { speaker: null }) });
      const cfg = c.conn().cfg;
      await c.end();
      await db.update(agentVersions).set({ voiceSettings: null }).where(eq(agentVersions.id, d.id));
      return cfg;
    };
    const text = await instructionsOf({ speaker: true, fillers: true });
    const audioNoFillers = await instructionsOf({ speaker: false, fillers: false });
    const audio = await instructionsOf({ speaker: false, fillers: true });
    expect(text.outputModality).toBe("text");
    expect(audio.outputModality).toBeUndefined();
    // Same tools as Current's audio call (not guarded's).
    expect(text.tools).toEqual(audio.tools);
    expect(text.tools).not.toEqual(guardedTools("openai"));
    // Text output = Current's instructions with fillers off; audio output is unchanged (it keeps the filler lines).
    const norm = (x: string) => x.replace(/\d{4}-\d{2}-\d{2}[^\n]*/g, "");
    expect(norm(text.instructions)).toBe(norm(audioNoFillers.instructions));
    expect(norm(text.instructions)).not.toBe(norm(audio.instructions));
  });

  it("the recording's agent channel holds the spoken audio (fed from what was sent to the browser)", async () => {
    const store = new MemoryRecordingStore();
    const c = await rtCall({ store });
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    await c.respond("Hello, this is the agent speaking now.");
    await c.run(3_000);
    await c.end();
    const files = await store.list("");
    expect(files.length).toBeGreaterThan(0);
    let right = 0;
    let left = 0;
    for (const f of files) {
      const b = await store.read(f.path, 0, f.size);
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i + 3 < b.byteLength; i += 4) {
        left += Math.abs(v.getInt16(i, true));
        right += Math.abs(v.getInt16(i + 2, true));
      }
    }
    expect(right).toBeGreaterThan(0);
    expect(left).toBe(0);
    expect((await sessionRow(c.sessionId)).recordingState).toBe("saved");
  });

  it("cost (live figures): the realtime usage with text output plus the speech characters × the speech rate", async () => {
    const c = await rtCall({ engine: "rt_eleven_mini", mode: "live" });
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    const text = "Hello there, I can help with that.";
    await c.respond(text);
    c.conn().emit({ type: "usage", usage: { audioInTokens: 1_000, audioOutTokens: 0, textInTokens: 2_000, textOutTokens: 100, cachedInTokens: 0 } });
    await c.run(3_000);
    await c.end();
    const row = await sessionRow(c.sessionId);
    const rt = (row.usage as unknown as { rtEleven: { spokenChars: number; speakCostMicros: number; realtimeCostMicros: number } }).rtEleven;
    expect(rt.spokenChars).toBe(text.length);
    expect(rt.speakCostMicros).toBe(text.length * SPEAK_MICROS_PER_CHAR["elevenlabs/eleven-v4-turbo"]);
    // mini: 1,000 audio in × $10/M + 2,000 text in × $0.60/M + 100 text out × $2.40/M (micros), above the listening floor here.
    expect(rt.realtimeCostMicros).toBe(Math.round(1_000 * 10 + 2_000 * 0.6 + 100 * 2.4));
    expect(row.costMicros).toBe(rt.realtimeCostMicros + rt.speakCostMicros);
    expect(row.usage).toMatchObject({ audioOutTokens: 0, textOutTokens: 100, basis: "usage" });
  });

  it("the scripted realtime model in text mode with the scripted speaker: a whole call, nothing paid, texts before tools dropped", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: "ready_buyer", language: "en" }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "rt_eleven" });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock(Date.UTC(2026, 10, 24, 11, 0, 0));
    const model = new ScriptedRealtime({ clock });
    const speaker = new ScriptedSpeaker();
    const { lines, log } = memLog();
    const sent: unknown[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: (m) => void sent.push(m), log, limits: QUIET, recording: { store: null, reason: "test" }, profile: rtElevenProfile("rt_eleven"), speaker });
    const settle = async () => { for (let i = 0; i < 4; i++) { await flushAsync(); await engine.idle(); } };
    const run = (ms: number) => clock.advance(ms, settle);
    await engine.start();
    await settle();
    await run(10_000);
    for (let round = 0; round < 2; round++) {
      for (let x = 0; x < 1000; x += 100) { engine.onClientAudio(micPcm(100, true)); await run(100); }
      for (let x = 0; x < 800; x += 100) { engine.onClientAudio(micPcm(100, false)); await run(100); }
      await run(20_000);
    }
    engine.onClientMessage({ t: "end" });
    await settle();
    expect(model.connections[0].cfg.outputModality).toBe("text");
    const rows = await agentRows(conv.conversationId);
    expect(rows.length).toBeGreaterThan(1);
    // Every stored agent line was handed to the speaker exactly (its spoken form).
    const said = speaker.said.map((x) => x.text).join(" ");
    for (const r of rows) for (const part of r.body.replace(/…$/, "").split(/(?<=[.!?])\s+/)) expect(said).toContain(part);
    expect(sent.some(isFrame)).toBe(true);
    const row = await sessionRow(s.sessionId);
    expect(row.costMicros).toBe(0);
    expect(row.settings).toMatchObject({ engine: "rt_eleven" });
    expect(lines.some((l) => l.includes("engine=rt_eleven"))).toBe(true);
    // The script's "One moment, I'm checking that." came with a tool call: dropped, never spoken or stored.
    expect(lines.some((l) => /rt text before tool dropped len=38 tools=1$/.test(l))).toBe(true);
    expect(said).not.toContain("One moment");
    expect(rows.some((r) => r.body.includes("One moment"))).toBe(false);
    expect(rows.some((r) => r.body.startsWith("Your total today is"))).toBe(true);
  });

  it("the relay runs an rt_eleven session: text output, the scripted speaker, the engine on the session", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "rt_eleven_mini" });
    if (!s.ok) throw new Error(s.reason);
    expect((await sessionRow(s.sessionId)).model).toBe("openai/gpt-realtime-mini");
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const speaker = new ScriptedSpeaker();
    const { lines, log } = memLog();
    class FakeWs extends EventEmitter implements VoiceSocket {
      bufferedAmount = 0;
      out: (string | Uint8Array)[] = [];
      closed = false;
      send(d: string | Uint8Array) { this.out.push(d); }
      close(code?: number) {
        if (this.closed) return;
        this.closed = true;
        setImmediate(() => this.emit("close", code, ""));
      }
    }
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const ws = new FakeWs();
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, model, rtSpeaker: speaker, log, limits: QUIET });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true })), false);
    await settle();
    ws.emit("message", Buffer.from(JSON.stringify({ t: "ready" })), false);
    await clock.advance(5_000, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    expect(model.connections[0]?.cfg.outputModality).toBe("text");
    expect(speaker.said.length).toBeGreaterThan(0);
    expect(ws.out.some((d) => d instanceof Uint8Array)).toBe(true);
    expect(lines.some((l) => l.endsWith("engine=rt_eleven_mini"))).toBe(true);
    expect((await sessionRow(s.sessionId)).settings).toMatchObject({ engine: "rt_eleven_mini", rtEleven: { realtimeModel: "openai/gpt-realtime-mini" } });
  });
});
