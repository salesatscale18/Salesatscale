/**
 * The pipeline proof end to end through the relay (lib/voice/socket.ts → lib/voice-pipeline/engine.ts) on PGlite:
 * a hand-driven listener, the scripted speaker and a ScriptedLlm running the REAL chat turn (replyToBuyer →
 * runBuyerTurn, tools included). No network, nothing paid.
 *
 * One agent at a time, with the real block (lib/voice/one-agent.ts): the call's own chat turns pass (callSessionId →
 * exceptSessionId), every other trigger is still blocked while the call is live (checked below). The chat turn stamps
 * its reply with the session; the engine sets spokenAtMs/answerMs; a quote message a tool writes stays unstamped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion } = await import("@/lib/agent/service");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } = await import("@/lib/voice/service");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const { textTurnBlocked } = await import("@/lib/voice/one-agent");
const { micPcm } = await import("@/lib/voice/scripted-realtime");
const { ManualListener } = await import("@/lib/voice-pipeline/listener");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");
const { spokenForm } = await import("@/lib/voice-pipeline/spoken");

const SCRIPTED = { VOICE_REALTIME: "scripted" };

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "p", email: "p@p.test", firstName: "Pat", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "p-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [
    { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
    { sku: "GW-10", name: "Site gateway", unit: "site" },
    { sku: "PLAN-M", name: "Monitoring plan", unit: "site", kind: "service" },
  ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
  await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }, { sku: "PLAN-M", recurring: 9_000 }], { userId: me.id });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number } | null = null;
  send(d: string | Uint8Array) { this.sent.push(d); }
  close(code?: number) {
    if (this.closed) return;
    this.closed = { code };
    setImmediate(() => this.emit("close", code, ""));
  }
  json() {
    return this.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as Record<string, unknown>);
  }
  audio() {
    return this.sent.filter((x): x is Uint8Array => typeof x !== "string");
  }
}

const REPLY_1 = "Great, two sites noted. Our plans are here: https://acme.test/plans What do you use today?";
const REPLY_2 = "It is ₪59 per site each month. Want the quote in the chat?";

describe("pipeline proof: listen, think, speak", () => {
  it("a full call: opener, a spoken turn with a tool round, a typed turn; rows once each, audio, timings, a clean end", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    const listener = new ManualListener();
    const speaker = new ScriptedSpeaker("scripted", { msPerChar: 4, maxMs: 600, chunkMs: 100 });
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const llm = new ScriptedLlm([
      () => ({ content: [use("t1", "update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: "quote", objection: null })] }),
      () => ({ content: [use("t2", "create_quote", { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discount_percent: 0, sites: 2 })] }),
      () => ({ content: [{ type: "text", text: REPLY_1 }] }),
      () => ({ content: [{ type: "text", text: REPLY_2 }] }),
    ]);
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 3));
      }
    };
    const audio = async (ms: number, loud: boolean) => {
      for (let x = 0; x < ms; x += 100) {
        ws.emit("message", Buffer.from(micPcm(100, loud)), true);
        await clock.advance(100, settle);
      }
    };
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, log, pipeline: { listener: () => listener, speaker, llm } });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    // The opener (a new conversation): stored as the agent's first message and spoken.
    await clock.advance(1_500, settle);
    expect(lines.some((l) => l.includes(`engine=pipeline`) && l.includes("listen=scripted"))).toBe(true);
    // Sentence by sentence (the opener has a few).
    const openerSaid = speaker.said.length;
    expect(openerSaid).toBeGreaterThanOrEqual(1);
    const [opener] = await db.select().from(messages).where(eq(messages.conversationId, conv.conversationId));
    expect(speaker.said.map((x) => x.text).join(" ")).toBe(spokenForm(opener.body));
    expect(lines.some((l) => /trace t=\d+ pipeline opener \(now\)/.test(l))).toBe(true);

    // Turn 1: the buyer speaks, stops; the final transcript comes 200 ms after the detector's end.
    await audio(600, true);
    await audio(800, false);
    await clock.advance(200, settle);
    listener.final("We have two sites.");
    await settle();
    await clock.advance(1_500, settle);
    // Noise: a one-letter transcript is ignored (no row, no turn).
    listener.final("a");
    await settle();
    // Turn 2: typed.
    ws.emit("message", Buffer.from(JSON.stringify({ t: "text", text: "How much is it?" })), false);
    await settle();
    await clock.advance(2_000, settle);
    // Another trigger is still blocked while the call is live (the block only lets the call's own turns pass).
    expect(await textTurnBlocked(db, acc, conv.conversationId, "typed message")).toBe(true);

    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;

    // Rows: each line once, in order, marked as said on this call (the chat turn stamps the session, the engine the
    // spoken time); the quote message the tool wrote is the app's, not stamped; the end line last.
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.conversationId)).orderBy(asc(messages.createdAt));
    const all = rows.filter((m) => m.actor !== "system");
    expect(all.map((m) => [m.actor, m.voiceSessionId === s.sessionId])).toEqual([
      ["agent", true], ["buyer", true], ["agent", false], ["agent", true], ["buyer", true], ["agent", true],
    ]);
    const quoteMsg = all[2];
    expect(quoteMsg).toMatchObject({ voiceSessionId: null, spokenAtMs: null });
    expect(quoteMsg.body).toMatch(/Q-\d+/);
    const talk = all.filter((m) => m !== quoteMsg);
    for (const m of talk) expect(m.spokenAtMs).not.toBeNull();
    expect(talk[1]).toMatchObject({ body: "We have two sites.", typedInCall: false });
    expect(talk[3]).toMatchObject({ body: "How much is it?", typedInCall: true });
    // The chat rows keep the chat's own text (the link too); what was spoken is the spoken form (no URL).
    expect(talk[2].body).toContain("https://acme.test/plans");
    expect(talk[4].body).toBe(REPLY_2);
    const said = speaker.said.slice(openerSaid).map((x) => x.text).join(" ");
    expect(said).toContain("the link in the chat");
    expect(said).not.toContain("https://");
    expect(said).toContain(spokenForm(talk[2].body));
    expect(talk[2].answerMs).not.toBeNull();
    expect(talk[4].answerMs).not.toBeNull();
    expect(rows.filter((m) => m.actor === "buyer" && m.body === "We have two sites.")).toHaveLength(1);
    expect(rows.some((m) => m.body === "a")).toBe(false);
    expect(rows[rows.length - 1].body).toMatch(/^Voice call ended · \d+:\d{2}$/);
    // The tool round was the chat turn's own (stored on the reply).
    const calls = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conv.conversationId)));
    expect(calls.map((c) => [c.name, c.messageId])).toEqual([["update_deal_state", talk[2].id], ["create_quote", talk[2].id]]);
    expect(llm.requests).toHaveLength(4);

    // Audio went out as PCM frames of at most 100 ms; the browser was told the states.
    expect(ws.audio().length).toBeGreaterThan(5);
    expect(ws.audio().every((a) => a.byteLength % 2 === 0 && a.byteLength <= 4_800)).toBe(true);
    const states = ws.json().filter((m) => m.t === "state").map((m) => m.state);
    expect(states).toEqual(expect.arrayContaining(["listening", "checking", "speaking", "ended"]));

    // The trace: per-turn timings (listen, think, speak, total), then the medians.
    const turn1 = lines.find((l) => /pipeline turn=1 listen=\d+ms think=\d+ms tools=2 speak=\d+ms total=\d+ms chars=\d+/.test(l));
    expect(turn1).toBeDefined();
    expect(Number(/listen=(\d+)ms/.exec(turn1!)![1])).toBeGreaterThanOrEqual(200);
    expect(lines.some((l) => /pipeline turn=2 listen=-ms think=\d+ms tools=0 speak=\d+ms total=\d+ms/.test(l))).toBe(true);
    expect(lines.some((l) => /pipeline summary turns=2 spoken=2 median answer=\d+ms listen=\d+ms think=\d+ms speak=\d+ms/.test(l))).toBe(true);
    // The speech end asked the listener to finalise the utterance; the final came a few hundred ms later and was used at once.
    expect(listener.utteranceEnds).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => /pipeline transcript final after [1-9]\d{2}ms/.test(l))).toBe(true);
    expect(lines.some((l) => /pipeline noise ignored len=1/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("text agent blocked: pipeline call"))).toBe(false);
    expect(lines.some((l) => /ended reason=user_hangup .* engine=pipeline/.test(l))).toBe(true);

    // The session: ended cleanly, its engine and models kept, usage figures, nothing priced (scripted).
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(row).toMatchObject({ status: "ended", endReason: "user_hangup", costMicros: 0, recordingState: "off" });
    expect(row.settings).toMatchObject({ engine: "pipeline", pipeline: { listenModel: "scripted", speakModel: "scripted" } });
    expect((row.usage as unknown as { pipeline: { turns: number; spokenChars: number; medianAnswerMs: number } }).pipeline).toMatchObject({ turns: 2 });
    expect(row.answerMsAvg).not.toBeNull();
    const summary = await voiceSessionSummary(db, acc, conv.conversationId);
    expect(summary?.engine).toBe("pipeline");
    expect(summary?.pipeline).toMatchObject({ listenModel: "scripted", speakModel: "scripted" });
    expect(summary?.pipeline?.medianAnswerMs).toBeGreaterThan(0);
  });

  it("barge-in: buyer speech while the agent speaks stops the audio, flushes the browser and listens; the reply row stays whole", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    const listener = new ManualListener();
    // Long speech (5 s), so the agent is still speaking when the buyer cuts in.
    const speaker = new ScriptedSpeaker("scripted", { msPerChar: 100, maxMs: 5_000, chunkMs: 100 });
    const long = "This is a long answer about our plans and prices. It goes on for a while. And then some more.";
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: long }] }), () => ({ content: [{ type: "text", text: "Sure, go ahead." }] })]);
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) };
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 3));
      }
    };
    // A chat that already has an agent message: no opener, the call starts by listening.
    await db.insert(messages).values({ accountId: acc, conversationId: conv.conversationId, actor: "agent", body: "Hi from the chat." });
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, log, pipeline: { listener: () => listener, speaker, llm } });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    expect(lines.some((l) => l.includes("opener none"))).toBe(true);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "text", text: "Tell me about the plans." })), false);
    await settle();
    await clock.advance(500, settle);
    const before = ws.audio().length;
    expect(before).toBeGreaterThan(0);
    // The buyer talks over the agent: 400 ms of speech (≥ 300 ms) → barge-in.
    for (let x = 0; x < 400; x += 100) {
      ws.emit("message", Buffer.from(micPcm(100, true)), true);
      await clock.advance(100, settle);
    }
    expect(ws.json().some((m) => m.t === "flush")).toBe(true);
    expect(speaker.cancels).toBeGreaterThan(0);
    expect(lines.some((l) => /pipeline barge-in by=speech/.test(l))).toBe(true);
    const afterCut = ws.audio().length;
    await clock.advance(2_000, settle);
    expect(ws.audio().length).toBe(afterCut);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.conversationId)).orderBy(asc(messages.createdAt));
    expect(rows.find((m) => m.actor === "agent" && m.voiceSessionId === s.sessionId)?.body).toBe(long);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect((row.usage as unknown as { pipeline: { bargeIns: number } }).pipeline.bargeIns).toBe(1);
  });
});
