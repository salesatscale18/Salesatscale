/**
 * The pipeline engine's turn timing on PGlite, with a hand-driven listener, the scripted speaker and a fake chat turn
 * (no model, nothing paid):
 *
 * - the line wait after the buyer's speech end (B2, the first live call: "no final transcript within 1500ms" on
 *   every turn): the listener is asked to finalise the utterance at once; a final that comes is used at once; without
 *   one, the partial is the line once unchanged for 350 ms; a partial that keeps changing is taken at the 1,000 ms
 *   cap; no text at all by the cap is noise;
 * - the figures (B3): a turn whose speech failed still counts (listen, think); speak and total only when audio was
 *   sent; the summary line and the card's medians say so;
 * - a failed chat turn in Hebrew: the Hebrew retry line, never the error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users, voiceSessions, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion } = await import("@/lib/agent/service");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } = await import("@/lib/voice/service");
const { micPcm } = await import("@/lib/voice/scripted-realtime");
const { PipelineVoiceEngine, RETRY_LINE } = await import("@/lib/voice-pipeline/engine");
const { ManualListener } = await import("@/lib/voice-pipeline/listener");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");
const { scriptedPipelineLlm } = await import("@/lib/voice-pipeline");
const { PIPELINE_TIMING } = await import("@/lib/voice-pipeline/models");
type CallTurnFn = import("@/lib/voice-pipeline/turn").CallTurnFn;
type Speaker = import("@/lib/voice-pipeline/speaker").Speaker;

const SCRIPTED = { VOICE_REALTIME: "scripted" };

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "tm", email: "tm@p.test", firstName: "Tim", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "tm-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await flushAsync(4);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** A pipeline call (scripted parts, a fake chat turn) past its opener, ready to hear the buyer. */
async function call(o: { speaker?: Speaker; turn?: CallTurnFn; language?: "en" | "he" } = {}) {
  const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, ...(o.language ? { language: o.language } : {}) }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
  if (!s.ok) throw new Error(s.reason);
  const listener = new ManualListener();
  const clock = new ManualClock();
  const lines: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const turns: { text: string; at: number }[] = [];
  const turn: CallTurnFn = o.turn ?? (async (_db, _llm, a) => {
    turns.push({ text: a.text, at: clock.now() });
    return { status: "replied", messageId: randomUUID(), text: "Okay, noted.", calls: 0 };
  });
  const speaker = o.speaker ?? new ScriptedSpeaker("scripted", { msPerChar: 2, maxMs: 300, chunkMs: 100 });
  const engine = new PipelineVoiceEngine({
    db, sessionId: s.sessionId, mode: "scripted", clock, turn, listener: () => listener, speaker, llm: scriptedPipelineLlm(),
    log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) },
    send: (m) => void (m instanceof Uint8Array ? null : sent.push(m as unknown as Record<string, unknown>)), limits: { env: {} },
  });
  await engine.start();
  await settle();
  await clock.advance(3_000, settle);
  /** Loud speech, then quiet until the detector reports the end; returns the time it did. */
  const speak = async (loudMs = 600) => {
    for (let x = 0; x < loudMs; x += 100) {
      engine.onClientAudio(micPcm(100, true));
      await clock.advance(100, settle);
    }
    for (let x = 0; x < 3_000; x += 100) {
      const before = lines.filter((l) => l.includes("pipeline buyer speech end")).length;
      engine.onClientAudio(micPcm(100, false));
      if (lines.filter((l) => l.includes("pipeline buyer speech end")).length > before) return clock.now();
      await clock.advance(100, settle);
    }
    throw new Error("no speech end");
  };
  const end = async () => {
    engine.onClientMessage({ t: "end" });
    await clock.advance(100, settle);
    await settle();
  };
  return { s, conv, engine, listener, clock, lines, sent, turns, speak, end };
}

describe("the line wait after the buyer's speech end", () => {
  it("asks the listener to finalise at once; a final that comes is used at once", async () => {
    const c = await call();
    c.listener.partial("We have two");
    const endAt = await c.speak();
    expect(c.listener.utteranceEnds).toBe(1);
    await c.clock.advance(120, settle);
    expect(c.turns).toHaveLength(0);
    c.listener.final("We have two sites.");
    await settle();
    expect(c.turns).toEqual([{ text: "We have two sites.", at: endAt + 120 }]);
    expect(c.lines.some((l) => l.includes("pipeline transcript final after 120ms"))).toBe(true);
    expect(c.lines.some((l) => /no final transcript within/.test(l))).toBe(false);
    await c.end();
  });

  it("no final: a partial unchanged for 350 ms is the line (not at 349 ms); its late final is dropped", async () => {
    const c = await call();
    c.listener.partial("How much is it");
    const endAt = await c.speak();
    await c.clock.advance(PIPELINE_TIMING.lineWait.stableMs - 1, settle);
    expect(c.turns).toHaveLength(0);
    await c.clock.advance(1, settle);
    expect(c.turns).toEqual([{ text: "How much is it", at: endAt + 350 }]);
    expect(c.lines.some((l) => l.includes("pipeline partial used after 350ms") && !l.includes("(cap)"))).toBe(true);
    // The finalised stream's late final and trailing partial do not start another line.
    c.listener.partial("How much is it?");
    c.listener.final("How much is it?");
    await c.clock.advance(2_000, settle);
    expect(c.turns).toHaveLength(1);
    expect(c.lines.some((l) => l.includes("late final dropped"))).toBe(true);
    await c.end();
  });

  it("a partial that keeps changing is waited for, at most 1,000 ms after the speech end", async () => {
    const c = await call();
    c.listener.partial("We");
    const endAt = await c.speak();
    for (const [at, text] of [[200, "We run"], [500, "We run two"], [800, "We run two kitchens"]] as const) {
      await c.clock.advance(at - (c.clock.now() - endAt), settle);
      expect(c.turns).toHaveLength(0);
      c.listener.partial(text);
    }
    await c.clock.advance(1_000 - 800 - 1, settle);
    expect(c.turns).toHaveLength(0);
    await c.clock.advance(1, settle);
    expect(c.turns).toEqual([{ text: "We run two kitchens", at: endAt + 1_000 }]);
    expect(c.lines.some((l) => l.includes("pipeline partial used after 1000ms (cap)"))).toBe(true);
    await c.end();
  });

  it("no text at all by the cap: noise, no turn", async () => {
    const c = await call();
    await c.speak();
    await c.clock.advance(1_000, settle);
    expect(c.turns).toHaveLength(0);
    expect(c.lines.some((l) => l.includes("pipeline speech without a transcript (noise) after 1000ms"))).toBe(true);
    await c.end();
  });
});

describe("the call's figures when speech fails (B3)", () => {
  it("a turn whose speech failed counts for listen and think; speak and total only for heard turns", async () => {
    let fail = false;
    const inner = new ScriptedSpeaker("scripted", { msPerChar: 2, maxMs: 300, chunkMs: 100 });
    // Speech works for the opener, then fails on every reply (as on the first live call).
    const speaker: Speaker = {
      modelId: "scripted", voice: inner.voice, cancel: () => inner.cancel(),
      speak: (text, opts) => (fail ? new ScriptedSpeaker("scripted", { failWith: "speech refused" }).speak(text, opts) : inner.speak(text, opts)),
    };
    const c = await call({ speaker });
    fail = true;
    c.engine.onClientMessage({ t: "text", text: "Hello there" });
    await c.clock.advance(1_000, settle);
    c.engine.onClientMessage({ t: "text", text: "Are you there?" });
    await c.clock.advance(1_000, settle);
    expect(c.turns).toHaveLength(2);
    expect(c.lines.filter((l) => /pipeline turn=\d listen=-ms think=\d+ms tools=0 speak=- total=- chars=0 model=/.test(l))).toHaveLength(2);
    await c.end();
    expect(c.lines.some((l) => /pipeline summary turns=2 spoken=0 median answer=- listen=- think=\d+ms speak=-/.test(l))).toBe(true);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    const p = (row.usage as unknown as { pipeline: Record<string, unknown> }).pipeline;
    expect(p).toMatchObject({ turns: 2, spokenTurns: 0, medianAnswerMs: null, medianSpeakMs: null, spokenChars: expect.any(Number) });
    expect(p.medianThinkMs).not.toBeNull();
    expect(row.answerMsAvg).toBeNull();
    // The card: no answer time, but the thinking median.
    const summary = await voiceSessionSummary(db, acc, c.conv.conversationId);
    expect(summary?.pipeline).toMatchObject({ medianAnswerMs: null, medianThinkMs: p.medianThinkMs });
  });

  it("heard turns: spoken counts them, the answer median is theirs", async () => {
    const c = await call();
    c.engine.onClientMessage({ t: "text", text: "Hello there" });
    await c.clock.advance(1_000, settle);
    await c.end();
    expect(c.lines.some((l) => /pipeline summary turns=1 spoken=1 median answer=\d+ms/.test(l))).toBe(true);
    expect(c.lines.some((l) => /pipeline turn=1 listen=-ms think=\d+ms tools=0 speak=\d+ms total=\d+ms chars=\d+ model=/.test(l))).toBe(true);
  });
});

describe("a failed turn on a Hebrew call", () => {
  it("says the Hebrew retry line, never the error, then listens", async () => {
    const c = await call({ language: "he", turn: async () => ({ status: "error", error: "GatewayLlmError" }) });
    const speaker = (c.engine as unknown as { speaker: InstanceType<typeof ScriptedSpeaker> }).speaker;
    const before = speaker.said.length;
    c.engine.onClientMessage({ t: "text", text: "כמה זה עולה?" });
    await c.clock.advance(2_000, settle);
    expect(speaker.said.slice(before).map((x) => x.text)).toEqual([RETRY_LINE.he]);
    expect(c.lines.some((l) => l.includes("pipeline turn failed: GatewayLlmError"))).toBe(true);
    expect(c.sent.filter((m) => m.t === "state").map((m) => m.state).slice(-1)).toEqual(["listening"]);
    await c.end();
  });
});
