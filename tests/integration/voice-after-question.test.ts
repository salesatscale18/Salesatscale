/**
 * The after-question guard (lib/voice/engine.ts, TEST calls only while AFTER_QUESTION_GUARD_FOR_BUYER_CALLS is off):
 * the agent asks the buyer a question, saves details with update_deal_state after its audio, and continues by itself
 * after the result (Gemini 3.8 Live test call 449eb784: a short "…" or the same question reworded). That continuation
 * is dropped: no audio to the browser or the recording, no stored line, no caption, no agent turn. An output filter,
 * never an instruction. Free: the scripted model (Gemini-style and OpenAI-style), a hand-driven model, the scripted
 * speaker; PGlite. No paid call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { AFTER_QUESTION_CONTINUATION_MS, BOOKKEEPING_TOOLS, VoiceEngine } from "@/lib/voice/engine";
import type { VoiceLog } from "@/lib/voice/log";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { endResponse, expectBuyer, micPcm, say, ScriptedRealtime, speechPcm, tool, type Script } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { AFTER_QUESTION_GUARD_FOR_BUYER_CALLS, afterQuestionGuardFor } from "@/lib/voice/settings";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET = { standbyAfterQuietMs: 600_000, env: {} };
const WORD_MS = 250;

const Q = "Got it. How many fridges per site?";
const REWORD = "How many fridges do you have at each site?";
const ANSWER = "Thanks, four per site noted.";
const UDS = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The fault's turn: a question, a bookkeeping call after it, the model's own continuation; then the buyer answers. */
const FAULT: Script = [
  expectBuyer("We have two sites."),
  say(Q),
  tool("update_deal_state", UDS),
  say(REWORD),
  expectBuyer("Four each."),
  say(ANSWER),
  expectBuyer("Fine."),
];

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "aq", email: "aq@p.test", firstName: "Ann", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "aq-o@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

type Conn = { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { callId: string; name: string }[]; notes: string[]; cancels: number; responses: (string | undefined)[] };

/** An audio-output model whose events the test emits by hand (OpenAI family); records what the engine sends it. */
class HandModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  readonly conns: Conn[] = [];
  constructor(readonly modelId = "openai/gpt-realtime-2.1") {}
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c: Conn = { cfg, emit: onEvent, results: [], notes: [], cancels: 0, responses: [] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined,
      requestResponse: (x) => void c.responses.push(x), sendNote: (n) => void c.notes.push(n), cancelResponse: () => void c.cancels++,
      sendToolResult: (callId, name) => void c.results.push({ callId, name }),
    };
  }
}

async function call(o: { script?: Script; model?: RealtimeModel; isTest?: boolean; openai?: boolean; speaker?: ScriptedSpeaker } = {}) {
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(o.speaker ? { engine: "rt_eleven" as const } : {}) });
  if (!s.ok) throw new Error(s.reason);
  // A buyer call: the same call, its session not a test one.
  if (o.isTest === false) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
  const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0, 0));
  const model = o.model ?? new ScriptedRealtime({ clock, wordMs: WORD_MS, defaultScript: o.script ?? FAULT, ...(o.openai ? { openaiResponses: true } : {}) });
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => void lines.push(l), warn: (l) => void lines.push(l), error: (l) => void lines.push(l) };
  const sent: unknown[] = [];
  const engine = new VoiceEngine({
    db, model, sessionId: s.sessionId, clock, log, send: (m) => void sent.push(m), limits: QUIET, recording: { store: null, reason: "test" },
    ...(o.speaker ? { speaker: o.speaker } : {}),
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  /** The buyer speaks for a second, then is quiet (the scripted model hears a turn). */
  const speak = async () => {
    for (let x = 0; x < 1000; x += 100) {
      engine.onClientAudio(micPcm(100, true));
      await run(100);
    }
    for (let x = 0; x < 800; x += 100) {
      engine.onClientAudio(micPcm(100, false));
      await run(100);
    }
  };
  /** Agent audio sent to the browser so far, in ms. */
  const audioMs = () => sent.filter((m): m is Uint8Array => m instanceof Uint8Array).reduce((n, b) => n + b.byteLength, 0) / 48;
  const json = () => sent.filter((m) => !(m instanceof Uint8Array)) as { t: string; role?: string; text?: string; final?: boolean }[];
  const rows = async () => (await db.select().from(messages)
    .where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt)))
    .filter((m) => m.voiceSessionId === s.sessionId).map((m) => m.body);
  const hangUp = async () => {
    engine.onClientMessage({ t: "end" });
    await settle();
  };
  const id = s.sessionId.slice(0, 8);
  const drops = () => lines.filter((l) => l.startsWith(`[voice] ${id} after-question continuation dropped`));
  await engine.start();
  await settle();
  return { engine, model, clock, run, speak, audioMs, json, rows, hangUp, lines, drops, id, sessionId: s.sessionId };
}

describe("after-question guard: Gemini-style (one turn across the tool call, no provider cancel)", () => {
  it("question → update_deal_state after speech → the model's own continuation: dropped; the call goes on and the next buyer line is answered", async () => {
    const c = await call();
    await c.run(15_000); // the opener
    const opener = await c.rows();
    expect(opener).toHaveLength(1);
    const before = c.audioMs();
    await c.speak();
    await c.run(20_000);
    // Only the question was played: not a single frame of the continuation.
    expect(c.audioMs() - before).toBe(words(Q) * WORD_MS);
    // The question is stored whole (not cut), once; the continuation nowhere.
    expect(await c.rows()).toEqual([opener[0], Q]);
    // One log line, lengths only; the trace shows the response and the drop.
    expect(c.drops()).toEqual([`[voice] ${c.id} after-question continuation dropped len=${REWORD.length} audioMs=${words(REWORD) * WORD_MS} tools=update_deal_state`]);
    expect(c.lines.some((l) => /trace t=\d+ after-question continuation: dropping tools=update_deal_state$/.test(l))).toBe(true);
    // The engine asked for the provider's cancel (Gemini's adapter has none: its audio is simply not played).
    expect((c.model as ScriptedRealtime).connections[0].cancels).toBe(1);
    // No caption of it went to the browser.
    expect(c.json().some((m) => m.t === "transcript" && m.text?.includes("each site"))).toBe(false);
    // The buyer answers: answered normally.
    const mid = c.audioMs();
    await c.speak();
    await c.run(20_000);
    expect(c.audioMs() - mid).toBe(words(ANSWER) * WORD_MS);
    await c.hangUp();
    expect(await c.rows()).toEqual([opener[0], Q, ANSWER]);
    expect(c.lines.join("\n")).not.toMatch(/fridges|each site|four per site/i);
    // The call summary counts it.
    expect(c.lines.some((l) => l.startsWith(`[voice] ${c.id} ended reason=`) && l.endsWith(" afterQ=1"))).toBe(true);
  });

  it("not dropped: the agent's output before the tool did not end with a question", async () => {
    const said = "Got it, two sites.";
    const next = "Shall we look at sensors for both?";
    const c = await call({ script: [expectBuyer("We have two sites."), say(said), tool("update_deal_state", UDS), say(next), expectBuyer("Sure.")] });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    expect((await c.rows()).at(-1)).toBe(`${said} ${next}`);
    expect(c.drops()).toEqual([]);
    expect(c.lines.some((l) => l.includes("afterQ="))).toBe(false);
  });

  it.each([
    ["search_catalog", { query: "" }],
    ["check_offer", { quote: "Q-1", reason: "next", lines: null, sites: null }],
    ["create_quote", { lines: [], discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null }],
  ])("not dropped: a non-bookkeeping tool ran since the question (%s)", async (name, args) => {
    const c = await call({ script: [expectBuyer("We have two sites."), say(Q), tool("update_deal_state", UDS), tool(name, args), say(REWORD), expectBuyer("Four each.")] });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    expect((await c.rows()).at(-1)).toBe(`${Q} ${REWORD}`);
    expect(c.drops()).toEqual([]);
  });

  it("not dropped: the buyer spoke between the question and the next response (it answers the buyer)", async () => {
    const c = await call({ script: [expectBuyer("We have two sites."), say(Q), tool("update_deal_state", UDS), expectBuyer("Four each."), say(ANSWER), expectBuyer("Fine.")] });
    await c.run(15_000);
    await c.speak();
    // The question is said and the result is in; the buyer answers at once (well inside the guard's window).
    await c.run(words(Q) * WORD_MS + 500);
    expect((c.model as ScriptedRealtime).connections[0].sent.toolResults.map((r) => r.name)).toEqual(["update_deal_state"]);
    expect(words(Q) * WORD_MS + 500 + words(ANSWER) * WORD_MS).toBeLessThan(AFTER_QUESTION_CONTINUATION_MS);
    c.engine.onClientMessage({ t: "text", text: "Four each." });
    await c.run(10_000);
    await c.hangUp();
    expect((await c.rows()).at(-1)).toBe(ANSWER);
    expect(c.drops()).toEqual([]);
  });

  it("buyer calls are unaffected while AFTER_QUESTION_GUARD_FOR_BUYER_CALLS is off: the continuation is spoken and stored", async () => {
    expect(AFTER_QUESTION_GUARD_FOR_BUYER_CALLS).toBe(false);
    expect(afterQuestionGuardFor(false)).toBe(false);
    expect(afterQuestionGuardFor(true)).toBe(true);
    expect(afterQuestionGuardFor(false, true)).toBe(true);
    expect(BOOKKEEPING_TOOLS).toEqual(["update_deal_state"]);
    const c = await call({ isTest: false });
    await c.run(15_000);
    const before = c.audioMs();
    await c.speak();
    await c.run(20_000);
    expect(c.audioMs() - before).toBe((words(Q) + words(REWORD)) * WORD_MS);
    await c.hangUp();
    expect((await c.rows()).at(-1)).toBe(`${Q} ${REWORD}`);
    expect(c.drops()).toEqual([]);
    expect((c.model as ScriptedRealtime).connections[0].cancels).toBe(0);
  });

  it("adds no instruction: the session config is the same with the guard on (test call) as on a buyer call's model side", async () => {
    const test = await call();
    const buyer = await call({ isTest: false });
    await test.run(1_000);
    await buyer.run(1_000);
    const cfg = (x: typeof test) => (x.model as ScriptedRealtime).connections[0].cfg;
    expect(cfg(test).instructions).not.toMatch(/after-question|continuation/i);
    expect(cfg(test).tools.map((x) => x.name)).toEqual(cfg(buyer).tools.map((x) => x.name));
    await test.hangUp();
    await buyer.hangUp();
  });
});

describe("after-question guard: GPT-Realtime own voice (a response per tool step, response.cancel)", () => {
  it("the continuation response is cancelled at its first audio: nothing played, the question stored whole, the buyer answered", async () => {
    const c = await call({ openai: true });
    await c.run(15_000);
    const opener = await c.rows();
    const before = c.audioMs();
    await c.speak();
    await c.run(20_000);
    expect(c.audioMs() - before).toBe(words(Q) * WORD_MS);
    expect(await c.rows()).toEqual([opener[0], Q]);
    // Cancelled after its first word (the scripted model stops at the next word, as the provider stops the response).
    expect((c.model as ScriptedRealtime).connections[0].cancels).toBe(1);
    expect(c.drops()).toEqual([`[voice] ${c.id} after-question continuation dropped len=${"How".length} audioMs=${WORD_MS} tools=update_deal_state`]);
    const mid = c.audioMs();
    await c.speak();
    await c.run(20_000);
    expect(c.audioMs() - mid).toBe(words(ANSWER) * WORD_MS);
    await c.hangUp();
    expect(await c.rows()).toEqual([opener[0], Q, ANSWER]);
  });

  it("the question as a response of its own, then update_deal_state and words in the next: dropped too", async () => {
    const c = await call({ openai: true, script: [expectBuyer("We have two sites."), say(Q), endResponse(), tool("update_deal_state", UDS), say(REWORD), expectBuyer("Four each."), say(ANSWER), expectBuyer("Fine.")] });
    await c.run(15_000);
    const opener = await c.rows();
    await c.speak();
    await c.run(20_000);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    expect(await c.rows()).toEqual([opener[0], Q, ANSWER]);
    expect(c.drops()).toHaveLength(1);
  });

  it("not dropped: the response the engine asked for (a note) after the question and the bookkeeping result", async () => {
    for (const withNote of [false, true]) {
      const model = new HandModel();
      const c = await call({ model });
      await c.run(1_000);
      const conn = model.conns[0];
      // The opener (requested by the engine): spoken and stored.
      expect(conn.responses).toHaveLength(1);
      conn.emit({ type: "audio", pcm: speechPcm(500) });
      conn.emit({ type: "agent-transcript", text: "Hi, this is Acme.", final: true });
      conn.emit({ type: "turn-done" });
      await c.run(1_000);
      conn.emit({ type: "speech-started" });
      conn.emit({ type: "buyer-transcript", text: "We have two sites.", final: true });
      await c.run(500);
      conn.emit({ type: "audio", pcm: speechPcm(1_000) });
      conn.emit({ type: "agent-transcript", text: Q, final: false });
      conn.emit({ type: "tool-call", callId: "c1", name: "update_deal_state", args: UDS });
      conn.emit({ type: "agent-transcript", text: Q, final: true });
      conn.emit({ type: "turn-done" });
      await c.run(200);
      expect(conn.results.map((r) => r.name)).toEqual(["update_deal_state"]);
      // The order form's step: a note from the engine (the model's next words answer it).
      if (withNote) c.engine.onClientMessage({ t: "context", kind: "order_form", step: "company", label: "Company details", event: "opened" });
      const before = c.audioMs();
      const next = "Take your time with the form.";
      conn.emit({ type: "audio", pcm: speechPcm(700) });
      conn.emit({ type: "agent-transcript", text: next, final: true });
      conn.emit({ type: "turn-done" });
      await c.run(500);
      await c.hangUp();
      const rows = await c.rows();
      if (withNote) {
        expect(conn.notes).toHaveLength(1);
        expect(c.audioMs() - before).toBe(700);
        expect(rows.at(-1)).toBe(next);
        expect(c.drops()).toEqual([]);
        expect(conn.cancels).toBe(0);
      } else {
        // Control: the same response with no note is the model's own continuation.
        expect(c.audioMs() - before).toBe(0);
        expect(rows.at(-1)).toBe(Q);
        expect(c.drops()).toEqual([`[voice] ${c.id} after-question continuation dropped len=${next.length} audioMs=700 tools=update_deal_state`]);
        expect(conn.cancels).toBe(1);
      }
    }
  });

  it("the opener is never dropped (engine-requested), even when it ends with a question", async () => {
    const model = new HandModel();
    const c = await call({ model });
    await c.run(1_000);
    const conn = model.conns[0];
    conn.emit({ type: "audio", pcm: speechPcm(500) });
    conn.emit({ type: "agent-transcript", text: "Hi, how can I help?", final: true });
    conn.emit({ type: "turn-done" });
    await c.run(500);
    await c.hangUp();
    expect(c.audioMs()).toBe(500);
    expect(await c.rows()).toEqual(["Hi, how can I help?"]);
    expect(c.drops()).toEqual([]);
  });
});

describe("after-question guard: text output + ElevenLabs (lib/voice-rt-eleven)", () => {
  const TEXT_FAULT: Script = [
    expectBuyer("We have two sites."),
    say(Q),
    endResponse(),
    tool("update_deal_state", UDS),
    say(REWORD),
    expectBuyer("Four each."),
    say(ANSWER),
    expectBuyer("Fine."),
  ];

  it("the continuation's text is never handed to the speaker; the next buyer line is answered", async () => {
    const speaker = new ScriptedSpeaker();
    const c = await call({ speaker, script: TEXT_FAULT });
    await c.run(15_000);
    const opener = await c.rows();
    await c.speak();
    await c.run(20_000);
    expect(speaker.said.map((x) => x.text)).not.toContain(REWORD);
    expect(c.drops()).toEqual([`[voice] ${c.id} after-question continuation dropped len=${REWORD.length} audioMs=- tools=update_deal_state`]);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    const said = speaker.said.map((x) => x.text);
    expect(said).toContain(Q);
    expect(said).toContain(ANSWER);
    expect(said.some((x) => x.includes("each site"))).toBe(false);
    expect(await c.rows()).toEqual([opener[0], Q, ANSWER]);
    expect(c.lines.some((l) => l.includes(" afterQ=1"))).toBe(true);
  });

  it("buyer calls: spoken as before", async () => {
    const speaker = new ScriptedSpeaker();
    const c = await call({ speaker, script: TEXT_FAULT, isTest: false });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    expect(speaker.said.map((x) => x.text)).toContain(REWORD);
    expect(c.drops()).toEqual([]);
  });

  it("not dropped: a non-bookkeeping tool since the question", async () => {
    const speaker = new ScriptedSpeaker();
    const c = await call({ speaker, script: [expectBuyer("We have two sites."), say(Q), endResponse(), tool("search_catalog", { query: "" }), say(REWORD), expectBuyer("Four each.")] });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await c.hangUp();
    expect(speaker.said.map((x) => x.text)).toContain(REWORD);
    expect(c.drops()).toEqual([]);
  });
});
