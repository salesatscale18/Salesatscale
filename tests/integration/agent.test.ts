import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, leadEvents, leads, messages, quotes, sellerAccounts, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import { publishDraft, saveDraftItem, addDraftRule } from "@/lib/catalog/service";
import { listLeads } from "@/lib/leads/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import {
  addFact, conversationMessages, ensureDraftVersion, getDealState, listVersions, publishDraftVersion, rollbackTo, saveDraftPlaybook,
  startTestConversation, verifyField,
} from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

describe("agent turns (scripted model)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    for (const raw of [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "590" },
      { sku: "GW-10", name: "Site gateway", unit: "site", price: "660" },
      { sku: "PLAN-M", name: "Monitoring plan", unit: "site", price: "90", chargeType: "recurring" },
    ]) {
      const p = parseCatalogItem(raw, "ILS");
      if (!p.ok) throw new Error();
      await saveDraftItem(db, acc, p.value);
    }
    await addDraftRule(db, acc, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true });
    await publishDraft(db, { userId: me.id, actingAs: false }, acc);
    await addFact(db, { userId: me.id, actingAs: false }, acc, { topic: "Warranty", statement: "Sensors have a 24-month warranty.", sourceLabel: "Product sheet p.2" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...draft.playbook, maxDiscountBp: 700 });
  });
  afterAll(async () => t.close());

  const newConv = async (language = "en") => (await startTestConversation(db, acc, me.id, { language }))!;

  it("test-lab conversations use a hidden test lead", async () => {
    const c = await newConv();
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead).toMatchObject({ isTest: true, sourceLabel: "Test lab" });
    expect((await listLeads(db, acc)).total).toBe(0);
  });

  it("ready buyer: learns fields, searches, quotes; every call is in the trace", async () => {
    const c = await newConv();
    let seenSystem = "";
    const llm = new ScriptedLlm([
      (req: LlmRequest) => { seenSystem = req.system[0]; return { content: [use("t1", "update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: "quote", objection: null }), use("t2", "search_catalog", { query: "sensor" })] }; },
      (req: LlmRequest) => {
        expect(req.system[1]).toContain("Still needed before a quote: nothing.");
        return { content: [use("t3", "create_quote", { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discount_percent: 0, sites: 2 })] };
      },
      step(say("Your quote Q-1001 is ₪4,860.00 plus ₪180.00/month.")),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "We run 2 restaurant kitchens with 6 fridges. Price?" });
    expect(r).toMatchObject({ status: "replied", calls: 3 });
    expect(seenSystem).toContain("Polar assistant");
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(calls.map((x) => [x.sequence, x.name, x.outcome])).toEqual([[1, "update_deal_state", "ok"], [2, "search_catalog", "ok"], [3, "create_quote", "ok"]]);
    expect(calls[2].result).toMatchObject({ quote: "Q-1001 v1", due_on_signing: "₪4,860.00", monthly: "₪180.00/month" });
    const deal = await getDealState(db, acc, c.leadId);
    expect(deal?.fields.sites).toMatchObject({ value: "2", provenance: "buyer" });
    expect(deal?.nextStep).toBe("quote");
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.status).toBe("draft");
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("agent_handling");
    // Tool results went back to the model as JSON tool_result blocks.
    const thread = await conversationMessages(db, acc, c.conversationId);
    expect(thread.map((x) => x.message.actor)).toEqual(["buyer", "agent"]);
    expect(thread[1].calls).toHaveLength(3);
  });

  it("refuses a quote before the deal is qualified and says what is missing", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("q1", "create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 0, sites: null })),
      (req: LlmRequest) => {
        const last = req.messages[req.messages.length - 1];
        const result = JSON.parse((last.content as { content: string }[])[0].content);
        expect(result).toMatchObject({ refused: true, rule: "Before-quote fields missing", missing: ["Business type", "Number of sites"] });
        return { content: [say("Sure! What kind of business is it, and how many sites?")] };
      },
    ]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Just send me a price" });
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(call).toMatchObject({ outcome: "refused", rule: "Before-quote fields missing" });
    expect(await db.select().from(quotes).where(eq(quotes.leadId, c.leadId))).toEqual([]);
  });

  it("a discount above the limit becomes a quote awaiting the seller's approval", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("a", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: { text: "Too expensive", handled: false } })),
      step(use("b", "create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 15, sites: 1 })),
      step(say("I'm confirming that price with the team.")),
    ]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "15% off or no deal" });
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.status).toBe("awaiting_approval");
    expect((await getDealState(db, acc, c.leadId))?.objections).toEqual([{ text: "Too expensive", handled: false }]);
  });

  it("never overwrites a field a person verified; unknown keys are reported", async () => {
    const c = await newConv();
    expect(await verifyField(db, { userId: me.id, actingAs: false }, acc, c.leadId, "sites", "3")).toBe(true);
    const llm = new ScriptedLlm([
      step(use("v", "update_deal_state", { updates: [{ key: "sites", value: "1", provenance: "inferred" }, { key: "colour", value: "red", provenance: "buyer" }], next_step: null, objection: null })),
      step(say("ok")),
    ]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "one site" });
    expect((await getDealState(db, acc, c.leadId))?.fields.sites).toMatchObject({ value: "3", provenance: "verified" });
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(call.result).toMatchObject({ kept_verified: ["sites"], ignored_unknown: ["colour"] });
    const events = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "deal.verified")));
    expect(events).toHaveLength(1);
  });

  it("answers knowledge questions only from approved facts", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("k", "lookup_knowledge", { query: "warranty sensors" })),
      (req: LlmRequest) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        expect(res.facts[0]).toMatchObject({ fact: "Sensors have a 24-month warranty.", source: "Product sheet p.2" });
        return { content: [say("24 months.")] };
      },
    ]);
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "warranty?" })).status).toBe("replied");
  });

  it("STOP opts out at once without calling the model, and nothing replies after", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "STOP" });
    expect(r).toMatchObject({ status: "replied", text: "Understood. We won't contact you again. Have a good day." });
    expect(llm.requests).toHaveLength(0);
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("opted_out");
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "hello?" })).status).toBe("opted_out");
  });

  it("masks card numbers and answers with the fixed rule, without the model (Hebrew)", async () => {
    const c = await newConv("he");
    const llm = new ScriptedLlm([]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "הכרטיס שלי 4111-1111-1111-1111" });
    expect(r.status === "replied" && r.text).toContain("אין לשלוח פרטי כרטיס");
    const [buyer] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "buyer")));
    expect(buyer.body).not.toContain("4111-1111");
  });

  it("hand-off pauses the agent; a model refusal hands off too", async () => {
    const c = await newConv();
    await runBuyerTurn(db, new ScriptedLlm([
      step(use("h", "hand_off_to_human", { reason: "asks for a person", summary: "wants to talk", suggested_reply: "Hi, Danny here" })),
      step(say("A person will continue shortly.")),
    ]), { accountId: acc, conversationId: c.conversationId, text: "I want a human" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    expect(conv.status).toBe("human");
    expect((await runBuyerTurn(db, new ScriptedLlm([]), { accountId: acc, conversationId: c.conversationId, text: "?" })).status).toBe("human");

    const c2 = await newConv();
    const r = await runBuyerTurn(db, new ScriptedLlm([() => ({ content: [], stopReason: "refusal" })]), { accountId: acc, conversationId: c2.conversationId, text: "…" });
    expect(r.status === "replied" && r.text).toContain("Someone from our team");
    const [c2row] = await db.select().from(conversations).where(eq(conversations.id, c2.conversationId));
    expect(c2row.status).toBe("human");
  });

  it("a failing tool returns an error result to the model and the turn still completes", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("x", "check_fit", { lines: "not-a-list", sites: null })),
      step(say("Let me check that.")),
    ]);
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "fit?" })).status).toBe("replied");
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(call.outcome).toBe("failed");
  });

  it("stops after the tool-round limit", async () => {
    const c = await newConv();
    const loop = Array.from({ length: 9 }, (_, i) => step(use(`l${i}`, "search_catalog", { query: "" }), say("still looking")));
    const r = await runBuyerTurn(db, new ScriptedLlm(loop), { accountId: acc, conversationId: c.conversationId, text: "list everything" });
    expect(r).toMatchObject({ status: "replied", text: "still looking", calls: 8 });
  });

  it("sends the order form only when the deal is ready for it; checks payment", async () => {
    const { saveLegalSection } = await import("@/lib/orders/settings");
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("u", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null })),
      step(use("q", "create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
      (req: LlmRequest) => {
        const quote = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content).quote as string;
        return { content: [use("s1", "send_order_form", { quote: quote.split(" ")[0] })] };
      },
      (req: LlmRequest) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        expect(res).toMatchObject({ refused: true, rule: "Before-order-form fields missing", missing: ["Decision maker"] });
        return { content: [use("u2", "update_deal_state", { updates: [{ key: "decision_maker", value: "Owner", provenance: "buyer" }], next_step: null, objection: null })] };
      },
      step(use("s2", "send_order_form", { quote: "Q-1003" })),
      (req: LlmRequest) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        return { content: [use("p", "check_payment", {}), say(res.link ? "Here is your order form." : `no link: ${JSON.stringify(res)}`)] };
      },
      step(say("Here is your order form.")),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Send me the form, I'm the owner" });
    expect(r.status === "replied" && r.text).toBe("Here is your order form.");
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(calls.map((x) => [x.name, x.outcome])).toEqual([
      ["update_deal_state", "ok"], ["create_quote", "ok"], ["send_order_form", "refused"], ["update_deal_state", "ok"], ["send_order_form", "ok"], ["check_payment", "ok"],
    ]);
    expect(calls[4].result).toMatchObject({ link: expect.stringMatching(/\/f\//) });
    expect(calls[5].result).toMatchObject({ signed: false, order_form: "sent" });
  });

  it("keeps accounts apart", async () => {
    const c = await newConv();
    expect((await runBuyerTurn(db, new ScriptedLlm([]), { accountId: other, conversationId: c.conversationId, text: "hi" })).status).toBe("not_found");
    expect(await conversationMessages(db, other, c.conversationId)).toEqual([]);
    expect(await verifyField(db, { userId: me.id, actingAs: false }, other, c.leadId, "sites", "9")).toBe(false);
  });

  it("publishes the draft (and its discount limit), then rolls back in one step", async () => {
    const actor = { userId: me.id, actingAs: false };
    expect(await publishDraftVersion(db, actor, acc)).toBe(1);
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    expect(account.maxDiscountBp).toBe(700);
    const v2 = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...v2.playbook, maxDiscountBp: 1000 });
    expect(await publishDraftVersion(db, actor, acc)).toBe(2);
    const v1 = (await listVersions(db, acc)).find((v) => v.version === 1)!;
    expect(await rollbackTo(db, actor, acc, v1.id)).toBe(1);
    const statuses = Object.fromEntries((await listVersions(db, acc)).map((v) => [v.version, v.status]));
    expect(statuses).toEqual({ 1: "live", 2: "retired" });
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0].maxDiscountBp).toBe(700);
  });
});
