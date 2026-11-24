/**
 * The pipeline engine's turn timing on PGlite, with a hand-driven listener, the scripted speaker and a fake chat turn
 * (no model, nothing paid):
 *
 * - the line wait after the buyer's speech end (B2, the first live call: "no final transcript within 1500ms" on
 *   every turn): the listener is asked to finalise the utterance at once; a final that comes is used at once; without
 *   one, the partial is the line once unchanged for 250 ms; a partial that keeps changing is taken at the 800 ms
 *   cap; no text at all by the cap is noise;
 * - the figures (B3): a turn whose speech failed still counts (listen, think); speak and total only when audio was
 *   sent; the summary line and the card's medians say so;
 * - the "one moment" filler: at 3,000 ms of thinking, never on two answered turns in a row unless the second passes
 *   6,000 ms (the fake clock);
 * - a failed chat turn in Hebrew: the Hebrew retry line, never the error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { messages as messagesTable, users, voiceSessions, type User } from "@/db/schema";
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
const { PIPELINE_FILLER, PIPELINE_TIMING } = await import("@/lib/voice-pipeline/models");
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
async function call(o: { speaker?: Speaker; turn?: CallTurnFn; language?: "en" | "he"; thinkMs?: number; thinkMsByTurn?: number[] } = {}) {
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
    // A slow turn (tools): the reply comes thinkMs (or this turn's entry of thinkMsByTurn) later on the call clock.
    const ms = o.thinkMsByTurn?.[turns.length - 1] ?? o.thinkMs;
    if (ms) await new Promise<void>((r) => clock.setTimeout(r, ms));
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
    c.listener.lastConnectMs = 180;
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
    // The utterance's listening figures, from the detector's report (the partial changed before it).
    expect(c.lines.some((l) => /pipeline listen: speechEnd→lastPartialChange=-\d+ms final=yes after 120ms newStreamConnect=180ms used=final$/.test(l))).toBe(true);
    // The turn's listen= excludes the detector's end silence (550 ms) and says so.
    await c.clock.advance(1_000, settle);
    expect(c.lines.some((l) => /pipeline turn=1 listen=120ms vadSilence=550ms sinceLastWord≈listen\+vadSilence=670ms think=\d+ms rounds=- tools=0 /.test(l))).toBe(true);
    await c.end();
  });

  it("no final: a partial unchanged for 250 ms is the line (not at 249 ms); its late final is dropped", async () => {
    expect(PIPELINE_TIMING.lineWait.stableMs).toBe(250);
    const c = await call();
    c.listener.partial("How much is it");
    const endAt = await c.speak();
    await c.clock.advance(PIPELINE_TIMING.lineWait.stableMs - 1, settle);
    expect(c.turns).toHaveLength(0);
    await c.clock.advance(1, settle);
    expect(c.turns).toEqual([{ text: "How much is it", at: endAt + 250 }]);
    expect(c.lines.some((l) => l.includes("pipeline partial used after 250ms") && !l.includes("(cap)"))).toBe(true);
    expect(c.lines.some((l) => /pipeline listen: speechEnd→lastPartialChange=-\d+ms final=no after 250ms newStreamConnect=- used=partial$/.test(l))).toBe(true);
    // The finalised stream's late final and trailing partial do not start another line.
    c.listener.partial("How much is it?");
    c.listener.final("How much is it?");
    await c.clock.advance(2_000, settle);
    expect(c.turns).toHaveLength(1);
    expect(c.lines.some((l) => l.includes("late final dropped"))).toBe(true);
    await c.end();
  });

  it("a partial that keeps changing is waited for, at most 800 ms after the speech end", async () => {
    expect(PIPELINE_TIMING.lineWait.capMs).toBe(800);
    const c = await call();
    c.listener.partial("We");
    const endAt = await c.speak();
    for (const [at, text] of [[200, "We run"], [400, "We run two"], [600, "We run two kitchens"]] as const) {
      await c.clock.advance(at - (c.clock.now() - endAt), settle);
      expect(c.turns).toHaveLength(0);
      c.listener.partial(text);
    }
    await c.clock.advance(800 - 600 - 1, settle);
    expect(c.turns).toHaveLength(0);
    await c.clock.advance(1, settle);
    expect(c.turns).toEqual([{ text: "We run two kitchens", at: endAt + 800 }]);
    expect(c.lines.some((l) => l.includes("pipeline partial used after 800ms (cap)"))).toBe(true);
    expect(c.lines.some((l) => /pipeline listen: speechEnd→lastPartialChange=600ms final=no after 800ms newStreamConnect=- used=cap$/.test(l))).toBe(true);
    await c.end();
  });

  it("no text at all by the cap: noise, no turn", async () => {
    const c = await call();
    await c.speak();
    await c.clock.advance(800, settle);
    expect(c.turns).toHaveLength(0);
    expect(c.lines.some((l) => l.includes("pipeline speech without a transcript (noise) after 800ms"))).toBe(true);
    expect(c.lines.some((l) => /pipeline listen: speechEnd→lastPartialChange=- final=no after 800ms newStreamConnect=- used=cap \(no text: noise\)$/.test(l))).toBe(true);
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
    expect(c.lines.filter((l) => /pipeline turn=\d listen=- think=\d+ms rounds=\S+ (?:roundsMs=\S+ other=\d+ms )?tools=0 speak=- total=- chars=0 model=/.test(l))).toHaveLength(2);
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
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=\d+ms rounds=\S+ (?:roundsMs=\S+ other=\d+ms )?tools=0 speak=\d+ms total=\d+ms chars=\d+ model=/.test(l))).toBe(true);
  });
});

describe('"one moment" while a turn thinks long', () => {
  /** A speaker that records when each text started (the call clock), a filler of ~1.1 s (100 ms per character). */
  function timedSpeaker(clockRef: { now: () => number }) {
    const inner = new ScriptedSpeaker("scripted", { msPerChar: 100, maxMs: 1_500, chunkMs: 100 });
    const at: { text: string; at: number }[] = [];
    const speaker: Speaker = {
      modelId: "scripted", voice: inner.voice, cancel: () => inner.cancel(),
      speak: (text, opts) => {
        at.push({ text, at: clockRef.now() });
        return inner.speak(text, opts);
      },
    };
    return { speaker, at };
  }
  const said = (c: Awaited<ReturnType<typeof call>>) => (c.engine as unknown as { speaker: Speaker }).speaker;
  const rowsOf = async (c: Awaited<ReturnType<typeof call>>) => db.select().from(messagesTable).where(eq(messagesTable.conversationId, c.conv.conversationId));

  it("a fast turn: no filler", async () => {
    const c = await call({ thinkMs: PIPELINE_FILLER.afterMs - 500 });
    const speaker = said(c) as InstanceType<typeof ScriptedSpeaker>;
    const before = speaker.said.length;
    c.engine.onClientMessage({ t: "text", text: "Hello there" });
    await c.clock.advance(5_000, settle);
    expect(speaker.said.slice(before).map((x) => x.text)).toEqual(["Okay, noted."]);
    expect(c.lines.some((l) => l.includes("filler"))).toBe(false);
    await c.end();
  });

  it("a slow turn: one filler at 3,000 ms, then the reply once the filler has played (no overlap, no cut); not stored", async () => {
    expect(PIPELINE_FILLER.afterMs).toBe(3_000);
    const ref = { now: () => 0 };
    const t = timedSpeaker(ref);
    const c = await call({ thinkMs: 3_500, speaker: t.speaker });
    ref.now = () => c.clock.now();
    // The (long) opener plays out first.
    await c.clock.advance(10_000, settle);
    const flushes = c.sent.filter((m) => m.t === "flush").length;
    const start = c.clock.now();
    c.engine.onClientMessage({ t: "text", text: "Which sensors fit two kitchens?" });
    await c.clock.advance(PIPELINE_FILLER.afterMs - 1, settle);
    expect(t.at.slice(-1)[0]?.text).not.toBe("One moment.");
    await c.clock.advance(1, settle);
    expect(c.lines.some((l) => /pipeline filler spoken at 3000ms of thinking turn=1 len=11$/.test(l))).toBe(true);
    await c.clock.advance(5_000, settle);
    const after = t.at.filter((x) => x.at >= start);
    expect(after.map((x) => x.text)).toEqual(["One moment.", "Okay, noted."]);
    // The reply waited for the filler's audio (1,100 ms from 3,000 ms), though it came at 3,500 ms.
    expect(after[1].at - after[0].at).toBeGreaterThanOrEqual(1_100);
    expect(c.sent.filter((m) => m.t === "flush")).toHaveLength(flushes);
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=3500ms rounds=- tools=0 speak=\d+ms total=\d+ms chars=\d+ filler=yes /.test(l))).toBe(true);
    await c.end();
    expect((await rowsOf(c)).some((m) => m.body === "One moment.")).toBe(false);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    const p = (row.usage as unknown as { pipeline: { fillers: number; spokenChars: number } }).pipeline;
    expect(p.fillers).toBe(1);
    expect(p.spokenChars).toBeGreaterThanOrEqual("One moment.".length + "Okay, noted.".length);
    expect(c.lines.some((l) => /pipeline summary .* fillers=1 /.test(l))).toBe(true);
  });

  const fillersSpoken = (c: Awaited<ReturnType<typeof call>>) =>
    c.lines.map((l) => / pipeline filler spoken at (\d+)ms of thinking turn=(\d+) /.exec(l)).filter((m) => m !== null).map((m) => [Number(m[2]), Number(m[1])]);
  const skipped = (c: Awaited<ReturnType<typeof call>>) =>
    c.lines.map((l) => / pipeline filler skipped \(previous turn had one\) turn=(\d+) at (\d+)ms of thinking$/.exec(l)).filter((m) => m !== null).map((m) => [Number(m[1]), Number(m[2])]);
  /** One typed buyer line, then the turn's thinking, reply and speech played out. */
  const ask = async (c: Awaited<ReturnType<typeof call>>, text: string) => {
    c.engine.onClientMessage({ t: "text", text });
    await c.clock.advance(12_000, settle);
  };

  it("never on two answered turns in a row: the second is skipped (logged) at 3,000 ms; the turn after gets one again", async () => {
    const c = await call({ thinkMsByTurn: [4_000, 4_000, 4_000] });
    await ask(c, "Which sensors fit two kitchens?");
    expect(fillersSpoken(c)).toEqual([[1, 3_000]]);
    await ask(c, "And a gateway?");
    // Turn 2: the previous answered turn had a filler, and it thought less than 6,000 ms: no filler, one log line.
    expect(fillersSpoken(c)).toEqual([[1, 3_000]]);
    expect(skipped(c)).toEqual([[2, 3_000]]);
    expect(c.lines.filter((l) => l.includes("pipeline filler skipped (previous turn had one)"))).toHaveLength(1);
    expect(c.lines.some((l) => /pipeline turn=2 listen=- think=4000ms .*chars=\d+ model=/.test(l) && !l.includes("filler=yes"))).toBe(true);
    // Turn 3: turn 2 had none, so the 3,000 ms filler is back.
    await ask(c, "How much is it?");
    expect(fillersSpoken(c)).toEqual([[1, 3_000], [3, 3_000]]);
    expect(skipped(c)).toEqual([[2, 3_000]]);
    await c.end();
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    expect((row.usage as unknown as { pipeline: { fillers: number; turns: number } }).pipeline).toMatchObject({ fillers: 2, turns: 3 });
  });

  it("after a turn that had one, a turn thinking past 6,000 ms still gets the filler (at 6,000 ms, not before)", async () => {
    expect(PIPELINE_FILLER.afterPreviousMs).toBe(6_000);
    const c = await call({ thinkMsByTurn: [4_000, 7_000] });
    await ask(c, "Which sensors fit two kitchens?");
    expect(fillersSpoken(c)).toEqual([[1, 3_000]]);
    c.engine.onClientMessage({ t: "text", text: "And for a third site?" });
    await c.clock.advance(5_999, settle);
    expect(skipped(c)).toEqual([[2, 3_000]]);
    expect(fillersSpoken(c)).toEqual([[1, 3_000]]);
    await c.clock.advance(1, settle);
    expect(fillersSpoken(c)).toEqual([[1, 3_000], [2, 6_000]]);
    await c.clock.advance(10_000, settle);
    expect(c.lines.some((l) => /pipeline turn=2 listen=- think=7000ms .* filler=yes /.test(l))).toBe(true);
    await c.end();
  });

  it("a fast turn after one with a filler: neither a filler nor the skip line", async () => {
    const c = await call({ thinkMsByTurn: [4_000, 1_000] });
    await ask(c, "Which sensors fit two kitchens?");
    await ask(c, "Thanks.");
    expect(fillersSpoken(c)).toEqual([[1, 3_000]]);
    expect(skipped(c)).toEqual([]);
    await c.end();
  });

  it("the buyer speaking at the threshold: no filler", async () => {
    const c = await call({ thinkMs: 4_000 });
    const speaker = said(c) as InstanceType<typeof ScriptedSpeaker>;
    const before = speaker.said.length;
    c.engine.onClientMessage({ t: "text", text: "Hello there" });
    // Speech from 2,500 ms to 3,300 ms: the buyer is speaking at the 3,000 ms threshold.
    await c.clock.advance(2_500, settle);
    for (let x = 0; x < 800; x += 100) {
      c.engine.onClientAudio(micPcm(100, true));
      await c.clock.advance(100, settle);
    }
    expect(c.lines.some((l) => l.includes("pipeline turn=1 filler skipped: the buyer is speaking"))).toBe(true);
    await c.clock.advance(4_000, settle);
    expect(speaker.said.slice(before).map((x) => x.text)).toEqual(["Okay, noted."]);
    await c.end();
  });

  it("a barge-in during the filler cuts it like any barge-in; the reply still comes after", async () => {
    const ref = { now: () => 0 };
    const t = timedSpeaker(ref);
    const c = await call({ thinkMs: 5_000, speaker: t.speaker });
    ref.now = () => c.clock.now();
    // The (long) opener plays out first.
    await c.clock.advance(10_000, settle);
    const flushes = c.sent.filter((m) => m.t === "flush").length;
    const start = c.clock.now();
    c.engine.onClientMessage({ t: "text", text: "Hello there" });
    await c.clock.advance(PIPELINE_FILLER.afterMs + 100, settle);
    for (let x = 0; x < 400; x += 100) {
      c.engine.onClientAudio(micPcm(100, true));
      await c.clock.advance(100, settle);
    }
    expect(c.lines.some((l) => l.includes("pipeline barge-in by=speech (filler)"))).toBe(true);
    expect(c.sent.filter((m) => m.t === "flush")).toHaveLength(flushes + 1);
    await c.clock.advance(6_000, settle);
    expect(t.at.filter((x) => x.at >= start).map((x) => x.text)).toEqual(["One moment.", "Okay, noted."]);
    await c.end();
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    expect((row.usage as unknown as { pipeline: { bargeIns: number; fillers: number } }).pipeline).toMatchObject({ bargeIns: 1, fillers: 1 });
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
