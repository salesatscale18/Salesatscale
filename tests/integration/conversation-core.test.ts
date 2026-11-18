/**
 * Conversation core (P11) against the database: the reserved facts recorded by
 * update_deal_state, the stage facts read from quotes, order forms and orders,
 * the stage in the per-turn context, and the fixed opener. Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { messages, orderForms, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { PRICE_ASKED_KEY, pricesAllowed, RECOMMENDATION_CONFIRMED_KEY } from "@/lib/agent/core/facts";
import { loadStageFacts } from "@/lib/agent/core/stage-facts";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import { ensureDraftVersion, getDealState, publishDraftVersion, readDealState, saveDraftPlaybook, startTestConversation, verifyField } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { saveLegalSection } from "@/lib/orders/settings";
import { createSimulatedBuyer, receiveSimulatorInbound, resolveChatToken, startSimulatorConversation } from "@/lib/simulator/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

describe("conversation core (scripted model)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  const actor = () => ({ userId: me.id, actingAs: false });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      agentName: "Maya",
      opener: { leadsAskAbout: "monitoring your fridge temperatures", openingQuestion: "How do you check them today?" },
    });
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
  });
  afterAll(async () => t.close());

  const toolCtx = async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const ctx = (callId: string, agentMessages?: number): ToolContext => ({
      db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: c.version.playbook, currency: "ILS", callId, agentMessages,
    });
    return { c, ctx };
  };
  const none = { updates: [], next_step: null, objection: null };
  const qualify = { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }, { key: "decision_maker", value: "Owner", provenance: "buyer" }], next_step: null, objection: null };

  it("update_deal_state records the two reserved facts as said by the buyer, and returns the stage as it is now", async () => {
    const { c, ctx } = await toolCtx();
    // The buyer asks the price early: prices are allowed, the stage skips ahead.
    const asked = await runTool("update_deal_state", { ...none, recommendation_confirmed: null, price_asked: true }, ctx("f1"));
    expect(asked).toMatchObject({ outcome: "ok", result: { ok: true, saved: [], recorded: ["price_asked"], still_needed_before_quote: ["Business type", "Number of sites"] } });
    expect(asked.result.stage).toContain("## Stage now: 2 Understand");
    expect(asked.result.stage).toContain("The buyer asked the price, so skip ahead.");
    let deal = (await readDealState(db, acc, c.leadId))!;
    expect(deal.fields[PRICE_ASKED_KEY]).toMatchObject({ value: "yes", provenance: "buyer" });
    expect(deal.fields[RECOMMENDATION_CONFIRMED_KEY]).toBeUndefined();
    expect(pricesAllowed(deal.fields)).toBe(true);

    // The buyer confirms the recommendation, in the same call as the fields.
    const confirmed = await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: null }, ctx("f2", 3));
    expect(confirmed.result).toMatchObject({ saved: ["business_type", "sites", "decision_maker"], recorded: ["recommendation_confirmed"], still_needed_before_quote: [] });
    expect(confirmed.result.stage).toContain("## Stage now: 4 Quote and close");
    expect(confirmed.result).not.toHaveProperty("still_needed_before_order_form");
    deal = (await readDealState(db, acc, c.leadId))!;
    expect(deal.fields[RECOMMENDATION_CONFIRMED_KEY]).toMatchObject({ value: "yes", provenance: "buyer" });
    expect(deal.fields[PRICE_ASKED_KEY]).toMatchObject({ value: "yes" });

    // "It does not fit": the fact is taken back.
    await runTool("update_deal_state", { ...none, recommendation_confirmed: false, price_asked: null }, ctx("f3"));
    deal = (await readDealState(db, acc, c.leadId))!;
    expect(deal.fields[RECOMMENDATION_CONFIRMED_KEY]).toMatchObject({ value: "no", provenance: "buyer" });

    // null (and a call without the two inputs) changes nothing.
    await runTool("update_deal_state", { ...none, recommendation_confirmed: null, price_asked: null }, ctx("f4"));
    await runTool("update_deal_state", none, ctx("f5"));
    deal = (await readDealState(db, acc, c.leadId))!;
    expect(deal.fields[RECOMMENDATION_CONFIRMED_KEY]).toMatchObject({ value: "no" });
    expect(deal.fields[PRICE_ASKED_KEY]).toMatchObject({ value: "yes" });
  });

  it("reserved keys cannot be written as fields or edited by a person, and never show as fields", async () => {
    const { c, ctx } = await toolCtx();
    const r = await runTool("update_deal_state", { updates: [{ key: RECOMMENDATION_CONFIRMED_KEY, value: "yes", provenance: "inferred" }], next_step: null, objection: null }, ctx("r1"));
    expect(r).toMatchObject({ outcome: "refused", rule: "Unknown deal-state fields", result: { unknown: [RECOMMENDATION_CONFIRMED_KEY] } });
    expect(r.result.valid_keys).toEqual(["business_type", "sites", "decision_maker"]);
    expect((await readDealState(db, acc, c.leadId))?.fields?.[RECOMMENDATION_CONFIRMED_KEY]).toBeUndefined();
    expect(await verifyField(db, actor(), acc, c.leadId, PRICE_ASKED_KEY, "yes")).toBe(false);

    await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: true }, ctx("r2"));
    const deal = (await getDealState(db, acc, c.leadId))!;
    // Deal-state lists in the app are built from the playbook's fields: no reserved key is among them.
    const shown = c.version.playbook.fields.map((f) => ({ key: f.key, value: deal.fields[f.key]?.value }));
    expect(shown.map((f) => f.key)).toEqual(["business_type", "sites", "decision_maker"]);
    expect(Object.keys(deal.fields).filter((k) => k.startsWith("_")).sort()).toEqual([PRICE_ASKED_KEY, RECOMMENDATION_CONFIRMED_KEY]);
    // The next turn's context names the stage and hides the facts.
    const llm = new ScriptedLlm([step(say("One moment."))]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "yes, sounds right" });
    const context = llm.requests[0].system[1];
    expect(context).toContain("## Stage now: 4 Quote and close");
    expect(context).toContain("- Business type: Cafe (buyer)");
    expect(context).not.toContain("_recommendation_confirmed");
    expect(context).not.toContain("_price_asked");
  });

  it("reads the stage facts from the quote, the order form and the order; a new quote after the form steps back to the close", async () => {
    const { c, ctx } = await toolCtx();
    expect(await loadStageFacts(db, acc, c.leadId)).toEqual({ quote: "none", orderForm: "none", signed: false, paid: false });
    await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: null }, ctx("s1"));
    const q1 = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, ctx("s2"));
    expect(q1.outcome).toBe("ok");
    expect(await loadStageFacts(db, acc, c.leadId)).toMatchObject({ quote: "ready", orderForm: "none" });
    // With a quote, the stage returned by update_deal_state is the order form.
    expect((await runTool("update_deal_state", none, ctx("s3", 4))).result.stage).toContain("## Stage now: 5 Order form");

    const form = await runTool("send_order_form", { quote: String(q1.result.quote).split(" ")[0] }, ctx("s4"));
    expect(form.outcome).toBe("ok");
    expect(await loadStageFacts(db, acc, c.leadId)).toMatchObject({ quote: "ready", orderForm: "sent", signed: false, paid: false });
    expect((await runTool("update_deal_state", none, ctx("s5", 5))).result.stage).toContain("## Stage now: 6 After");

    // The need changes: a new quote. The form on file is for the old one, so the agent closes again.
    const q2 = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, ctx("s6"));
    expect(q2.outcome).toBe("ok");
    expect(await loadStageFacts(db, acc, c.leadId)).toMatchObject({ quote: "ready", orderForm: "outdated" });
    const back = (await runTool("update_deal_state", none, ctx("s7", 6))).result.stage as string;
    expect(back).toContain("## Stage now: 5 Order form");
    expect(back).toContain("the order form sent before was for the old one");

    // An expired link counts as no form.
    await db.update(orderForms).set({ status: "link_expired" }).where(eq(orderForms.leadId, c.leadId));
    expect(await loadStageFacts(db, acc, c.leadId)).toMatchObject({ orderForm: "none" });
    // Another lead's quote is not this lead's.
    const { c: other } = await toolCtx();
    expect(await loadStageFacts(db, acc, other.leadId)).toEqual({ quote: "none", orderForm: "none", signed: false, paid: false });
  });

  it("a quote above the discount limit waits for approval: the stage does not close", async () => {
    const { c, ctx } = await toolCtx();
    await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: null }, ctx("a1"));
    const q = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 30, sites: 1, remove_auto_added: null, exception: null }, ctx("a2"));
    expect(q.result).toMatchObject({ status: "awaiting_seller_approval" });
    expect(await loadStageFacts(db, acc, c.leadId)).toMatchObject({ quote: "awaiting_approval" });
    const stage = (await runTool("update_deal_state", none, ctx("a3", 4))).result.stage as string;
    expect(stage).toContain("## Stage now: 4 Quote and close");
    expect(stage).toContain("waits for the seller's approval");
  });

  it("test lab: the first turn is stage Open; the stable block is the same in every round and every turn", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const first = new ScriptedLlm([
      step(use("t1", "update_deal_state", { updates: [{ key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null })),
      step(say("Hi, I'm Maya, the automated assistant of Polar. What kind of kitchen is it?")),
    ]);
    await runBuyerTurn(db, first, { accountId: acc, conversationId: c.conversationId, text: "hi, we have one kitchen" });
    expect(first.requests[0].system[1]).toContain("## Stage now: 1 Open");
    expect(first.requests[0].system[1]).not.toContain("Your opening message");
    // Both system blocks are fixed for the turn; the new stage reaches the model in the tool result.
    expect(first.requests[1].system).toEqual(first.requests[0].system);
    const result = JSON.parse(((first.requests[1].messages.at(-1)!.content as { content: string }[])[0]).content);
    expect(result.stage).toContain("## Stage now: 1 Open");
    expect(result.stage).toContain("Still missing for a quote: Business type.");

    const second = new ScriptedLlm([step(say("Got it."))]);
    await runBuyerTurn(db, second, { accountId: acc, conversationId: c.conversationId, text: "a cafe" });
    expect(second.requests[0].system[1]).toContain("## Stage now: 2 Understand");
    expect(second.requests[0].system[1]).toContain("- Number of sites: 1 (buyer)");
    // Byte-stable across turns, so the cached prefix is reused.
    expect(second.requests[0].system[0]).toBe(first.requests[0].system[0]);
    expect(second.requests[0].system[0]).toBe(stableSystemPrompt(c.version.playbook, { tradeName: "Polar", currency: "ILS", languages: ["en", "he"] }));
  });

  it("simulator: the fixed opener uses the playbook's opener inputs, and the agent is told it was its own first message", async () => {
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const buyer = await createSimulatedBuyer(db, actor(), account, { fullName: "Rina Cohen", company: "Burger Lab", language: "en", country: "IL" });
    if (!buyer.ok) throw new Error(JSON.stringify(buyer.errors));
    const started = await startSimulatorConversation(db, actor(), acc, buyer.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const [opener] = await db.select().from(messages).where(eq(messages.id, started.messageId));
    const text = "Hi Rina, this is Maya, the automated assistant of Polar. You asked about monitoring your fridge temperatures. How do you check them today?";
    expect(opener).toMatchObject({ actor: "agent", body: text, templateId: null });

    const chat = await resolveChatToken(db, buyer.token);
    if (!chat) throw new Error("token did not resolve");
    const inbound = await receiveSimulatorInbound(db, chat, "i use temp devices connected to my local station", randomUUID());
    if (inbound.kind !== "stored") throw new Error(inbound.kind);
    const llm = new ScriptedLlm([step(say("That covers you while someone is near the station. How many fridges do you want covered?"))]);
    const out = await replyToBuyer(db, llm, null, inbound);
    expect(out.turn.status).toBe("replied");
    const [stable, context] = llm.requests[0].system;
    // The opener is not in the history the model sees (history starts with the buyer); the context carries it.
    expect(llm.requests[0].messages).toHaveLength(1);
    expect(context).toContain(`Your opening message, already sent: "${text}"\nDo not introduce yourself again.`);
    expect(context).toContain("## Stage now: 2 Understand");
    expect(stable).toContain("Never introduce yourself again.");

    // A Hebrew lead: the English opener inputs are not mixed into a Hebrew message.
    const heBuyer = await createSimulatedBuyer(db, actor(), account, { fullName: "Yossi Levi", company: "Bistro", language: "he", country: "IL" });
    if (!heBuyer.ok) throw new Error(JSON.stringify(heBuyer.errors));
    const heStarted = await startSimulatorConversation(db, actor(), acc, heBuyer.lead.id);
    if (!heStarted.ok) throw new Error(heStarted.reason);
    const [heOpener] = await db.select().from(messages).where(eq(messages.id, heStarted.messageId));
    expect(heOpener.body).toBe("היי Yossi, כאן \u2068Maya\u2069 מהשירות האוטומטי של \u2068Polar\u2069. ביקשת שניצור קשר. מה גרם לך לפנות אלינו היום?");
  });
});
