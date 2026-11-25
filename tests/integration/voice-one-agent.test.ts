/**
 * One agent at a time on a conversation (owner, 23 Nov 2026), deterministic on PGlite with a fake model:
 * - while a call is pending or live, chat-turn triggers are told to stand down (textTurnBlocked), and the
 *   after-call reply of an earlier call is skipped;
 * - a call's start waits for a chat turn still answering the buyer's typed message;
 * - a call that continues a chat does not count its pick-up line as a new agent message for the stage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { conversations, messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { notSavedYet, OBJECTION_FIRST, VoiceEngine, inheritedSummary } from "@/lib/voice/engine";
import { readDealState } from "@/lib/agent/service";
import { seedCatalog, seedPricing } from "../helpers/pricing";
import { activeCallOn, textTurnBlocked } from "@/lib/voice/one-agent";
import { replyAfterCall, unansweredCallTurn } from "@/lib/voice/after-call";
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
    await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
    await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  /** `app`: an agent-actor message the app wrote (no agent version), e.g. a follow-up or a card. */
  async function conversation(lines: { actor: "agent" | "buyer"; body: string; ageMs: number; app?: boolean }[] = []) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const [cv] = await db.select({ v: conversations.agentVersionId }).from(conversations).where(eq(conversations.id, c.conversationId));
    for (const l of lines) {
      await db.insert(messages).values({
        accountId: acc, conversationId: c.conversationId, actor: l.actor, body: l.body, language: "en", createdAt: new Date(Date.now() - l.ageMs),
        ...(l.actor === "agent" && !l.app ? { agentVersionId: cv.v } : {}),
      });
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

  it("exceptSessionId: a live call's own session does not block; any other live call still does; no option as before", async () => {
    const conv = await conversation();
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    await db.update(voiceSessions).set({ status: "live" }).where(eq(voiceSessions.id, s.sessionId));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await textTurnBlocked(db, acc, conv, "test")).toBe(true);
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), { exceptSessionId: crypto.randomUUID() })).toBe(true);
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), {})).toBe(true);
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), { exceptSessionId: s.sessionId })).toBe(false);
    // A second live session T on the conversation: excepting S still leaves T blocking (and the other way round).
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    const { id: _id, ...copy } = row;
    void _id;
    const [tRow] = await db.insert(voiceSessions).values({ ...copy, status: "live" }).returning({ id: voiceSessions.id });
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), { exceptSessionId: s.sessionId })).toBe(true);
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), { exceptSessionId: tRow.id })).toBe(true);
    info.mockRestore();
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.conversationId, conv));
    expect(await textTurnBlocked(db, acc, conv, "test", new Date(), { exceptSessionId: s.sessionId })).toBe(false);
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
    // Check and claim are one step: the claim was taken, then given back, so a later path can still answer.
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, first.sessionId));
    expect((await unansweredCallTurn(db, row))?.claimed).toBe(false);
    vi.restoreAllMocks();
  });

  it("a call's start waits for a chat turn still answering the buyer's typed message, then starts from its reply", async () => {
    const conv = await conversation([{ actor: "agent", body: "Hi, this is Ava. How many sites do you have?", ageMs: 30_000 }, { actor: "buyer", body: "Two sites.", ageMs: 10_000 }]);
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
    // The chat's intro (the agent's), and an app message after it (a follow-up template): only the intro counts, as in chat.
    const conv = await conversation([
      { actor: "agent", body: "Hi, this is Ava. What kind of business is it, and how many sites?", ageMs: 120_000 },
      { actor: "agent", body: "Just checking in: did you get a chance to look?", ageMs: 60_000, app: true },
    ]);
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

  it("race A: a typed message stored as the call is created gets no chat reply (in_call): no wait, and the call's first line answers it", async () => {
    const conv = await conversation([
      { actor: "agent", body: "Hi, this is Ava. How do you check the fridges today?", ageMs: 60_000 },
      { actor: "buyer", body: "Do the sensors need wifi?", ageMs: 300 },
    ]);
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    // Started at once, no wait.
    expect(c.model.conns).toHaveLength(1);
    expect(logs.some((l) => l.includes("voice start waited"))).toBe(false);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    // The buyer's message is stored once.
    const buyerRows = await db.select().from(messages).where(eq(messages.conversationId, conv));
    expect(buyerRows.filter((m) => m.actor === "buyer" && m.body === "Do the sensors need wifi?")).toHaveLength(1);
  });

  it("the call's first line answers an unanswered last buyer message (no re-ask of an older question, no \"go ahead\")", async () => {
    const { answerLastInstruction } = await import("@/lib/voice/instructions");
    const conv = await conversation([
      { actor: "agent", body: "Hi, this is Ava. How do you check the fridges today?", ageMs: 60_000 },
      // Old enough that no chat turn is still working on it (it failed, or was refused earlier).
      { actor: "buyer", body: "Do the sensors need wifi?", ageMs: 50_000 },
    ]);
    const prompts: string[] = [];
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    const model = c.model as FakeModel & { prompts?: string[] };
    const connect = model.connect.bind(model);
    model.connect = async (cfg, onEvent) => {
      const conn = await connect(cfg, onEvent);
      return { ...conn, requestResponse: (t?: string) => void prompts.push(t ?? "") };
    };
    await c.engine.start();
    await c.settle();
    // The answer instruction, with the recording notice as its own first sentence (never inside the buyer's words).
    expect(prompts).toHaveLength(1);
    expect(prompts[0].startsWith(answerLastInstruction("Do the sensors need wifi?", "en"))).toBe(true);
    expect(prompts[0]).toContain("“Do the sensors need wifi?”");
    expect(prompts[0]).toMatch(/Start with: "Some calls may be recorded for quality review\."$/);
    expect(prompts[0]).not.toMatch(/How do you check|go ahead/);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("update_deal_state on a call: a bookkeeping-only result is short (no stage block); a real change still delivers the stage", async () => {
    const conv = await conversation();
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    const results = () => c.model.conns[0].results.filter((r) => r.name === "update_deal_state").map((r) => r.result);
    const upd = async (id: string, args: Record<string, unknown>) => {
      emit({ type: "tool-call", callId: id, name: "update_deal_state", args: { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null, ...args } });
      await c.run(300);
    };
    // The opener is said (the stage the instructions gave: Understand, both fields missing).
    emit({ type: "audio", pcm: new Uint8Array(480) });
    emit({ type: "agent-transcript", text: "Hi, this is Ava. What kind of business is it?", final: true });
    emit({ type: "turn-done" });
    await c.run(300);
    // Only an ask recorded, the stage as the model saw it: the short form, logged.
    await upd("u1", { asked: ["business_type"], next_step: "Wait for the answer." });
    expect(results()[0]).toEqual({
      ok: true, saved: [], recorded_as_asked: ["business_type"], still_needed_before_quote: ["Business type", "Number of sites"],
      note: `${notSavedYet(["Business type", "Number of sites"])} ${OBJECTION_FIRST}`,
    });
    expect(logs.filter((l) => l.endsWith("tools: bookkeeping result shortened"))).toHaveLength(1);
    // A save that leaves a field missing: the full result with the stage block ("still missing" changed).
    await upd("u2", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }] });
    expect(String(results()[1].stage)).toMatch(/^## Stage now: .*\n[\s\S]*Still missing for a quote: Number of sites\./);
    expect(results()[1].saved).toEqual(["business_type"]);
    // Bookkeeping again, nothing changed since that block: short.
    await upd("u3", { next_step: "Ask for the number of sites." });
    expect(results()[2]).toEqual({ ok: true, saved: [], still_needed_before_quote: ["Number of sites"], note: `${notSavedYet(["Number of sites"])} ${OBJECTION_FIRST}` });
    // The last field saved: the stage moves on, so the block comes again.
    await upd("u4", { updates: [{ key: "sites", value: "2", provenance: "buyer" }] });
    expect(String(results()[3].stage)).toContain("Still missing for a quote: nothing.");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("send_order_form on a call before the buyer agreed: held (not run), recorded as refused, the model told to offer it first", async () => {
    const conv = await conversation();
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    emit({ type: "audio", pcm: new Uint8Array(480) });
    emit({ type: "agent-transcript", text: "If the price worked, is anything else in the way?", final: true });
    emit({ type: "turn-done" });
    await c.run(300);
    c.engine.onClientMessage({ t: "text", text: "Yeah, I guess so. I need a solution." });
    await c.run(300);
    emit({ type: "tool-call", callId: "f1", name: "send_order_form", args: { quote: "Q-1" } });
    await c.run(500);
    const r = c.model.conns[0].results.find((x) => x.name === "send_order_form")!.result;
    expect(r).toMatchObject({ ok: false, rule: "Not agreed yet" });
    expect(String(r.message)).toContain("The order form was NOT sent");
    expect(String(r.message)).toContain("Offer it in one short sentence and wait for their yes");
    expect(logs.some((l) => l.endsWith("tool send_order_form held: the buyer has not agreed to it yet"))).toBe(true);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("objections on a call: recorded before the answer, the full result names the open objection; a second one moves the ladder", async () => {
    const conv = await conversation();
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    const results = () => c.model.conns[0].results.filter((r) => r.name === "update_deal_state").map((r) => r.result);
    const objection = async (id: string, step: number, words: string) => {
      emit({ type: "tool-call", callId: id, name: "update_deal_state", args: {
        updates: [], next_step: null, recommendation_confirmed: null, price_asked: null, asked: null,
        objection: { play: "too_expensive", buyer_words: words, step, attempt: step > 1, status: "open" },
      } });
      await c.run(300);
    };
    emit({ type: "audio", pcm: new Uint8Array(480) });
    emit({ type: "agent-transcript", text: "Hi, this is Ava. What kind of business is it?", final: true });
    emit({ type: "turn-done" });
    await c.run(300);
    c.engine.onClientMessage({ t: "text", text: "It is actually quite expensive." });
    await c.run(300);
    await objection("o1", 1, "quite expensive");
    // Never the short form: the full result, with the open objection and the card's step used.
    expect(results()[0].objection_recorded).toMatchObject({ play: "too_expensive", status: "open", steps_used: [1] });
    expect(String(results()[0].stage)).toContain("Paused: the buyer has an open objection");
    expect(logs.some((l) => l.endsWith("tools: bookkeeping result shortened"))).toBe(false);
    c.engine.onClientMessage({ t: "text", text: "It is more than we plan to spend." });
    await c.run(300);
    await objection("o2", 2, "more than we plan to spend");
    expect(results()[1].objection_recorded).toMatchObject({ steps_used: [1, 2] });
    expect(String(results()[1].stage)).toContain("Paused: the buyer has an open objection");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("create_quote on a call that removes a line the buyer did not ask to remove: held; asked for, it runs", async () => {
    const conv = await conversation();
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    const quoteArgs = { lines: [{ sku: "SEAT-M", qty: 2 }], discount_percent: 0, sites: 1, remove_auto_added: ["INST-1"], exception: null, headline: null, assumed: null };
    c.engine.onClientMessage({ t: "text", text: "It is more than we plan to spend." });
    await c.run(300);
    emit({ type: "tool-call", callId: "q1", name: "create_quote", args: quoteArgs });
    await c.run(500);
    const held = c.model.conns[0].results.find((r) => r.name === "create_quote")!.result;
    expect(held).toMatchObject({ ok: false, rule: "Removal not asked" });
    expect(String(held.message)).toContain("The buyer did not ask to remove INST-1");
    expect(logs.some((l) => l.endsWith("tool create_quote held: removes a line the buyer did not ask to remove"))).toBe(true);
    c.engine.onClientMessage({ t: "text", text: "Can we do it without the installation?" });
    await c.run(300);
    emit({ type: "tool-call", callId: "q2", name: "create_quote", args: quoteArgs });
    await c.run(500);
    const ran = c.model.conns[0].results.filter((r) => r.name === "create_quote")[1].result;
    expect(ran.rule).not.toBe("Removal not asked");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a refused quote on a call: no total may be said; save the fact, quote again, then the walkthrough", async () => {
    const conv = await conversation();
    const c = await engineFor(conv, []);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    const quote = async (id: string) => {
      emit({ type: "tool-call", callId: id, name: "create_quote", args: { lines: [{ sku: "SEAT-M", qty: 2 }], discount_percent: 0, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null } });
      await c.run(500);
      return c.model.conns[0].results.filter((r) => r.name === "create_quote").at(-1)!.result;
    };
    c.engine.onClientMessage({ t: "text", text: "A restaurant. How much do two seats cost?" });
    await c.run(300);
    const refused = await quote("q1");
    expect(refused).toMatchObject({ ok: false, rule: "Before-quote fields missing" });
    expect(String(refused.message)).toContain("No quote was made: Business type, Number of sites not saved yet.");
    expect(String(refused.message)).toContain("Do not say any total or price for the quote until create_quote has made one.");
    emit({ type: "tool-call", callId: "u1", name: "update_deal_state", args: { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: true, asked: null } });
    await c.run(300);
    const made = await quote("q2");
    expect(made.ok).toBe(true);
    expect(String(made.message)).toContain("Walk the buyer through it");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a number the buyer stated is not lowered on an ambiguous yes; it is when the buyer says the new number", async () => {
    const conv = await conversation();
    const logs: string[] = [];
    const c = await engineFor(conv, logs);
    await c.engine.start();
    await c.settle();
    const emit = c.model.conns[0].emit;
    const [cv] = await db.select({ leadId: conversations.leadId }).from(conversations).where(eq(conversations.id, conv));
    const sites = async () => (await readDealState(db, acc, cv.leadId))?.fields?.sites?.value;
    const upd = async (id: string, value: string) => {
      emit({ type: "tool-call", callId: id, name: "update_deal_state", args: { updates: [{ key: "sites", value, provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null } });
      await c.run(300);
      return c.model.conns[0].results.filter((r) => r.name === "update_deal_state").at(-1)!.result;
    };
    c.engine.onClientMessage({ t: "text", text: "I have two sites." });
    await c.run(300);
    await upd("u1", "2");
    expect(await sites()).toBe("2");
    c.engine.onClientMessage({ t: "text", text: "Yeah, I guess so. I need a solution." });
    await c.run(300);
    const held = await upd("u2", "1");
    expect(await sites()).toBe("2");
    expect(held.kept_as_buyer_said).toEqual([{ key: "sites", label: "Number of sites", value: "2" }]);
    expect(String(held.kept_message)).toContain("Number of sites stays 2");
    expect(logs.some((l) => l.endsWith("tool update_deal_state: 1 lowered number(s) kept as the buyer said"))).toBe(true);
    c.engine.onClientMessage({ t: "text", text: "OK, let's start with one site." });
    await c.run(300);
    await upd("u3", "1");
    expect(await sites()).toBe("1");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("the inherited-state line names counts and the stage, never content", () => {
    const line = inheritedSummary(2, true, { _asked_sites: { value: "2" }, sites: { value: "secret" } }, "x\n## Stage now: 3 Recommend\ny");
    expect(line).toBe('inherited: agentMessages=2 continuing=yes stage="3 Recommend" asked=sites:2');
  });
});
