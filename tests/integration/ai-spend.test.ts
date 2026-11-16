import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { auditLog, channelConnections, consentRecords, conversations, leads, messages, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block, type LlmResponse } from "@/lib/agent/llm";
import { ensureDraftVersion, publishDraftVersion, startTestConversation } from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { addConnection, addTemplate, refreshTemplateStatuses, setTesterNumbers } from "@/lib/channels/connections";
import { receiveInbound, startWhatsAppConversation } from "@/lib/channels/whatsapp";
import type { ContentInfo, SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { aiUsageThisMonth, platformBudget, platformUsageThisMonth, spendState } from "@/lib/ai/usage";
import { CHECK_ACTION, checkModels, lastModelsCheck, runModelsCheck, type ModelsClient } from "@/lib/ai/availability";
import { createTestDb, type TestDb } from "../helpers/db";

const sid = (prefix = "SM") => `${prefix}${randomBytes(16).toString("hex")}`;
const say = (text: string): Block => ({ type: "text", text });

class FakeTwilio implements TwilioTransport {
  sent: SendRequest[] = [];
  contents = new Map<string, ContentInfo>();
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return { ok: true, sid: sid(), status: "queued" };
  }
  async fetchContent(contentSid: string) {
    return this.contents.get(contentSid) ?? null;
  }
}

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const SENDER = "+14155238801";
const TESTER = "+972509990077";
const HX = `HX${"c".repeat(32)}`;
const OPUS = "claude-opus-5-5";

describe("AI usage, spend cap and platform budget", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const tw = new FakeTwilio();
  const actor = () => ({ userId: me.id, actingAs: false });

  /** Seeds one agent message with usage in a test chat of the account. */
  const seed = async (accountId: string, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; model?: string }, createdAt?: Date) => {
    const c = await startTestConversation(db, accountId, null, { language: "en" });
    await db.insert(messages).values({
      accountId, conversationId: c!.conversationId, actor: "agent", body: "seed", language: "en",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: OPUS, ...usage },
      ...(createdAt ? { createdAt } : {}),
    });
  };
  const clearUsage = async (accountId: string) => db.delete(messages).where(and(eq(messages.accountId, accountId), eq(messages.body, "seed")));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-ai", email: "ai@p.test", firstName: "Ada", role: "super_admin" }).returning();
    const mk = async (name: string, currency: string, cap: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency, plan: "pilot", monthlySpendCap: cap, ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    // Cap $100: easy numbers (USD rate 1).
    acc = await mk("Spendy", "USD", "100");
    other = await mk("Thrifty", "ILS", "100");
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY, status: "live" }).where(eq(sellerAccounts.id, acc));
    await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: SENDER, displayName: "Spendy", messagingServiceSid: "", marketId: null });
    tw.contents.set(HX, { sid: HX, name: "opener_en", language: "en", body: "Hi {{1}}", approval: { status: "approved", category: "MARKETING", rejectionReason: null } });
    await addTemplate(db, tw, actor(), acc, { contentSid: HX, purpose: "opener" });
    await refreshTemplateStatuses(db, tw, acc);
  });
  afterAll(async () => t.close());
  afterEach(() => {
    delete process.env.AI_PLATFORM_MONTHLY_BUDGET_USD;
  });

  const addLead = async (phone: string) => {
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Rina Cohen", phone, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "I agree", source: "Form", capturedAt: new Date() });
    return lead;
  };

  it("rolls up this month's tokens by type and the cost, per account, leaving out last month", async () => {
    await seed(acc, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 });
    await seed(acc, { outputTokens: 50_000, model: "claude-haiku-5-5" });
    await seed(acc, { inputTokens: 5, model: "scripted" });
    await seed(acc, { outputTokens: 9_000_000 }, new Date(Date.UTC(2020, 0, 15)));
    await seed(other, { outputTokens: 1_000_000 });

    const u = await aiUsageThisMonth(db, acc);
    expect(u.tokens).toEqual({ inputTokens: 1_000_005, outputTokens: 150_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 });
    // Opus: 4 + 2 + 0.2 + 1 = $7.20; Haiku: 50k x $0.50/M = $0.025.
    expect(u.costMicros).toBe(7_225_000);
    expect(u.byModel.map((m) => m.model)).toEqual([OPUS, "claude-haiku-5-5", "scripted"]);
    expect(u.unpricedModels).toEqual(["scripted"]);
    // Isolation: the other account sees only its own usage; the platform sees both.
    expect((await aiUsageThisMonth(db, other)).costMicros).toBe(20_000_000);
    expect((await platformUsageThisMonth(db)).costMicros).toBe(27_225_000);
    await clearUsage(acc);
    await clearUsage(other);
  });

  it("spendState: ok under 80%, warn from 80%, capped from 100%, converted to the account currency", async () => {
    expect(await spendState(db, acc)).toMatchObject({ state: "ok", costMinor: 0, capMinor: 10_000, currency: "USD" });
    await seed(acc, { outputTokens: 3_950_000 }); // $79
    expect((await spendState(db, acc))?.state).toBe("ok");
    await seed(acc, { outputTokens: 50_000 }); // $80
    expect(await spendState(db, acc)).toMatchObject({ state: "warn", costMinor: 8_000 });
    await seed(acc, { outputTokens: 1_000_000 }); // $100
    expect((await spendState(db, acc))?.state).toBe("capped");
    // ILS: $20 = 7,400 agorot of a 10,000 cap.
    await seed(other, { outputTokens: 1_000_000 });
    expect(await spendState(db, other)).toMatchObject({ state: "ok", costMinor: 7_400, currency: "ILS" });
    // No exchange rate: the cap cannot be compared, so nothing is refused (and the UI says so).
    await db.update(sellerAccounts).set({ currency: "CHF" }).where(eq(sellerAccounts.id, other));
    expect(await spendState(db, other)).toMatchObject({ state: "ok", costMinor: null });
    await db.update(sellerAccounts).set({ currency: "ILS" }).where(eq(sellerAccounts.id, other));
    await clearUsage(other);
    expect(await spendState(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("at the cap: no new WhatsApp opener and no new test chats, but open conversations keep replying", async () => {
    expect((await spendState(db, acc))?.state).toBe("capped");
    const lead = await addLead("+972501119001");
    expect(await startWhatsAppConversation(db, tw, actor(), acc, lead.id)).toMatchObject({ ok: false, reason: "spend_cap" });

    // A new chat from a tester's phone is refused; nothing is stored.
    const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.senderNumber, SENDER));
    await setTesterNumbers(db, actor(), { id: acc, market: "IL" }, conn.id, TESTER);
    const params = { From: `whatsapp:${TESTER}`, To: `whatsapp:${SENDER}`, MessageSid: sid(), Body: "hi", NumMedia: "0" };
    expect(await receiveInbound(db, params)).toEqual({ kind: "ignored", reason: "spend_cap" });
    expect(await db.select().from(conversations).where(eq(conversations.channelAddress, TESTER))).toHaveLength(0);

    // Under the cap the opener goes out and the tester chat starts.
    await clearUsage(acc);
    expect(await startWhatsAppConversation(db, tw, actor(), acc, lead.id)).toMatchObject({ ok: true });
    const tester = await receiveInbound(db, { ...params, MessageSid: sid() });
    expect(tester).toMatchObject({ kind: "stored" });

    // Back at the cap: the open tester chat and the open lead chat still get replies.
    await seed(acc, { outputTokens: 5_000_000 });
    expect((await spendState(db, acc))?.state).toBe("capped");
    const again = await receiveInbound(db, { ...params, MessageSid: sid() });
    expect(again).toMatchObject({ kind: "stored" });
    if (again.kind !== "stored") throw new Error();
    const r1 = await runBuyerTurn(db, new ScriptedLlm([() => ({ content: [say("Still here")] })]), { accountId: acc, conversationId: again.conversationId, text: "hi", buyerMessageStored: true });
    expect(r1).toMatchObject({ status: "replied", text: "Still here" });
    const [leadConv] = await db.select().from(conversations).where(and(eq(conversations.leadId, lead.id), eq(conversations.channel, "whatsapp")));
    const r2 = await runBuyerTurn(db, new ScriptedLlm([() => ({ content: [say("Happy to help")] })]), { accountId: acc, conversationId: leadConv.id, text: "Tell me more" });
    expect(r2).toMatchObject({ status: "replied" });
    await clearUsage(acc);
  });

  it("stores cache-write tokens with the turn's usage, so they are priced", async () => {
    const c = await startTestConversation(db, acc, null, { language: "en" });
    const res = (over: Partial<LlmResponse>) => () => ({ content: [say("ok")], model: OPUS, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 1_000 }, ...over });
    const r = await runBuyerTurn(db, new ScriptedLlm([res({})]), { accountId: acc, conversationId: c!.conversationId, text: "hello" });
    if (r.status !== "replied") throw new Error(r.status);
    const [m] = await db.select().from(messages).where(eq(messages.id, r.messageId));
    expect(m.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 1_000, model: OPUS });
    expect((await aiUsageThisMonth(db, acc)).tokens.cacheWriteTokens).toBeGreaterThanOrEqual(1_000);
  });

  it("platform budget: at or over it the model is never called and a person takes over", async () => {
    const c = await startTestConversation(db, other, null, { language: "en" });
    await seed(other, { outputTokens: 100_000 }); // $2 platform-wide (plus earlier rows)
    const used = (await platformUsageThisMonth(db)).costMicros;
    process.env.AI_PLATFORM_MONTHLY_BUDGET_USD = String(used / 1e6); // exactly at the budget
    expect(await platformBudget(db)).toMatchObject({ exceeded: true, usedMicros: used });

    const llm = new ScriptedLlm([() => ({ content: [say("should not be sent")] })]);
    const r = await runBuyerTurn(db, llm, { accountId: other, conversationId: c!.conversationId, text: "Hello?" });
    expect(r).toEqual({ status: "human" });
    expect(llm.requests).toHaveLength(0);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c!.conversationId));
    expect(conv.status).toBe("human");
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, c!.conversationId));
    expect(msgs.filter((m) => m.actor === "agent")).toHaveLength(0);
    expect(msgs.find((m) => m.actor === "system")?.body).toContain("monthly AI budget");

    // Raised above usage: calls go through again.
    process.env.AI_PLATFORM_MONTHLY_BUDGET_USD = String(used / 1e6 + 1);
    const c2 = await startTestConversation(db, other, null, { language: "en" });
    const ok = await runBuyerTurn(db, new ScriptedLlm([() => ({ content: [say("Hi!")] })]), { accountId: other, conversationId: c2!.conversationId, text: "Hello?" });
    expect(ok).toMatchObject({ status: "replied", text: "Hi!" });
    // Unset: no guard at all.
    delete process.env.AI_PLATFORM_MONTHLY_BUDGET_USD;
    expect(await platformBudget(db)).toEqual({ budgetMicros: null, usedMicros: 0, exceeded: false });
    await clearUsage(other);
  });

  it("checks model availability with the Models API (mocked), caches it 10 minutes and audits each real check", async () => {
    const calls: string[] = [];
    const fake: ModelsClient = {
      models: {
        retrieve: (async (id: string) => {
          calls.push(id);
          if (id === "claude-haiku-5-5") throw new Anthropic.NotFoundError(404, { type: "error" }, "not found", new Headers());
          return { id, type: "model", display_name: `Name of ${id}`, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 };
        }) as unknown as ModelsClient["models"]["retrieve"],
      },
    };
    const results = await checkModels(fake);
    expect(results).toEqual([
      { role: "agent", model: OPUS, available: true, displayName: `Name of ${OPUS}`, contextWindow: 1_000_000, maxOutput: 128_000, error: null },
      expect.objectContaining({ role: "pipeline", model: "claude-sonnet-5-5", available: true }),
      { role: "pipeline_light", model: "claude-haiku-5-5", available: false, displayName: null, contextWindow: null, maxOutput: null, error: "Model not found for this API key" },
    ]);

    calls.length = 0;
    expect(await lastModelsCheck(db)).toBeNull();
    const first = await runModelsCheck(db, fake, me.id);
    expect(first.cached).toBe(false);
    expect(calls).toHaveLength(3);
    const second = await runModelsCheck(db, fake, me.id);
    expect(second).toMatchObject({ cached: true, results: first.results });
    expect(calls).toHaveLength(3);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, CHECK_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ accountId: null, actorUserId: me.id });
    expect((await lastModelsCheck(db))?.results).toEqual(first.results);

    // Older than 10 minutes: checked again.
    await db.update(auditLog).set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(auditLog.action, CHECK_ACTION));
    expect((await runModelsCheck(db, fake, me.id)).cached).toBe(false);
    expect(calls).toHaveLength(6);
  });
});
