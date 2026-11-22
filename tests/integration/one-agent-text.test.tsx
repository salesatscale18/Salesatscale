/**
 * One agent at a time, the text-chat half (owner, 23 Nov 2026): while a call holds a conversation,
 * - no chat turn runs from any trigger (runBuyerTurn returns in_call; the test-lab composer, the WhatsApp/web reply
 *   path and the buyer's typed-message route each handle it without an error or a retry);
 * - due follow-ups and the named-time retry SMS wait for the next cron run after the call;
 * - a line the buyer said on a call does not cancel a follow-up as "the buyer wrote".
 * And the stage's agentMessages counts only what the agent wrote, not the app's messages.
 * ScriptedLlm and mock SMS only: no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { consentRecords, followUps, leadEvents, leads, messages, sellerAccounts, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { ensureDraftVersion, publishDraftVersion, startTestConversation } = await import("@/lib/agent/service");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { writtenByAgent } = await import("@/lib/agent/core/stage");
const { replyToBuyer } = await import("@/lib/channels/whatsapp");
const { scheduleFollowUp } = await import("@/lib/follow-ups/schedule");
const { runDueFollowUps } = await import("@/lib/follow-ups/scheduler");
const { runNamedTimeRetries } = await import("@/lib/follow-ups/named-time");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { sendTestMessageAction } = await import("@/app/app/[account]/setup/test-lab/actions");
const messagesRoute = await import("@/app/chat/[token]/messages/route");

const MIN = 60_000;
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const say = (text: string): Block => ({ type: "text", text });
const redirectOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { url?: string }).url ?? String(e); }
  return null;
};

describe("one agent at a time: the text chat", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });

  /** A real lead with consent and its web chat (the agent's opener). */
  const addLead = async () => {
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Dana Demo", phone: `+97250730${String(1000 + ++n)}`, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    if (!r.ok) throw new Error(r.reason);
    return { lead, conversationId: r.conversationId };
  };
  /** A call on the conversation, as createVoiceSession and the engine leave it. */
  const callOn = async (conversationId: string, o: { isTest?: boolean; status?: "pending" | "live" } = {}) => {
    const [s] = await db.insert(voiceSessions).values({
      accountId: acc, conversationId, isTest: o.isTest ?? false, status: o.status ?? "live", model: "scripted", mode: "scripted",
      ticketHash: randomUUID().replace(/-/g, ""),
    }).returning({ id: voiceSessions.id });
    return s.id;
  };
  const endCall = (id: string) => db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, id));
  const rows = (conversationId: string) => db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
  const blockedLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("text agent blocked"));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u1a", email: "dana@oneagent.test", firstName: "Dana", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@oneagent.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY, allowSimulatedBuyers: true }).where(eq(sellerAccounts.id, acc));
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await t.close(); });

  describe("a chat turn during a call returns in_call, for every trigger", () => {
    it("runBuyerTurn: no model call, nothing stored or sent, one log line naming the trigger; after the call it answers", async () => {
      const { conversationId } = await addLead();
      const before = (await rows(conversationId)).length;
      const call = await callOn(conversationId, { status: "pending" });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const llm = new ScriptedLlm([]);
      expect(await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "How much for 3 sites?" })).toEqual({ status: "in_call" });
      expect(blockedLines(info).at(-1)).toMatch(/text agent blocked: chat turn$/);
      expect(llm.requests).toHaveLength(0);
      expect(await rows(conversationId)).toHaveLength(before);
      info.mockRestore();
      await endCall(call);
      const after = new ScriptedLlm([() => ({ content: [say("Happy to help. How many sites?")] })]);
      expect(await runBuyerTurn(db, after, { accountId: acc, conversationId, text: "How much for 3 sites?" })).toMatchObject({ status: "replied" });
    });

    it("the reply path (WhatsApp webhook, typed message, after-call): no reply, no delivery, the stored message stays; no error", async () => {
      const { lead, conversationId } = await addLead();
      const call = await callOn(conversationId);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      for (const trigger of ["whatsapp", "typed message", undefined]) {
        const [m] = await db.insert(messages).values({ accountId: acc, conversationId, actor: "buyer", body: "Still there?", language: "en" }).returning();
        const llm = new ScriptedLlm([]);
        const out = await replyToBuyer(db, llm, null, { accountId: acc, conversationId, leadId: lead.id, text: m.body }, trigger ? { trigger } : {});
        expect(out).toEqual({ turn: { status: "in_call" }, delivery: null });
        expect(llm.requests).toHaveLength(0);
        expect(blockedLines(info).at(-1)).toMatch(new RegExp(`text agent blocked: ${trigger ?? "chat reply"}$`));
        expect((await rows(conversationId)).at(-1)).toMatchObject({ id: m.id, actor: "buyer" });
      }
      info.mockRestore();
      await endCall(call);
    });

    it("the test-lab composer: back to the chat with the in_call notice, the message not sent, no model call", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-not-a-key");
      const lab = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
      const call = await callOn(lab.conversationId, { isTest: true });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const slug = (holder.access as { account: { slug: string } }).account.slug;
      const form = new FormData();
      for (const [k, v] of Object.entries({ slug, conversationId: lab.conversationId, text: "Hello?" })) form.set(k, v);
      const url = await redirectOf(sendTestMessageAction(form));
      expect(url).toBe(`/app/${slug}/setup/test-lab?c=${lab.conversationId}&error=in_call`);
      expect(blockedLines(info).at(-1)).toMatch(/text agent blocked: test lab$/);
      expect(await rows(lab.conversationId)).toHaveLength(0);
      info.mockRestore();
      await endCall(call);
      vi.unstubAllEnvs();
    });

    it("the buyer's typed-message route: refused with in_call during a test call on a simulated chat too, and the skip is logged", async () => {
      const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
      const made = await createSimulatedBuyer(db, actor(), account, { fullName: "Rina Cohen", company: "Rina's Shop", language: "en", country: "IL" });
      if (!made.ok) throw new Error("buyer");
      const started = await startSimulatorConversation(db, actor(), acc, made.lead.id);
      if (!started.ok) throw new Error(started.reason);
      const post = () => messagesRoute.POST(
        new Request(`https://app.example.com/chat/${made.token}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello?", clientId: randomUUID() }) }),
        { params: Promise.resolve({ token: made.token }) },
      );
      // A test call (a seller trying the simulated buyer's chat) holds it as a buyer call does.
      const call = await callOn(started.conversationId, { isTest: true });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const refused = await post();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ ok: false, reason: "in_call" });
      expect(blockedLines(info).at(-1)).toMatch(/text agent blocked: typed message$/);
      expect((await rows(started.conversationId)).filter((m) => m.actor === "buyer")).toHaveLength(0);
      info.mockRestore();
      await endCall(call);
      const ok = await post();
      expect(await ok.json()).toEqual({ ok: true });
    });
  });

  describe("follow-ups wait for the call", () => {
    it("a due follow-up is deferred during a call (nothing posted) and sent by the next run after it; the buyer's lines on the call do not cancel it", async () => {
      const { lead, conversationId } = await addLead();
      const now = new Date();
      const due = new Date(now.getTime() + 20 * MIN);
      // Agreed on a call: the call is live while it is scheduled, and the buyer keeps talking after.
      const call = await callOn(conversationId);
      const r = await scheduleFollowUp(db, { accountId: acc, leadId: lead.id, conversationId, language: "en" }, { due_at: due.toISOString(), topic: "the quote", buyer_named_time: false }, now);
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 5));
      await db.insert(messages).values({ accountId: acc, conversationId, actor: "buyer", body: "Great, talk Friday.", language: "en", voiceSessionId: call });
      const agentRows = async () => (await rows(conversationId)).filter((m) => m.actor === "agent").length;
      const posted = await agentRows();
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const during = await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      expect(during.deferred).toBeGreaterThanOrEqual(1);
      const [f] = await db.select().from(followUps).where(eq(followUps.leadId, lead.id));
      expect(f).toMatchObject({ status: "scheduled", reason: null, sentMessageId: null });
      expect(await agentRows()).toBe(posted);
      expect(info.mock.calls.some((c) => String(c[0]).startsWith("[follow-ups] deferred: a call is on the conversation"))).toBe(true);
      info.mockRestore();

      await endCall(call);
      await runDueFollowUps(db, null, new Date(due.getTime() + 2 * MIN));
      const [sent] = await db.select().from(followUps).where(eq(followUps.leadId, lead.id));
      expect(sent.status).toBe("sent");
      expect(await agentRows()).toBe(posted + 1);
    });

    it("a line the buyer wrote in the chat after scheduling still cancels it", async () => {
      const { lead, conversationId } = await addLead();
      const now = new Date();
      const due = new Date(now.getTime() + 20 * MIN);
      expect((await scheduleFollowUp(db, { accountId: acc, leadId: lead.id, conversationId, language: "en" }, { due_at: due.toISOString(), topic: "t", buyer_named_time: false }, now)).ok).toBe(true);
      await new Promise((res) => setTimeout(res, 5));
      await db.insert(messages).values({ accountId: acc, conversationId, actor: "buyer", body: "Actually, one more thing", language: "en" });
      await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      expect((await db.select().from(followUps).where(eq(followUps.leadId, lead.id)))[0]).toMatchObject({ status: "cancelled", reason: "buyer_replied" });
    });

    it("the named-time retry SMS waits during a call and goes on the next run after it", async () => {
      const { lead, conversationId } = await addLead();
      const now = new Date();
      const due = new Date(now.getTime() + 16 * MIN);
      await scheduleFollowUp(db, { accountId: acc, leadId: lead.id, conversationId, language: "en" }, { due_at: due.toISOString(), topic: "t", buyer_named_time: true }, now);
      await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      const sms = async () => (await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id)))).filter((e) => e.type.startsWith("sms.")).map((e) => e.data?.kind);
      expect(await sms()).toEqual(["named_time"]);
      const call = await callOn(conversationId);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const during = await runNamedTimeRetries(db, new Date(Date.now() + 11 * MIN));
      expect(during.sent).toBe(0);
      expect(await sms()).toEqual(["named_time"]);
      expect(info.mock.calls.some((c) => String(c[0]).startsWith("[named-time] retry SMS deferred"))).toBe(true);
      info.mockRestore();
      await endCall(call);
      await runNamedTimeRetries(db, new Date(Date.now() + 12 * MIN));
      expect((await sms()).sort()).toEqual(["named_time", "named_time_retry"]);
    });
  });

  describe("the stage counts only what the agent wrote", () => {
    it("writtenByAgent: agent messages with the agent version that wrote them; not app-written ones, nor other actors", () => {
      expect(writtenByAgent({ actor: "agent", agentVersionId: randomUUID() })).toBe(true);
      expect(writtenByAgent({ actor: "agent", agentVersionId: null })).toBe(false);
      expect(writtenByAgent({ actor: "buyer", agentVersionId: randomUUID() })).toBe(false);
      expect(writtenByAgent({ actor: "human", agentVersionId: null })).toBe(false);
    });

    const stageOf = (llm: InstanceType<typeof ScriptedLlm>) => /## Stage now: ([^\n]+)/.exec(JSON.stringify(llm.requests[0].system).replace(/\\n/g, "\n"))?.[1];

    it("app-written messages (a follow-up, a booking card) do not open the conversation's stage; the agent's own reply and the fixed opener do", async () => {
      const lab = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
      // Only app-written agent messages so far: still Open.
      await db.insert(messages).values([
        { accountId: acc, conversationId: lab.conversationId, actor: "agent", body: "Hi Dana, you asked me to get back to you. Is now a good time?", language: "en", createdAt: new Date(Date.now() - 3 * MIN) },
        { accountId: acc, conversationId: lab.conversationId, actor: "agent", body: "Pick a time for a call with our team.", language: "en", createdAt: new Date(Date.now() - 2 * MIN) },
      ]);
      const first = new ScriptedLlm([() => ({ content: [say("Hello! What kind of business is it?")] })]);
      expect((await runBuyerTurn(db, first, { accountId: acc, conversationId: lab.conversationId, text: "Hi" })).status).toBe("replied");
      expect(stageOf(first)).toBe("1 Open");
      // The agent's own reply counts: Understand.
      const second = new ScriptedLlm([() => ({ content: [say("Got it.")] })]);
      await runBuyerTurn(db, second, { accountId: acc, conversationId: lab.conversationId, text: "A cafe" });
      expect(stageOf(second)).toBe("2 Understand");

      // The fixed opener (written with the agent version) counts as before.
      const { conversationId } = await addLead();
      expect((await rows(conversationId))[0]).toMatchObject({ actor: "agent" });
      expect((await rows(conversationId))[0].agentVersionId).not.toBeNull();
      const third = new ScriptedLlm([() => ({ content: [say("Thanks!")] })]);
      await runBuyerTurn(db, third, { accountId: acc, conversationId, text: "Hi" });
      expect(stageOf(third)).toBe("2 Understand");
    });
  });
});
