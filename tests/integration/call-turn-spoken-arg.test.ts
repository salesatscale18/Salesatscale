/**
 * Call turns with the caller's opt-in (callReplyArgDescription): update_deal_state gets a `spoken_reply` argument,
 * and a response of update_deal_state calls only, with no text, finishes the turn with it in one model round when
 * the results pass the acknowledgement guards. The argument never reaches the tool handler or the stored call row.
 * Chat turns send exactly TOOL_DEFS. Scripted model only (no paid calls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { conversations, messages, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, readDealState, verifyField } from "@/lib/agent/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { runBuyerTurn } from "@/lib/agent/turn";
import { TOOL_DEFS } from "@/lib/agent/tools";
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
const DESC = "Your spoken reply to the buyer for this turn.";
const udsSchema = (req: LlmRequest) => req.tools.find((t) => t.name === "update_deal_state")!.input_schema as { properties: Record<string, unknown>; required: string[] };

describe("call turn: spoken_reply on update_deal_state", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "spk", email: "spk@p.test", firstName: "Oz", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "spk-o@x.test" });
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

  async function liveCall() {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    await db.update(voiceSessions).set({ status: "live" }).where(eq(voiceSessions.id, s.sessionId));
    const [conv] = await db.select({ leadId: conversations.leadId }).from(conversations).where(eq(conversations.id, c.conversationId));
    return { conversationId: c.conversationId, leadId: conv.leadId, sessionId: s.sessionId };
  }
  async function chat() {
    const c = await liveCall();
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, c.sessionId));
    return c;
  }
  type Call = { conversationId: string; sessionId: string };
  /** desc null: no opt-in (the option is left out). */
  const call = (c: Call, llm: ScriptedLlm, text = "We run a cafe.", desc: string | null = DESC) =>
    runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text, callSessionId: c.sessionId, ...(desc === null ? {} : { callReplyArgDescription: desc }) });

  it("opt-in + [update_deal_state{spoken_reply}]: one model call; reply stored and stamped; row without the argument; deal saved", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(uds("u1", { asked: ["sites"], spoken_reply: "A **cafe**, great. How many sites?" }))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(1);
    expect(udsSchema(llm.requests[0]).properties.spoken_reply).toEqual({ type: ["string", "null"], description: DESC });
    expect(udsSchema(llm.requests[0]).required).toContain("spoken_reply");
    expect(out).toMatchObject({ status: "replied", text: "A cafe, great. How many sites?", calls: 1 });
    if (out.status !== "replied") return;
    const [m] = await db.select().from(messages).where(eq(messages.id, out.messageId));
    expect([m.actor, m.body, m.voiceSessionId, m.usage?.model]).toEqual(["agent", "A cafe, great. How many sites?", c.sessionId, "scripted"]);
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.messageId, out.messageId));
    expect(rows.map((r) => [r.name, r.outcome])).toEqual([["update_deal_state", "ok"]]);
    expect(rows[0].input).not.toHaveProperty("spoken_reply");
    expect(rows[0].input).toMatchObject({ asked: ["sites"] });
    expect((await readDealState(db, acc, c.leadId))?.fields.business_type?.value).toBe("Cafe");
  });

  it("several calls carry one: the last non-empty is the reply", async () => {
    const c = await liveCall();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const llm = new ScriptedLlm([step(uds("u1", { spoken_reply: "First." }), uds("u2", { updates: [], asked: ["sites"], spoken_reply: "Second." }), uds("u3", { updates: [], spoken_reply: " " }))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out).toMatchObject({ status: "replied", text: "Second.", calls: 3 });
  });

  it("the tool list is the same on every round of a call turn", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(use("s", "search_catalog", { query: "seat" })), step(uds("u", { recommendation_confirmed: true, spoken_reply: "Great." })), step(say("Done."))]);
    const out = await call(c, llm, "Sounds right.");
    expect(llm.requests).toHaveLength(3);
    expect(out).toMatchObject({ status: "replied", text: "Done." });
    expect(JSON.stringify(llm.requests[1].tools)).toBe(JSON.stringify(llm.requests[0].tools));
    expect(JSON.stringify(llm.requests[2].tools)).toBe(JSON.stringify(llm.requests[0].tools));
  });

  describe("the argument is ignored and the normal next round runs", () => {
    const twoRounds = async (c: Call, first: Block[], text = "We run a cafe.") => {
      const llm = new ScriptedLlm([step(...first), step(say("Second round reply."))]);
      const out = await call(c, llm, text);
      expect(llm.requests).toHaveLength(2);
      expect(out).toMatchObject({ status: "replied", text: "Second round reply." });
      // The assistant tool_use goes back as the model wrote it; the results are the handler's.
      const sent = llm.requests[1].messages;
      const results = (sent[sent.length - 1].content as { type: string; content: string }[]).map((r) => JSON.parse(r.content) as Record<string, unknown>);
      if (out.status === "replied") {
        const rows = await db.select().from(toolCalls).where(eq(toolCalls.messageId, out.messageId));
        for (const r of rows) expect(r.input).not.toHaveProperty("spoken_reply");
      }
      return { results, sent };
    };

    it("refusal (only unknown fields)", async () => {
      const { results } = await twoRounds(await liveCall(), [uds("u", { updates: [{ key: "colour", value: "red", provenance: "buyer" }], spoken_reply: "Noted." })]);
      expect(results[0]).toMatchObject({ ok: false, refused: true });
    });
    it("an unknown field ignored", async () => {
      const { results } = await twoRounds(await liveCall(), [uds("u", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "colour", value: "red", provenance: "buyer" }], spoken_reply: "Noted." })]);
      expect(results[0].ignored_unknown).toEqual(["colour"]);
    });
    it("a verified field kept", async () => {
      const c = await liveCall();
      await verifyField(db, { userId: me.id, actingAs: false }, acc, c.leadId, "business_type", "Bakery");
      const { results } = await twoRounds(c, [uds("u", { spoken_reply: "Noted." })]);
      expect(results[0].kept_verified).toEqual(["business_type"]);
    });
    it("a placeholder rejected", async () => {
      const { results } = await twoRounds(await liveCall(), [uds("u", { updates: [{ key: "sites", value: "unknown", provenance: "buyer" }], spoken_reply: "Noted." })]);
      expect(results[0].rejected_placeholder).toEqual(["sites"]);
    });
    it("a stage change", async () => {
      const { results, sent } = await twoRounds(await liveCall(), [uds("u", { recommendation_confirmed: true, spoken_reply: "Great." })], "Sounds right.");
      expect(String(results[0].stage)).toContain("4 Quote and close");
      // History keeps the tool_use as written (thinking/tool consistency); the handler's result is not touched.
      const assistant = sent[sent.length - 2].content as { type: string; input?: Record<string, unknown> }[];
      expect(assistant.find((b) => b.type === "tool_use")?.input?.spoken_reply).toBe("Great.");
      expect(results[0]).not.toHaveProperty("spoken_reply");
    });
    it("an objection note on a repeated step", async () => {
      const c = await liveCall();
      const objection = { play: "too_expensive", buyer_words: "too pricey", step: 1, attempt: false, status: "open" };
      await twoRounds(c, [uds("u", { objection, spoken_reply: "I hear you." })], "That's too pricey.");
      const { results } = await twoRounds(c, [uds("v", { updates: [], objection, spoken_reply: "I hear you." })], "Still too pricey.");
      expect(results[0].objection_note).toMatch(/already used/);
    });
    it("spoken_reply with another tool", async () => {
      await twoRounds(await liveCall(), [uds("u", { spoken_reply: "Let me look." }), use("s", "search_catalog", { query: "seat" })]);
    });
    it("empty or whitespace spoken_reply", async () => {
      await twoRounds(await liveCall(), [uds("u", { spoken_reply: "  \n " })]);
      await twoRounds(await liveCall(), [uds("u", { spoken_reply: null })]);
    });
  });

  it("text beside the call still wins (the text path stays)", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("Text reply."), uds("u", { spoken_reply: "Arg reply." }))]);
    const out = await call(c, llm);
    expect(llm.requests).toHaveLength(1);
    expect(out).toMatchObject({ status: "replied", text: "Text reply." });
  });

  it("no opt-in: no such argument; one sent anyway is stripped and ignored", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(uds("u", { spoken_reply: "Sneaky." })), step(say("Real reply."))]);
    const out = await call(c, llm, "We run a cafe.", null);
    expect(JSON.stringify(llm.requests[0].tools)).toBe(JSON.stringify(TOOL_DEFS));
    expect(llm.requests).toHaveLength(2);
    expect(out).toMatchObject({ status: "replied", text: "Real reply." });
    if (out.status !== "replied") return;
    const [row] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, out.messageId));
    expect(row.input).not.toHaveProperty("spoken_reply");
    expect(row.outcome).toBe("ok");
    // Whitespace-only description: no opt-in either.
    const c2 = await liveCall();
    const llm2 = new ScriptedLlm([step(say("Hi."))]);
    await call(c2, llm2, "Hi", " \n ");
    expect(JSON.stringify(llm2.requests[0].tools)).toBe(JSON.stringify(TOOL_DEFS));
  });

  it("chat turn (no, invalid or another conversation's session) with the description set: exactly TOOL_DEFS, no change", async () => {
    for (const sid of [undefined, "not-a-uuid", (await liveCall()).sessionId]) {
      const c = await chat();
      const llm = new ScriptedLlm([step(uds("u", { spoken_reply: "Chat arg." })), step(say("Chat reply."))]);
      const out = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "We run a cafe.", callReplyArgDescription: DESC, ...(sid ? { callSessionId: sid } : {}) });
      expect(llm.requests).toHaveLength(2);
      for (const r of llm.requests) expect(JSON.stringify(r.tools)).toBe(JSON.stringify(TOOL_DEFS));
      expect(out).toMatchObject({ status: "replied", text: "Chat reply." });
      if (out.status !== "replied") continue;
      // Chat stores the call input exactly as the model sent it (as today).
      const [row] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, out.messageId));
      expect(row.input).toHaveProperty("spoken_reply", "Chat arg.");
    }
  });

  it("replyToBuyer passes callReplyArgDescription through with callSessionId only", async () => {
    const c = await liveCall();
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "We run a cafe.", language: "en", voiceSessionId: c.sessionId, spokenAtMs: 1_000 });
    const llm = new ScriptedLlm([step(uds("u", { spoken_reply: "A cafe, great." }))]);
    const out = await replyToBuyer(db, llm, null, { accountId: acc, conversationId: c.conversationId, leadId: c.leadId, text: "We run a cafe." }, { callSessionId: c.sessionId, callReplyArgDescription: DESC });
    expect(out.turn).toMatchObject({ status: "replied", text: "A cafe, great." });
    expect(llm.requests).toHaveLength(1);
  });
});
