/**
 * The reply figure check in a text-chat turn (owner decisions of 23 Nov), with
 * a scripted model: one regeneration with the system note; a second failure
 * removes the sentences, or hands off with the draft when nothing is left.
 * The step is logged as a reply_figures call either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, leadEvents, messages, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const say = (text: string) => () => ({ content: [{ type: "text", text } as Block] });
const use = (id: string, name: string, input: unknown) => () => ({ content: [{ type: "tool_use", id, name, input } as Block] });
const lastUserText = (req: LlmRequest) => {
  const m = req.messages.at(-1)!;
  if (typeof m.content === "string") return m.content;
  return (m.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
};

describe("reply figure check (text chat)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "polar@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id });
    const d = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...d.playbook, fields: [], exceptions: [{ id: "exc1", text: "Free installation from 3 sites", approvedAt: "2026-11-20T10:00:00Z", approvedBy: null }],
      plays: { price_early: { facts: [{ text: "A sensor is 590 ILS before VAT, or 550 ILS each from 10.", source: "Price list" }] } } });
  });
  afterAll(async () => t.close());

  const conv = async () => (await startTestConversation(db, acc, me.id, { language: "en" }))!;
  const figureRows = async (conversationId: string) => db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.name, "reply_figures")));

  it("a figure no tool gave: the model writes the reply again once, with the note; a good rewrite is sent", async () => {
    const c = await conv();
    const llm = new ScriptedLlm([say("It comes to ₪7,000 for everything. Shall I prepare the quote?"), say("I'll work out the exact total with the quote. How many fridges do you have?")]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "How much for my fridges?" });
    expect(r).toMatchObject({ status: "replied", text: "I'll work out the exact total with the quote. How many fridges do you have?" });
    expect(llm.requests).toHaveLength(2);
    expect(lastUserText(llm.requests[1])).toMatch(/^\[Check from the system, not from the buyer\] Your reply states 7,000/);
    // Same tools and the same strict mode on the second request.
    expect(llm.requests[1].tools).toEqual(llm.requests[0].tools);
    const rows = await figureRows(c.conversationId);
    expect(rows).toMatchObject([{ outcome: "refused", rule: "Figures not from a tool", input: { figures: ["7,000"] } }]);
  });

  it("figures from this turn's tools and the buyer's own numbers pass without a second call", async () => {
    const c = await conv();
    const llm = new ScriptedLlm([
      use("t0", "update_deal_state", { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: true, asked: null }),
      use("t1", "search_catalog", { query: "sensor" }),
      say("A sensor is ₪590 before VAT, so your budget of 3,000 covers a first set. How many fridges?"),
    ]);
    await db.update(conversations).set({ status: "open" }).where(eq(conversations.id, c.conversationId));
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "We have a budget of 3,000. What is the price of a sensor?" });
    expect(r.status).toBe("replied");
    expect(llm.requests).toHaveLength(3);
    expect(await figureRows(c.conversationId)).toEqual([]);
  });

  it("figures from the seller's approved play facts pass with no tool call; a figure from nowhere still fails", async () => {
    const c = await conv();
    const ok = new ScriptedLlm([say("It starts from ₪590 per sensor, or ₪550 each from 10. How many fridges do you have?")]);
    expect(await runBuyerTurn(db, ok, { accountId: acc, conversationId: c.conversationId, text: "How much is a sensor?" })).toMatchObject({ status: "replied" });
    expect(ok.requests).toHaveLength(1);
    const c2 = await conv();
    const bad = new ScriptedLlm([say("It starts from ₪575 per sensor."), say("How many fridges do you have?")]);
    await runBuyerTurn(db, bad, { accountId: acc, conversationId: c2.conversationId, text: "How much is a sensor?" });
    expect(bad.requests).toHaveLength(2);
    expect(lastUserText(bad.requests[1])).toMatch(/Your reply states 575/);
  });

  it("failing twice: the sentences with unverified figures are removed, and the step is logged", async () => {
    const c = await conv();
    const llm = new ScriptedLlm([say("It is ₪7,000. Shall I prepare it?"), say("Great. It is about ₪7,500 in total. Shall I prepare it?")]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Price?" });
    expect(r).toMatchObject({ status: "replied", text: "Great. Shall I prepare it?" });
    const rows = await figureRows(c.conversationId);
    expect(rows.map((x) => [x.outcome, x.result.removed ?? x.result.rewritten])).toEqual([["refused", true], ["failed", true]]);
  });

  it("a quote held for approval: the totals of this turn's pricing may not be stated; the order form is refused", async () => {
    const c = await conv();
    const lines = [{ sku: "SNS-200", qty: 2 }];
    const llm = new ScriptedLlm([
      use("t0", "update_deal_state", { updates: [], next_step: null, objection: null, recommendation_confirmed: true, price_asked: true, asked: null }),
      use("t1", "check_fit", { lines, sites: null }),
      use("t2", "create_quote", { lines, discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: "exc1", headline: null, assumed: null }),
      // The real call of 23 Nov: the check_fit total stated although the quote waits for approval.
      say("The total for your setup today is ₪1,392.40. Shall I send the order form?"),
      say("I've asked the team to approve it, and I'll let you know here. Anything else I can help with?"),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Sounds right, send it." });
    expect(r).toMatchObject({ status: "replied", text: "I've asked the team to approve it, and I'll let you know here. Anything else I can help with?" });
    expect(lastUserText(llm.requests[4])).toMatch(/Your reply states 1,392\.40, but the quote waits for the team's approval: no total or price for it may be given yet\./);
    const [held] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, c.conversationId), eq(toolCalls.name, "create_quote")));
    expect(held.result.status).toBe("awaiting_seller_approval");
    // The order form for the held quote is refused (send_order_form).
    const { runTool } = await import("@/lib/agent/tools");
    const pb = (await ensureDraftVersion(db, acc)).playbook;
    const form = await runTool("send_order_form", { quote: String(held.result.quote).split(" ")[0] }, { db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: pb, currency: "ILS", callId: "of-1", language: "en" });
    expect(form).toMatchObject({ outcome: "refused", rule: "Quote waits for the seller's approval or was cancelled" });
  });

  it("a held quote's lines are data for the agent; their prices are withheld like its totals", async () => {
    const c = await conv();
    const lines = [{ sku: "SNS-200", qty: 2 }];
    const llm = new ScriptedLlm([
      use("t0", "update_deal_state", { updates: [], next_step: null, objection: null, recommendation_confirmed: true, price_asked: true, asked: null }),
      use("t1", "create_quote", { lines, discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: "exc1", headline: null, assumed: null }),
      say("The sensors come to ₪1,180.00 before VAT. Shall I send the order form?"),
      say("I've asked the team to approve it, and I'll let you know here."),
    ]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Sounds right, send it." });
    const [held] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, c.conversationId), eq(toolCalls.name, "create_quote")));
    expect(held.result).toMatchObject({ status: "awaiting_seller_approval", lines: [{ sku: "SNS-200", name: "Wireless fridge sensor", qty: 2, charge: "one-time", total_before_vat: "₪1,180.00" }] });
    expect(lastUserText(llm.requests[3])).toMatch(/Your reply states 1,180\.00, but the quote waits for the team's approval/);
  });

  it("failing twice with nothing left: a person takes over with the draft as the suggested reply", async () => {
    const c = await conv();
    const llm = new ScriptedLlm([say("₪7,000."), say("₪7,200.")]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Price?" });
    expect(r.status).toBe("replied");
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    expect(cv.status).toBe("human");
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "handoff.requested")));
    expect(ev.data).toMatchObject({ reason: "Reply figures could not be verified", suggestedReply: "₪7,200." });
    const sent = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent")));
    expect(sent.some((m) => m.body.includes("7,200"))).toBe(false);
    expect((await figureRows(c.conversationId)).at(-1)!.result).toMatchObject({ handedOff: true });
  });
});
