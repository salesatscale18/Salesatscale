/**
 * Call turns (runBuyerTurn with a valid callSessionId): "reply with bookkeeping" finishes in one model round when the
 * reply text comes with update_deal_state only and its result adds nothing the reply must reflect; every guard
 * trigger falls back to the normal next round. Chat turns are unchanged. The caller's call context line reaches the
 * per-turn context of a valid call turn only. Scripted model only (no paid calls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, leads, messages, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, readDealState, verifyField } from "@/lib/agent/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { runBuyerTurn } from "@/lib/agent/turn";
import { OPT_OUT_REPLY } from "@/lib/agent/safety";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { seedCatalog, seedPricing } from "../helpers/pricing";
import { createTestDb, type TestDb } from "../helpers/db";

const say = (text: string): Block => ({ type: "text", text });
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const step = (...content: Block[]) => () => ({ content });
const uds = (id: string, over: Record<string, unknown> = {}) => use(id, "update_deal_state", {
  updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null, ...over,
});

describe("call turn: reply with bookkeeping", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "otr", email: "otr@p.test", firstName: "Oz", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "otr-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
    await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await db.delete(rateLimits);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  /** A test-lab conversation with one live call on it. */
  async function liveCall() {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    await db.update(voiceSessions).set({ status: "live" }).where(eq(voiceSessions.id, s.sessionId));
    const [conv] = await db.select({ leadId: conversations.leadId }).from(conversations).where(eq(conversations.id, c.conversationId));
    return { conversationId: c.conversationId, leadId: conv.leadId, sessionId: s.sessionId };
  }
  /** A chat conversation with no call on it. */
  async function chat() {
    const c = await liveCall();
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, c.sessionId));
    return c;
  }
  const call = (c: { conversationId: string; sessionId: string }, llm: ScriptedLlm, text = "We run a cafe.", extra: { callContextLine?: string } = {}) =>
    runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text, callSessionId: c.sessionId, ...extra });
  const lastUser = (req: LlmRequest) => req.messages[req.messages.length - 1];

  it("text + update_deal_state: one model call; reply stored, stamped, with usage and the tool call; deal updated", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("A cafe, great. How many sites do you have?"), uds("u1", { asked: ["sites"] }))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out).toMatchObject({ status: "replied", text: "A cafe, great. How many sites do you have?", calls: 1 });
    if (out.status !== "replied") return;
    const [m] = await db.select().from(messages).where(eq(messages.id, out.messageId));
    expect([m.actor, m.voiceSessionId, m.usage?.inputTokens, m.usage?.model]).toEqual(["agent", c.sessionId, 10, "scripted"]);
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.messageId, out.messageId));
    expect(calls.map((x) => [x.name, x.outcome])).toEqual([["update_deal_state", "ok"]]);
    expect(calls[0].result).toMatchObject({ ok: true, saved: ["business_type"], recorded_as_asked: ["sites"] });
    const deal = await readDealState(db, acc, c.leadId);
    expect(deal?.fields.business_type?.value).toBe("Cafe");
    const [lead] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("agent_handling");
  });

  it("the reply goes through plainChatText as a normal final reply", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("**A cafe**, great."), uds("u1"))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out).toMatchObject({ status: "replied", text: "A cafe, great." });
  });

  it("a later round can finish with bookkeeping too (search, then text + update: two calls, not three)", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(use("s1", "search_catalog", { query: "seat" })), step(say("We have user seats."), uds("u1"))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(2);
    expect(out).toMatchObject({ status: "replied", text: "We have user seats.", calls: 2 });
  });

  describe("guard triggers fall back to the normal next round", () => {
    const twoRounds = async (c: { conversationId: string; sessionId: string }, first: Block[], text = "We run a cafe.") => {
      const llm = new ScriptedLlm([step(...first), step(say("Second round reply."))]);
      const out = await call(c, llm, text);
      expect(llm.requests).toHaveLength(2);
      expect(out).toMatchObject({ status: "replied", text: "Second round reply." });
      // The model saw the results and wrote again.
      const results = lastUser(llm.requests[1]).content as { type: string; content: string }[];
      expect(results.every((r) => r.type === "tool_result")).toBe(true);
      return { out, llm, results: results.map((r) => JSON.parse(r.content) as Record<string, unknown>) };
    };

    it("refusal (only unknown fields)", async () => {
      const { results } = await twoRounds(await liveCall(), [say("Noted."), uds("u", { updates: [{ key: "colour", value: "red", provenance: "buyer" }] })]);
      expect(results[0]).toMatchObject({ ok: false, refused: true });
    });

    it("a field ignored as unknown next to a saved one", async () => {
      const { results } = await twoRounds(await liveCall(), [say("Noted."), uds("u", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "colour", value: "red", provenance: "buyer" }] })]);
      expect(results[0].ignored_unknown).toEqual(["colour"]);
    });

    it("a verified field kept", async () => {
      const c = await liveCall();
      await verifyField(db, { userId: me.id, actingAs: false }, acc, c.leadId, "business_type", "Bakery");
      const { results } = await twoRounds(c, [say("Noted."), uds("u")]);
      expect(results[0].kept_verified).toEqual(["business_type"]);
    });

    it("a placeholder rejected (message in the result)", async () => {
      const { results } = await twoRounds(await liveCall(), [say("Noted."), uds("u", { updates: [{ key: "sites", value: "unknown", provenance: "buyer" }] })]);
      expect(results[0].rejected_placeholder).toEqual(["sites"]);
    });

    it("a stage change (recommendation confirmed)", async () => {
      const { results } = await twoRounds(await liveCall(), [say("Great."), uds("u", { recommendation_confirmed: true })], "Sounds right.");
      expect(String(results[0].stage)).toContain("4 Quote and close");
    });

    it("a price question (the stage block's instruction changes)", async () => {
      await twoRounds(await liveCall(), [say("Let me check."), uds("u", { price_asked: true })], "How much is it?");
    });

    it("an objection opened (Paused), then an objection note on a repeated step", async () => {
      const c = await liveCall();
      const objection = { play: "too_expensive", buyer_words: "too pricey", step: 1, attempt: false, status: "open" };
      const first = await twoRounds(c, [say("I hear you."), uds("u", { objection })], "That's too pricey.");
      expect(String(first.results[0].stage)).toContain("Paused:");
      const second = await twoRounds(c, [say("I hear you."), uds("v", { updates: [], objection })], "Still too pricey.");
      expect(second.results[0].objection_note).toMatch(/already used/);
    });

    it("text + a non-bookkeeping tool", async () => {
      await twoRounds(await liveCall(), [say("Let me look."), use("s", "search_catalog", { query: "seat" })]);
    });

    it("text + bookkeeping + another tool", async () => {
      await twoRounds(await liveCall(), [say("Let me look."), uds("u"), use("s", "search_catalog", { query: "seat" })]);
    });

    it("empty text with bookkeeping", async () => {
      await twoRounds(await liveCall(), [say("  \n "), uds("u")]);
    });
  });

  it("chat turn: unchanged (two rounds; the same requests with no call session or an invalid one)", async () => {
    const runChat = async (callSessionId?: string) => {
      const c = await chat();
      const llm = new ScriptedLlm([step(say("A cafe, great."), uds("u1")), step(say("A cafe, great. How many sites?"))]);
      const out = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "We run a cafe.", callContextLine: "Live call line.", ...(callSessionId ? { callSessionId } : {}) });
      expect(out).toMatchObject({ status: "replied", text: "A cafe, great. How many sites?", calls: 1 });
      if (out.status !== "replied") throw new Error();
      const [m] = await db.select().from(messages).where(eq(messages.id, out.messageId));
      expect(m.voiceSessionId).toBeNull();
      return llm.requests;
    };
    const plain = await runChat();
    const invalid = await runChat("not-a-uuid");
    const otherConv = await runChat((await liveCall()).sessionId);
    expect(plain).toHaveLength(2);
    // Round 2 is round 1's request plus the model's response and the tool results, nothing else.
    const [r1, r2] = plain;
    expect(r2.system).toEqual(r1.system);
    expect(r2.messages.slice(0, r1.messages.length - 1)).toEqual(r1.messages.slice(0, -1));
    expect(r2.messages.slice(-2).map((x) => x.role)).toEqual(["assistant", "user"]);
    // The caller's line never reaches a chat turn.
    for (const req of [...plain, ...invalid, ...otherConv]) expect(req.system.join("\n")).not.toContain("Live call line.");
    // The local time line differs per run; every other part of the requests is the same.
    const norm = (reqs: LlmRequest[]) => JSON.stringify(reqs).replace(/Local time now[^\\]*/g, "").replace(/"(toolu_|id)[^"]*"/g, "");
    expect(norm(invalid)).toBe(norm(plain));
    expect(norm(otherConv)).toBe(norm(plain));
  });

  it("the caller's call context line: on a valid call turn, one line at the end of the per-turn context", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("Hello."))]);
    await call(c, llm, "Hi", { callContextLine: "  This is a live call.\nKeep it short.  " });
    const perTurn = llm.requests[0].system[1];
    expect(perTurn.endsWith("\nThis is a live call. Keep it short.")).toBe(true);
    expect(llm.requests[0].system[0]).not.toContain("This is a live call.");

    const c2 = await liveCall();
    const llm2 = new ScriptedLlm([step(say("Hello."))]);
    await call(c2, llm2, "Hi", { callContextLine: "y".repeat(1000) });
    expect(llm2.requests[0].system[1].endsWith(`\n${"y".repeat(600)}`)).toBe(true);
    expect(llm2.requests[0].system[1]).not.toContain("y".repeat(601));

    // Empty or whitespace: nothing added.
    const c3 = await liveCall();
    const llm3 = new ScriptedLlm([step(say("Hello."))]);
    await call(c3, llm3, "Hi", { callContextLine: " \n " });
    expect(llm3.requests[0].system[1]).toMatch(/Write your reply and any text you pass to tools in it\.$/);
  });

  it("replyToBuyer passes callContextLine through with callSessionId", async () => {
    const c = await liveCall();
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "Hi", language: "en", voiceSessionId: c.sessionId, spokenAtMs: 1_000 });
    const llm = new ScriptedLlm([step(say("Hello."))]);
    const out = await replyToBuyer(db, llm, null, { accountId: acc, conversationId: c.conversationId, leadId: c.leadId, text: "Hi" }, { callSessionId: c.sessionId, callContextLine: "Pipeline line." });
    expect(out.turn.status).toBe("replied");
    expect(llm.requests[0].system[1].endsWith("\nPipeline line.")).toBe(true);
  });

  it("opt-out: a STOP on a call gets the fixed reply with no model call, stamped", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([]);
    const out = await call(c, llm, "STOP");
    expect(llm.requests).toHaveLength(0);
    expect(out).toMatchObject({ status: "replied", text: OPT_OUT_REPLY.en, calls: 0 });
    if (out.status !== "replied") return;
    const [m] = await db.select().from(messages).where(eq(messages.id, out.messageId));
    expect(m.voiceSessionId).toBe(c.sessionId);
  });

  it("opt-out by the model: text + record_opt_out is not bookkeeping; the fixed reply wins", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("Bye then."), use("o", "record_opt_out", { reason: "no more" })), step(say("Whatever."))]);
    const out = await call(c, llm, "Please never contact me again, remove me.");
    expect(llm.requests).toHaveLength(2);
    expect(out).toMatchObject({ status: "replied", text: OPT_OUT_REPLY.en });
  });

  it("a turn whose single round fails is handled as today (system line, error status, nothing spoken)", async () => {
    const c = await liveCall();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await call(c, new ScriptedLlm([]));
    expect(out).toMatchObject({ status: "error" });
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "system")));
    expect(rows.map((r) => r.body)).toContain("The agent could not reply (model error). Try again.");
  });

  it("a fallback round that fails keeps the bookkeeping call with the system line (as today)", async () => {
    const c = await liveCall();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await call(c, new ScriptedLlm([step(say("Noted."), uds("u", { recommendation_confirmed: true }))]), "Sounds right.");
    expect(out).toMatchObject({ status: "error" });
    const [sys] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "system")));
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.messageId, sys.id));
    expect(calls.map((x) => x.name)).toEqual(["update_deal_state"]);
  });
});
