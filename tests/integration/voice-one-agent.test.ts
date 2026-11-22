/**
 * One agent at a time on a conversation (owner, 23 Nov 2026), deterministic on PGlite with a fake model:
 * - while a call is pending or live, chat-turn triggers are told to stand down (textTurnBlocked), and the
 *   after-call reply of an earlier call is skipped;
 * - a call's start waits for a chat turn still answering the buyer's typed message;
 * - a call that continues a chat does not count its pick-up line as a new agent message for the stage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, inheritedSummary } from "@/lib/voice/engine";
import { activeCallOn, textTurnBlocked } from "@/lib/voice/one-agent";
import { replyAfterCall } from "@/lib/voice/after-call";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";

class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  readonly modelId = "google/gemini-3.8-live";
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[] }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c = { cfg, emit: onEvent, results: [] as { name: string; result: Record<string, unknown> }[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, requestResponse: () => undefined, close: () => undefined,
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: result as Record<string, unknown> }),
    };
  }
}

describe("one agent at a time", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "o", email: "o@p.test", firstName: "Oz", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  async function conversation(lines: { actor: "agent" | "buyer"; body: string; ageMs: number }[] = []) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    for (const l of lines) {
      await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: l.actor, body: l.body, language: "en", createdAt: new Date(Date.now() - l.ageMs) });
    }
    return c.conversationId;
  }

  async function engineFor(conversationId: string, logs: string[]) {
    const s = await createVoiceSession(db, { accountId: acc, conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new FakeModel();
    const engine = new VoiceEngine({
      db, model, sessionId: s.sessionId, clock, send: () => undefined,
      log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l) }, limits: { env: {}, standbyAfterQuietMs: 600_000 },
    });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    return { s, clock, model, engine, settle, run: (ms: number) => clock.advance(ms, settle) };
  }

  it("a pending or live call blocks every chat-turn trigger (one log line); none once it ended", async () => {
    const conv = await conversation();
    expect(await activeCallOn(db, acc, conv)).toBeNull();
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await textTurnBlocked(db, acc, conv, "test lab")).toBe(true);
    expect(info.mock.calls.map((c) => String(c[0])).some((l) => l.endsWith("text agent blocked: test lab"))).toBe(true);
    info.mockRestore();
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, s.sessionId));
    expect(await textTurnBlocked(db, acc, conv, "typed message")).toBe(false);
  });

  it("the after-call reply of an earlier call is skipped while a new call on the conversation is pending", async () => {
    const conv = await conversation();
    // A buyer call (the after-call reply is for buyer calls only): a session made a buyer one.
    const first = await createVoiceSession(db, { accountId: acc, conversationId: conv, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!first.ok) throw new Error(first.reason);
    await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, first.sessionId));
    await db.insert(messages).values({ accountId: acc, conversationId: conv, actor: "buyer", body: "And the price?", language: "en", voiceSessionId: first.sessionId });
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, first.sessionId));
    const second = await createVoiceSession(db, { accountId: acc, conversationId: conv, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!second.ok) throw new Error(second.reason);
    const llm = { create: vi.fn() };
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await replyAfterCall(db, llm as never, first.sessionId)).toEqual({ status: "skipped", reason: "call_active" });
    expect(llm.create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a call's start waits for a chat turn still answering the buyer's typed message, then starts from its reply", async () => {
    const conv = await conversation([{ actor: "agent", body: "Hi, this is Ava. How many sites do you have?", ageMs: 30_000 }, { actor: "buyer", body: "Two sites.", ageMs: 2_000 }]);
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    // While the start waits, only the clock moves (the engine's queue is busy with the start).
    const flush = async () => { for (let i = 0; i < 20; i++) await flushAsync(); };
    const started = c.engine.start();
    await c.clock.advance(1_500, flush);
    expect(c.model.conns).toHaveLength(0);
    // The chat turn answers.
    await db.insert(messages).values({ accountId: acc, conversationId: conv, actor: "agent", body: "Got it. What kind of business is it?", language: "en" });
    await c.clock.advance(1_000, flush);
    await started;
    await c.settle();
    expect(c.model.conns).toHaveLength(1);
    expect(logs.some((l) => /voice start waited \d+ms for a text turn$/.test(l))).toBe(true);
    // The call starts from the chat's reply: the pick-up re-asks its question.
    expect(c.model.conns[0].cfg.instructions).toContain("Got it. What kind of business is it?");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a call that continues a chat: the pick-up line is not a new agent message for the stage (as in chat)", async () => {
    const conv = await conversation([{ actor: "agent", body: "Hi, this is Ava. What kind of business is it, and how many sites?", ageMs: 120_000 }]);
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    expect(logs.some((l) => l.includes("inherited: agentMessages=1 continuing=yes"))).toBe(true);
    const emit = c.model.conns[0].emit;
    emit({ type: "audio", pcm: new Uint8Array(480) });
    emit({ type: "agent-transcript", text: "So, what kind of business is it, and how many sites?", final: true });
    emit({ type: "turn-done" });
    await c.run(500);
    c.engine.onClientMessage({ t: "text", text: "A restaurant, two sites." });
    await c.run(300);
    emit({ type: "tool-call", callId: "u1", name: "update_deal_state", args: { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null } });
    await c.run(500);
    const stage = String(c.model.conns[0].results.find((r) => r.name === "update_deal_state")!.result.stage);
    // One agent message (the chat's) and no recorded ask: still Understand, as a chat turn would be. Counting the
    // pick-up line made it Recommend one exchange early.
    expect(stage).toMatch(/^## Stage now: 2 Understand/);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("the inherited-state line names counts and the stage, never content", () => {
    const line = inheritedSummary(2, true, { _asked_sites: { value: "2" }, sites: { value: "secret" } }, "x\n## Stage now: 3 Recommend\ny");
    expect(line).toBe('inherited: agentMessages=2 continuing=yes stage="3 Recommend" asked=sites:2');
  });
});
