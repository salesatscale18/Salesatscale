/**
 * A call's own chat turn (the voice pipeline): runBuyerTurn / replyToBuyer with `callSessionId`.
 * - the call whose session is given does not block the turn; any other live call (or none given) still does;
 * - the messages the turn writes carry the call's voiceSessionId; without it nothing is stamped.
 * Scripted model only (no paid calls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { runBuyerTurn } from "@/lib/agent/turn";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { seedCatalog, seedPricing } from "../helpers/pricing";
import { createTestDb, type TestDb } from "../helpers/db";

const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

describe("a call's own chat turn (callSessionId)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "cs", email: "cs@p.test", firstName: "Oz", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "cs-o@x.test" });
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
  const thread = (conversationId: string) => db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);

  it("the call's own session runs the turn and stamps the buyer message and the reply; another id or none is in_call", async () => {
    const c = await liveCall();
    const llm = new ScriptedLlm([step(say("It is 100 ILS per seat."))]);
    const before = (await thread(c.conversationId)).length;

    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "How much?" })).status).toBe("in_call");
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "How much?", callSessionId: crypto.randomUUID() })).status).toBe("in_call");
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "How much?", callSessionId: "not-a-uuid" })).status).toBe("in_call");
    expect(await thread(c.conversationId)).toHaveLength(before);

    const out = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "How much?", callSessionId: c.sessionId });
    expect(out.status).toBe("replied");
    if (out.status !== "replied") return;
    const rows = (await thread(c.conversationId)).slice(before);
    expect(rows.map((m) => [m.actor, m.body, m.voiceSessionId])).toEqual([
      ["buyer", "How much?", c.sessionId],
      ["agent", "It is 100 ILS per seat.", c.sessionId],
    ]);
    expect(rows[1].id).toBe(out.messageId);
    // spokenAtMs is the call's own timing: the turn does not set it.
    expect(rows.every((m) => m.spokenAtMs === null)).toBe(true);
  });

  it("a second live call on the conversation still blocks the first call's own turn", async () => {
    const c = await liveCall();
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.sessionId));
    const { id: _id, ...copy } = row;
    void _id;
    await db.insert(voiceSessions).values({ ...copy, status: "live" });
    const out = await runBuyerTurn(db, new ScriptedLlm([step(say("Hi"))]), { accountId: acc, conversationId: c.conversationId, text: "Hi", callSessionId: c.sessionId });
    expect(out.status).toBe("in_call");
  });

  it("a session of another conversation lifts nothing; with no call on, it runs but stamps nothing", async () => {
    const a = await liveCall();
    const b = await liveCall();
    expect((await runBuyerTurn(db, new ScriptedLlm([step(say("Hi"))]), { accountId: acc, conversationId: a.conversationId, text: "Hi", callSessionId: b.sessionId })).status).toBe("in_call");
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, a.sessionId));
    const before = (await thread(a.conversationId)).length;
    const out = await runBuyerTurn(db, new ScriptedLlm([step(say("Hello"))]), { accountId: acc, conversationId: a.conversationId, text: "Hi", callSessionId: b.sessionId });
    expect(out.status).toBe("replied");
    expect((await thread(a.conversationId)).slice(before).map((m) => m.voiceSessionId)).toEqual([null, null]);
  });

  it("without callSessionId and no call, nothing is stamped (as before)", async () => {
    const c = await liveCall();
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, c.sessionId));
    const before = (await thread(c.conversationId)).length;
    const out = await runBuyerTurn(db, new ScriptedLlm([step(say("Hello"))]), { accountId: acc, conversationId: c.conversationId, text: "Hi" });
    expect(out.status).toBe("replied");
    expect((await thread(c.conversationId)).slice(before).map((m) => [m.actor, m.voiceSessionId])).toEqual([["buyer", null], ["agent", null]]);
  });

  it("replyToBuyer passes callSessionId through; its call shape without it is unchanged (in_call during a call)", async () => {
    const c = await liveCall();
    // The pipeline stores the buyer's line itself, then asks for the reply.
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "Do you have seats?", language: "en", voiceSessionId: c.sessionId, spokenAtMs: 4_000 });
    const m = { accountId: acc, conversationId: c.conversationId, leadId: c.leadId, text: "Do you have seats?" };
    const llm = new ScriptedLlm([step(say("Yes, user seats."))]);
    expect((await replyToBuyer(db, llm, null, m)).turn.status).toBe("in_call");
    const out = await replyToBuyer(db, llm, null, m, { trigger: "voice pipeline", callSessionId: c.sessionId });
    expect(out.turn.status).toBe("replied");
    if (out.turn.status !== "replied") return;
    const [reply] = await db.select().from(messages).where(and(eq(messages.id, out.turn.messageId), eq(messages.accountId, acc)));
    expect([reply.actor, reply.body, reply.voiceSessionId]).toEqual(["agent", "Yes, user seats.", c.sessionId]);
    // buyerMessageStored: the turn stored no second buyer line.
    expect((await thread(c.conversationId)).filter((x) => x.actor === "buyer")).toHaveLength(1);
  });
});
