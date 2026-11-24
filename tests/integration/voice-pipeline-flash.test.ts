/**
 * The "pipeline" engine thinking on Gemini 3.8 Flash (GatewayLlm) and "pipeline_chat" on the chat model, through
 * the relay on PGlite. The gateway model is always a MockLanguageModelV4 (no network, nothing paid); the listener
 * and speaker are the free fakes; the chat turn is the real one (replyToBuyer → runBuyerTurn).
 *
 * - parts: "pipeline" calls the gateway client factory with the version (15 s per call, 1 retry by default),
 *   "pipeline_chat" keeps the chat client, a missing gateway key refuses the thinking client, scripted mode keeps
 *   the scripted chat model for both;
 * - a live call on "pipeline": a tool round then the answer, spoken; rows once; the reply's usage under the gateway
 *   model id; settings.pipeline.thinkModel and the summary trace name it; the session's cost is listening +
 *   speaking only (thinking is on the chat row, never counted twice);
 * - a failing turn (model error): nothing of the error is spoken; the neutral retry line is, the engine listens again
 *   and the next turn works;
 * - a thinking client that cannot be built: the call is refused (model_unavailable) with a log line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { and, asc, eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
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
const { ManualListener } = await import("@/lib/voice-pipeline/listener");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");
const { spokenForm } = await import("@/lib/voice-pipeline/spoken");
const { GatewayLlm, PIPELINE_TEXT_MODEL, pipelineLlmFor } = await import("@/lib/voice-pipeline/gateway-llm");
const { liveGatewayLlm, pipelinePartsFor, PipelineThinkingUnavailable, SCRIPTED_PIPELINE_REPLY, PIPELINE_THINK_TIMEOUT_MS } = await import("@/lib/voice-pipeline");
const { RETRY_LINE } = await import("@/lib/voice-pipeline/engine");
const { PIPELINE_LISTEN_MODEL, PIPELINE_SPEAK_MODEL, LISTEN_MICROS_PER_SEC, SPEAK_MICROS_PER_CHAR, pipelineCostMicros, PIPELINE_CALL_CONTEXT_LINE } = await import("@/lib/voice-pipeline/models");
const { callTurnOptions, makeCallTurn } = await import("@/lib/voice-pipeline/turn");
type CallTurnFn = import("@/lib/voice-pipeline/turn").CallTurnFn;

const LIVE = { VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "test-key-never-sent" };

const usage = { inputTokens: { total: 1000, noCache: 400, cacheRead: 600, cacheWrite: undefined }, outputTokens: { total: 30, text: 30, reasoning: undefined } };
const result = (content: LanguageModelV4Content[], unified: LanguageModelV4GenerateResult["finishReason"]["unified"]): LanguageModelV4GenerateResult =>
  ({ content, finishReason: { unified, raw: undefined }, usage, warnings: [] });
const toolCall = (id: string, name: string, input: unknown): LanguageModelV4Content => ({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) });

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "f", email: "f@p.test", firstName: "Fay", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "f-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" }, { sku: "GW-10", name: "Site gateway", unit: "site" }], []);
  await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string | Uint8Array) { this.sent.push(d); }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    setImmediate(() => this.emit("close", code, ""));
  }
  json() {
    return this.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as Record<string, unknown>);
  }
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await flushAsync(4);
    await new Promise((r) => setTimeout(r, 3));
  }
};

describe("pipeline parts: which thinking client", () => {
  const version = { model: "claude-sonnet-5-5", effort: "high" };
  const fakes = () => ({ listener: () => new ManualListener(), speaker: new ScriptedSpeaker() });

  it("pipeline (live): the gateway client factory is called with the version and env; its model id is the thinking model", async () => {
    const made = new GatewayLlm({ modelId: PIPELINE_TEXT_MODEL, model: new MockLanguageModelV4({}) });
    const factory = vi.fn(() => made);
    const parts = await pipelinePartsFor("live", LIVE, { ...fakes(), gatewayLlm: factory }, { engine: "pipeline", version });
    expect(factory).toHaveBeenCalledWith(version, LIVE);
    expect(parts.llm).toBe(made);
    expect(parts.thinkModel).toBe(PIPELINE_TEXT_MODEL);
  });

  it("pipeline_chat (live): the chat client, never the gateway factory; the version's model thinks", async () => {
    const factory = vi.fn();
    const parts = await pipelinePartsFor("live", LIVE, { ...fakes(), gatewayLlm: factory }, { engine: "pipeline_chat", version });
    expect(factory).not.toHaveBeenCalled();
    expect(parts.llm).not.toBeInstanceOf(GatewayLlm);
    expect(parts.thinkModel).toBe("claude-sonnet-5-5");
  });

  it("the default gateway client: the pipeline text model, 15 s per call, 1 retry; refused without AI_GATEWAY_API_KEY", async () => {
    const llm = liveGatewayLlm(version, LIVE) as InstanceType<typeof GatewayLlm>;
    expect(llm).toBeInstanceOf(GatewayLlm);
    expect(llm.modelId).toBe(PIPELINE_TEXT_MODEL);
    expect((llm as unknown as { opts: Record<string, unknown> }).opts).toMatchObject({ timeoutMs: PIPELINE_THINK_TIMEOUT_MS, maxRetries: 1, reasoning: "low" });
    expect(PIPELINE_THINK_TIMEOUT_MS).toBe(15_000);
    expect((liveGatewayLlm(version, { ...LIVE, VOICE_PIPELINE_TEXT_MODEL: "google/gemini-3.9-flash" }) as InstanceType<typeof GatewayLlm>).modelId).toBe("google/gemini-3.9-flash");
    const noKey = { VOICE_REALTIME: "live" };
    await expect(pipelinePartsFor("live", noKey, fakes(), { engine: "pipeline", version })).rejects.toBeInstanceOf(PipelineThinkingUnavailable);
    await expect(pipelinePartsFor("live", noKey, fakes(), { engine: "pipeline", version })).rejects.toThrow(`pipeline thinking model unavailable (${PIPELINE_TEXT_MODEL}): AI_GATEWAY_API_KEY is not set`);
  });

  it("scripted mode: the scripted chat model for both engines (no gateway factory)", async () => {
    const factory = vi.fn();
    for (const engine of ["pipeline", "pipeline_chat"] as const) {
      const parts = await pipelinePartsFor("scripted", {}, { gatewayLlm: factory }, { engine, version });
      expect(parts.llm).toBeInstanceOf(ScriptedLlm);
      const r = await parts.llm.create({ model: "x", system: ["", ""], tools: [], messages: [] } as never);
      expect(r.content).toEqual([{ type: "text", text: SCRIPTED_PIPELINE_REPLY }]);
      expect(parts.thinkModel).toBe("scripted");
    }
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("pipeline engine on Gemini Flash (fake gateway model)", () => {
  async function startCall(engine: "pipeline" | "pipeline_chat", gatewayLlm: (v: { model: string; effort: string | null }, env: Record<string, string | undefined>) => InstanceType<typeof GatewayLlm>, turn?: CallTurnFn) {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: LIVE, engine });
    if (!s.ok) throw new Error(s.reason);
    expect(s.mode).toBe("live");
    const listener = new ManualListener(PIPELINE_LISTEN_MODEL);
    const speaker = new ScriptedSpeaker(PIPELINE_SPEAK_MODEL, { msPerChar: 4, maxMs: 600, chunkMs: 100 });
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const factory = vi.fn(gatewayLlm);
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: LIVE, clock, log, pipeline: { listener: () => listener, speaker, gatewayLlm: factory, ...(turn ? { turn } : {}) } });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    await clock.advance(1_500, settle);
    const type = async (text: string) => {
      ws.emit("message", Buffer.from(JSON.stringify({ t: "text", text })), false);
      await settle();
      await clock.advance(2_000, settle);
    };
    const end = async () => {
      ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
      await clock.advance(100, settle);
      await done;
    };
    return { conv, s, listener, speaker, ws, clock, lines, factory, type, end };
  }

  it("a tool round then the answer: spoken, rows once, usage under the gateway model id, cost is listening + speaking only", async () => {
    const REPLY = "For two kitchens you need the wireless fridge sensor and one site gateway per kitchen.";
    const model = new MockLanguageModelV4({
      provider: "gateway", modelId: PIPELINE_TEXT_MODEL,
      doGenerate: [
        result([toolCall("g1", "update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: "recommend", objection: null })], "tool-calls"),
        result([{ type: "text", text: REPLY }], "stop"),
      ],
    });
    const c = await startCall("pipeline", (v, env) => pipelineLlmFor(v, env, { model, timeoutMs: 15_000, maxRetries: 1 }));
    expect(c.factory).toHaveBeenCalledTimes(1);
    expect(c.factory.mock.calls[0][0]).toMatchObject({ model: expect.any(String), effort: expect.anything() });
    const openerSaid = c.speaker.said.length;
    expect(openerSaid).toBeGreaterThan(0);
    await c.type("We run two restaurant kitchens. What do I need?");
    await c.end();

    expect(model.doGenerateCalls).toHaveLength(2);
    // Spoken: the reply's spoken form, after the opener.
    expect(c.speaker.said.slice(openerSaid).map((x) => x.text).join(" ")).toBe(spokenForm(REPLY));
    // Rows: the buyer line and the reply once each, stamped with the call; the reply's usage under the gateway id.
    const rows = await db.select().from(messages).where(eq(messages.conversationId, c.conv.conversationId)).orderBy(asc(messages.createdAt));
    const talk = rows.filter((m) => m.actor !== "system");
    expect(talk.map((m) => m.actor)).toEqual(["agent", "buyer", "agent"]);
    expect(rows.filter((m) => m.body === REPLY)).toHaveLength(1);
    const reply = talk[2];
    expect(reply).toMatchObject({ body: REPLY, voiceSessionId: c.s.sessionId });
    expect(reply.spokenAtMs).not.toBeNull();
    expect(reply.usage).toMatchObject({ model: PIPELINE_TEXT_MODEL, inputTokens: 800, outputTokens: 60, cacheReadTokens: 1200 });
    const calls = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, c.conv.conversationId)));
    expect(calls.map((x) => [x.name, x.messageId])).toEqual([["update_deal_state", reply.id]]);
    expect(rows.filter((m) => m.actor === "system").map((m) => m.body)).toEqual([expect.stringMatching(/^Voice call ended/)]);

    // The session: engine and thinking model kept; the cost is the pipeline's own (listening + speaking).
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    expect(row).toMatchObject({ status: "ended", mode: "live" });
    expect(row.settings).toMatchObject({ engine: "pipeline", pipeline: { thinkModel: PIPELINE_TEXT_MODEL, listenModel: PIPELINE_LISTEN_MODEL, speakModel: PIPELINE_SPEAK_MODEL } });
    const p = (row.usage as unknown as { pipeline: { thinkModel: string; listenSec: number; spokenChars: number; listenCostMicros: number; speakCostMicros: number } }).pipeline;
    expect(p.thinkModel).toBe(PIPELINE_TEXT_MODEL);
    const est = pipelineCostMicros(PIPELINE_LISTEN_MODEL, p.listenSec, PIPELINE_SPEAK_MODEL, p.spokenChars);
    expect(p.speakCostMicros).toBe(SPEAK_MICROS_PER_CHAR[PIPELINE_SPEAK_MODEL] * p.spokenChars);
    expect(p.listenCostMicros).toBe(Math.round(LISTEN_MICROS_PER_SEC[PIPELINE_LISTEN_MODEL] * p.listenSec));
    expect(p.speakCostMicros).toBeGreaterThan(0);
    expect(row.costMicros).toBe(est.listen + est.speak);
    expect(row.costMicros).toBe(p.listenCostMicros + p.speakCostMicros);
    const summary = await voiceSessionSummary(db, acc, c.conv.conversationId);
    expect(summary?.engine).toBe("pipeline");
    expect(summary?.pipeline?.thinkModel).toBe(PIPELINE_TEXT_MODEL);
    // The card's round medians (one turn of two rounds).
    expect(summary?.pipeline?.medianRounds).toBe(2);
    expect(summary?.pipeline?.medianRoundMs).toEqual(expect.any(Number));
    expect(c.lines.some((l) => l.includes("listenRate=150 micros/s"))).toBe(true);

    // The trace: the thinking model at the start and in the summary; per-turn timings with the tool count.
    expect(c.lines.some((l) => l.includes(`socket accepted mode=live engine=pipeline think=${PIPELINE_TEXT_MODEL}`))).toBe(true);
    expect(c.lines.some((l) => l.includes(`engine=pipeline mode=live listen=${PIPELINE_LISTEN_MODEL} think=${PIPELINE_TEXT_MODEL}/`))).toBe(true);
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=\d+ms rounds=\S+ (?:roundsMs=\S+ other=\d+ms )?tools=1 speak=\d+ms total=\d+ms/.test(l))).toBe(true);
    expect(c.lines.some((l) => /pipeline summary turns=1 spoken=1 .*thinking is on the chat rows\) think=google\/gemini-3\.8-flash$/.test(l))).toBe(true);
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=\d+ms rounds=\S+ (?:roundsMs=\S+ other=\d+ms )?tools=1 speak=\d+ms total=\d+ms chars=\d+ model=google\/gemini-3\.8-flash/.test(l))).toBe(true);
    // Per round: one line each (never the text), capped at 700 output tokens; the turn line sums them up; the summary's medians.
    expect(model.doGenerateCalls.map((x) => x.maxOutputTokens)).toEqual([700, 700]);
    const roundLines = c.lines.filter((l) => / pipeline think round=/.test(l));
    expect(roundLines).toHaveLength(2);
    expect(roundLines[0]).toMatch(/pipeline think round=1 ms=\d+ in=\d+ cached=\d+ out=\d+ reasoning=\S+ finish=tool-calls tools=\[update_deal_state\] textChars=0$/);
    expect(roundLines[1]).toMatch(new RegExp(`pipeline think round=2 ms=\\d+ in=\\d+ cached=\\d+ out=\\d+ reasoning=\\S+ finish=stop tools=\\[\\] textChars=${REPLY.length}$`));
    expect(roundLines.join(" ")).not.toContain("kitchens");
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=\d+ms rounds=2 roundsMs=\d+\+\d+ other=\d+ms tools=1 /.test(l))).toBe(true);
    expect(c.lines.some((l) => /pipeline summary .* speakFirstAudio=\d+ms rounds\/turn=2 oneRound=0\/1 ms\/round=\d+ms other\/turn=\d+ms cachedIn=\d+% fillers=0 /.test(l))).toBe(true);
  });

  it("a failing turn (model error): the error is never spoken, the neutral retry line is, the engine listens again, the next turn answers", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      provider: "gateway", modelId: PIPELINE_TEXT_MODEL,
      doGenerate: async () => {
        n++;
        if (n === 1) throw Object.assign(new Error("The agent could not reply: upstream exploded"), { statusCode: 500, type: "internal" });
        return result([{ type: "text", text: "Sure, it is fifty nine shekels per sensor." }], "stop");
      },
    });
    const c = await startCall("pipeline", (v, env) => pipelineLlmFor(v, env, { model, timeoutMs: 15_000, maxRetries: 0 }));
    const openerSaid = c.speaker.said.length;
    await c.type("How much is a sensor?");
    // The failed turn: only the neutral line is said (call language English), then back to listening.
    expect(c.speaker.said.slice(openerSaid).map((x) => x.text)).toEqual([RETRY_LINE.en]);
    const states = c.ws.json().filter((m) => m.t === "state").map((m) => m.state);
    expect(states.slice(-3)).toEqual(["checking", "speaking", "listening"]);
    expect(c.lines.some((l) => l.includes("pipeline turn failed: GatewayLlmError"))).toBe(true);
    // The browser got the neutral line, never an agent line with the error text.
    const agentLines = c.ws.json().filter((m) => m.t === "transcript" && m.role === "agent").map((m) => String(m.text));
    expect(agentLines).toContain(RETRY_LINE.en);
    expect(agentLines.some((x) => /could not reply|exploded/i.test(x))).toBe(false);
    // The next turn works.
    await c.type("How much is a sensor, again?");
    expect(c.speaker.said.slice(openerSaid).map((x) => x.text)).toEqual([RETRY_LINE.en, "Sure, it is fifty nine shekels per sensor."]);
    await c.end();
    expect(c.speaker.said.some((x) => /could not reply|exploded/i.test(x.text))).toBe(false);
    // The chat turn's own system line stays in the thread (not spoken); the retry line is not stored as an agent row.
    const rows = await db.select().from(messages).where(eq(messages.conversationId, c.conv.conversationId));
    expect(rows.filter((m) => m.actor === "system").map((m) => m.body)).toContain("The agent could not reply (model error). Try again.");
    expect(rows.some((m) => m.body === RETRY_LINE.en)).toBe(false);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    expect((row.usage as unknown as { endDetail: { lastError?: string } }).endDetail.lastError).toBe("pipeline turn failed: GatewayLlmError");
  });

  /** A fake Gemini model answering with the reply text AND update_deal_state in one response (the one-round case). */
  const oneRoundModel = (reply: string) => new MockLanguageModelV4({
    provider: "gateway", modelId: PIPELINE_TEXT_MODEL,
    doGenerate: [result([
      { type: "text", text: reply },
      toolCall("g1", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null }),
    ], "tool-calls")],
  });
  const systemOf = (model: InstanceType<typeof MockLanguageModelV4>) => JSON.stringify(model.doGenerateCalls[0].prompt.filter((m) => m.role === "system"));

  it("text + update_deal_state in one response: one model call, the reply spoken, the tool row stored; rounds=1, oneRound=1/1", async () => {
    const REPLY = "A cafe, great. How many sites do you run?";
    const model = oneRoundModel(REPLY);
    const c = await startCall("pipeline", (v, env) => pipelineLlmFor(v, env, { model, timeoutMs: 15_000, maxRetries: 1 }));
    const openerSaid = c.speaker.said.length;
    await c.type("We run a cafe.");
    await c.end();
    expect(model.doGenerateCalls).toHaveLength(1);
    // The call's context line (models.ts) reached the model on this call turn.
    expect(systemOf(model)).toContain(PIPELINE_CALL_CONTEXT_LINE);
    expect(c.speaker.said.slice(openerSaid).map((x) => x.text).join(" ")).toBe(spokenForm(REPLY));
    const rows = await db.select().from(messages).where(eq(messages.conversationId, c.conv.conversationId)).orderBy(asc(messages.createdAt));
    const reply = rows.find((m) => m.body === REPLY)!;
    expect(reply).toMatchObject({ actor: "agent", voiceSessionId: c.s.sessionId });
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.messageId, reply.id));
    expect(calls.map((x) => [x.name, x.outcome])).toEqual([["update_deal_state", "ok"]]);
    expect(c.lines.some((l) => /pipeline turn=1 listen=- think=\d+ms rounds=1 roundsMs=\d+ other=\d+ms tools=1 /.test(l))).toBe(true);
    expect(c.lines.some((l) => /pipeline summary .* rounds\/turn=1 oneRound=1\/1 /.test(l))).toBe(true);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.s.sessionId));
    expect((row.usage as unknown as { pipeline: Record<string, unknown> }).pipeline).toMatchObject({ roundTurns: 1, oneRoundTurns: 1, medianRounds: 1 });
  });

  it("the call's context line empty: the property is not passed and nothing reaches the model", async () => {
    expect(callTurnOptions("sess", "")).toEqual({ trigger: "pipeline call", callSessionId: "sess" });
    expect("callContextLine" in callTurnOptions("sess", "  ")).toBe(false);
    expect(callTurnOptions("sess", PIPELINE_CALL_CONTEXT_LINE)).toEqual({ trigger: "pipeline call", callSessionId: "sess", callContextLine: PIPELINE_CALL_CONTEXT_LINE });
    const model = oneRoundModel("A cafe, noted. How many sites?");
    const c = await startCall("pipeline", (v, env) => pipelineLlmFor(v, env, { model, timeoutMs: 15_000, maxRetries: 1 }), makeCallTurn(""));
    await c.type("We run a cafe.");
    await c.end();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(model)).not.toContain("This is a live call.");
  });

  it("a thinking client that cannot be built refuses the call (model_unavailable), never falls back to the chat model", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: LIVE, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    const ws = new FakeSocket();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const speaker = new ScriptedSpeaker(PIPELINE_SPEAK_MODEL);
    const done = handleVoiceSocket(ws, {
      db, deadlineSec: null, env: LIVE, clock: new ManualClock(), log,
      pipeline: { listener: () => new ManualListener(), speaker, gatewayLlm: () => { throw new Error("AI_GATEWAY_API_KEY is not set"); } },
    });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    await done;
    expect(lines.some((l) => l.includes(`pipeline parts unavailable (engine=pipeline): `) && l.includes(`pipeline thinking model unavailable (${PIPELINE_TEXT_MODEL}): AI_GATEWAY_API_KEY is not set`))).toBe(true);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(row).toMatchObject({ status: "ended", endReason: "error", errorCode: "model_unavailable" });
    expect(ws.json()).toContainEqual(expect.objectContaining({ t: "error", code: "model_unavailable" }));
    expect(speaker.said).toHaveLength(0);
  });

  it("pipeline_chat: the chat client thinks (the gateway factory is never called), stored as pipeline_chat", async () => {
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Hello from the chat model." }], model: "claude-sonnet-5-5" })]);
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: LIVE, engine: "pipeline_chat" });
    if (!s.ok) throw new Error(s.reason);
    const [s0] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(s0.settings).toEqual({ engine: "pipeline_chat" });
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const factory = vi.fn();
    const speaker = new ScriptedSpeaker(PIPELINE_SPEAK_MODEL, { msPerChar: 4, maxMs: 600, chunkMs: 100 });
    // The chat client is the test's ScriptedLlm (the live default would be the Anthropic client).
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: LIVE, clock, log, pipeline: { listener: () => new ManualListener(), speaker, llm, gatewayLlm: factory } });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket })), false);
    await settle();
    await clock.advance(1_500, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "text", text: "Hi there" })), false);
    await settle();
    await clock.advance(2_000, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    expect(factory).not.toHaveBeenCalled();
    expect(speaker.said.map((x) => x.text)).toContain("Hello from the chat model.");
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(row.settings).toMatchObject({ engine: "pipeline_chat" });
    expect((row.settings as { pipeline: { thinkModel: string } }).pipeline.thinkModel).not.toBe(PIPELINE_TEXT_MODEL);
    expect(lines.some((l) => /ended reason=user_hangup .* engine=pipeline_chat/.test(l))).toBe(true);
    const summary = await voiceSessionSummary(db, acc, conv.conversationId);
    expect(summary?.engine).toBe("pipeline_chat");
    expect(summary?.pipeline).not.toBeNull();
  });
});
