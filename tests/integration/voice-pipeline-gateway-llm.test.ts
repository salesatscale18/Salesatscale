/**
 * The real chat turn (runBuyerTurn, unchanged) on GatewayLlm, the voice pipeline's gateway LlmClient,
 * backed by a scripted fake language model (MockLanguageModelV4: no network, no cost).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { dealStates, messages, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { startTestConversation } from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { GatewayLlm, PIPELINE_TEXT_MODEL } from "@/lib/voice-pipeline/gateway-llm";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const usage = { inputTokens: { total: 1000, noCache: 400, cacheRead: 600, cacheWrite: undefined }, outputTokens: { total: 30, text: 30, reasoning: undefined } };
const result = (content: LanguageModelV4Content[], unified: LanguageModelV4GenerateResult["finishReason"]["unified"]): LanguageModelV4GenerateResult =>
  ({ content, finishReason: { unified, raw: undefined }, usage, warnings: [] });
const call = (id: string, name: string, input: unknown): LanguageModelV4Content => ({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) });

describe("chat turn on GatewayLlm (scripted gateway model)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "polar@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
    ], []);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
  });
  afterAll(async () => t.close());

  it("update_deal_state, then search_catalog, then the answer: stored like a normal chat turn", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const model = new MockLanguageModelV4({
      provider: "gateway", modelId: PIPELINE_TEXT_MODEL,
      doGenerate: [
        result([
          { type: "text", text: "Noting that." },
          call("g1", "update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: "recommend", objection: null }),
        ], "tool-calls"),
        result([call("g2", "search_catalog", { query: "fridge sensor" })], "tool-calls"),
        result([{ type: "text", text: "For 2 kitchens you need the wireless fridge sensor and one site gateway per kitchen." }], "stop"),
      ],
    });
    const r = await runBuyerTurn(db, new GatewayLlm({ model }), { accountId: acc, conversationId: c.conversationId, text: "We run 2 restaurant kitchens. What do I need?" });
    expect(r).toMatchObject({ status: "replied", calls: 2, text: "For 2 kitchens you need the wireless fridge sensor and one site gateway per kitchen." });

    // Three model calls; every later one carries the earlier calls and their results, in order.
    const prompts = model.doGenerateCalls.map((o) => (o as LanguageModelV4CallOptions).prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.map((p) => p.map((m) => m.role))).toEqual([
      ["system", "user"],
      ["system", "user", "assistant", "tool"],
      ["system", "user", "assistant", "tool", "assistant", "tool"],
    ]);
    // The same system text every round (implicit caching needs a stable prefix).
    expect(new Set(prompts.map((p) => JSON.stringify(p[0]))).size).toBe(1);
    const last = prompts[2];
    expect(last[2]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Noting that." }, { type: "tool-call", toolCallId: "g1", toolName: "update_deal_state" }] });
    expect(last[3]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "g1", toolName: "update_deal_state", output: { type: "json" } }] });
    expect(last[5]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "g2", toolName: "search_catalog", output: { type: "json" } }] });

    // Rows: the agent's reply with summed usage under the gateway model id, and both tool calls linked to it.
    const [agentMsg] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent"), isNotNull(messages.usage)));
    expect(r.status === "replied" && r.messageId).toBe(agentMsg.id);
    expect(agentMsg.body).toBe(r.status === "replied" ? r.text : "");
    expect(agentMsg.usage).toMatchObject({ inputTokens: 1200, outputTokens: 90, cacheReadTokens: 1800, cacheWriteTokens: 0, model: PIPELINE_TEXT_MODEL });
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.messageId, agentMsg.id));
    expect(calls.sort((a, b) => a.sequence - b.sequence).map((x) => [x.sequence, x.name, x.outcome])).toEqual([[1, "update_deal_state", "ok"], [2, "search_catalog", "ok"]]);
    const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
    expect(JSON.stringify(deal)).toContain("Restaurant");
    // No system "could not reply" message.
    expect(await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "system")))).toHaveLength(0);
  });

  it("a gateway 402 on the first call ends the turn on the normal error path, without crashing", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw Object.assign(new Error("Insufficient funds"), { statusCode: 402, type: "insufficient_funds" }); } });
    const r = await runBuyerTurn(db, new GatewayLlm({ model, maxRetries: 0 }), { accountId: acc, conversationId: c.conversationId, text: "Hello?" });
    expect(r).toEqual({ status: "error", error: "GatewayLlmError" });
    const sys = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "system")));
    expect(sys.map((m) => m.body)).toEqual(["The agent could not reply (model error). Try again."]);
  });
});
