import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { conversations, dealStates, leadEvents, leads, messages, quotes, sellerAccounts, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { listLeads } from "@/lib/leads/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import {
  addFact, conversationMessages, ensureDraftVersion, getDealState, listVersions, publishDraftVersion, rollbackTo, saveDraftPlaybook,
  startTestConversation, verifyField,
} from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

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
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
      { sku: "PLAN-M", name: "Monitoring plan", unit: "site", kind: "service" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" },
      { sku: "EXPORT-ONLY", name: "Export kit", unit: "item" },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
    ]);
    await seedPricing(db, acc, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000 },
      { sku: "PLAN-M", recurring: 9_000 },
      // The installation fee is free in this price list ("Included"), so totals stay as in the canvas.
      { sku: "SVC-INST" },
    ], { userId: me.id });
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
        // The deal-state context is fixed for the turn; the tool result says what is still needed now.
        const saved = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        expect(saved).toMatchObject({ saved: ["business_type", "sites"], still_needed_before_quote: [] });
        return { content: [use("t3", "create_quote", { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discount_percent: 0, sites: 2 })] };
      },
      step(say("Your quote Q-1001 is ₪4,860.00 plus ₪180.00/month.")),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "We run 2 restaurant kitchens with 6 fridges. Price?" });
    expect(r).toMatchObject({ status: "replied", calls: 3 });
    expect(seenSystem).toContain("Polar assistant");
    // system[1] (deal-state context) is computed once per turn: identical in every round.
    expect(llm.requests).toHaveLength(3);
    expect(new Set(llm.requests.map((q) => q.system[1])).size).toBe(1);
    expect(llm.requests[0].system[1]).toContain("Still missing for a quote: Business type, Number of sites.");
    // One cache breakpoint on the last history block of every request, none earlier.
    for (const q of llm.requests) {
      const blocks = q.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { cache_control?: unknown }[];
      const last = q.messages.at(-1)!.content as { cache_control?: unknown }[];
      expect(Array.isArray(last)).toBe(true);
      expect(last.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
      expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
    }
    expect(llm.requests[0].messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "We run 2 restaurant kitchens with 6 fridges. Price?", cache_control: { type: "ephemeral" } }] });
    // End-of-turn writes: agent message, its calls (linked by id) and the conversation's updated_at.
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const [agentMsg] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent"), isNotNull(messages.usage)));
    expect(r.status === "replied" && r.messageId).toBe(agentMsg.id);
    expect(agentMsg.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, model: "scripted" });
    expect(conv.updatedAt.getTime()).toBeGreaterThanOrEqual(conv.createdAt.getTime());
    expect((await db.select().from(toolCalls).where(eq(toolCalls.messageId, agentMsg.id)))).toHaveLength(3);
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(calls.map((x) => [x.sequence, x.name, x.outcome])).toEqual([[1, "update_deal_state", "ok"], [2, "search_catalog", "ok"], [3, "create_quote", "ok"]]);
    // Prices were withheld at search time (nothing confirmed yet); the quote's totals say which side of VAT they are on.
    expect(calls[1].result).toMatchObject({ prices: "withheld until the buyer confirms the recommendation or asks for the price" });
    expect(calls[2].result).toMatchObject({
      quote: "Q-1001 v1",
      totals: { total_today_including_vat: "₪4,860.00", subtotal_before_vat: "₪4,118.64", vat_rate: "18%", vat_amount: "₪741.36", recurring_total_including_vat: "₪180.00/month" },
      message: "The quote message was sent to the buyer by the app. Do not repeat the lines or totals. Add only the closing sentence.",
    });
    const deal = await getDealState(db, acc, c.leadId);
    expect(deal?.fields.sites).toMatchObject({ value: "2", provenance: "buyer" });
    expect(deal?.nextStep).toBe("quote");
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.status).toBe("draft");
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("agent_handling");
    // Tool results went back to the model as JSON tool_result blocks.
    const thread = await conversationMessages(db, acc, c.conversationId);
    // The app's quote message comes before the agent's reply, which carries the calls.
    expect(thread.map((x) => x.message.actor)).toEqual(["buyer", "agent", "agent"]);
    expect(thread[1].message.id).toBe(calls[2].result.quote_message_id);
    expect(thread[1].message.body).toMatch(/^\*Quote Q-1001\*\n6 × Wireless fridge sensor \(SNS-200\): ₪3,540\n/);
    expect(thread[2].calls).toHaveLength(3);
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

  it("sends the order form without company or signer fields (the buyer fills them in the form); checks payment", async () => {
    const { saveLegalSection } = await import("@/lib/orders/settings");
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    const c = await newConv();
    const last = (req: LlmRequest) => JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
    const llm = new ScriptedLlm([
      // Before-quote fields are still required.
      step(use("s0", "send_order_form", { quote: "Q-1" })),
      (req: LlmRequest) => {
        expect(last(req)).toMatchObject({ refused: true, rule: "Before-quote fields missing", missing: ["Business type", "Number of sites"] });
        return { content: [use("u", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null })] };
      },
      step(use("q", "create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
      // "Decision maker" (needed before the order form) is not known: the form is sent all the same.
      (req: LlmRequest) => ({ content: [use("s1", "send_order_form", { quote: String(last(req).quote).split(" ")[0] })] }),
      (req: LlmRequest) => {
        const res = last(req);
        expect(res.message).toContain("fill in their company details, sign and pay");
        return { content: [use("p", "check_payment", {}), say(res.link ? "Here is your order form." : `no link: ${JSON.stringify(res)}`)] };
      },
      step(say("Here is your order form.")),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Send me the form" });
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect((await getDealState(db, acc, c.leadId))?.fields.decision_maker).toBeUndefined();
    // The model left the link out: it is added on its own line (lib/agent/links.ts).
    expect(r.status === "replied" && r.text).toBe(`Here is your order form.\n${calls[3].result.link}`);
    expect(calls.map((x) => [x.name, x.outcome])).toEqual([
      ["send_order_form", "refused"], ["update_deal_state", "ok"], ["create_quote", "ok"], ["send_order_form", "ok"], ["check_payment", "ok"],
    ]);
    expect(calls[3].result).toMatchObject({ link: expect.stringMatching(/\/f\//) });
    expect(calls[4].result).toMatchObject({ signed: false, order_form: "sent" });
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

  it("record_opt_out: an opt-out in other words opts the lead out, closes the chat and sends the fixed reply", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("o", "record_opt_out", { reason: "Please never write to me again" })),
      (req: LlmRequest) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        expect(res).toMatchObject({ ok: true, reply: "Understood. We won't contact you again. Have a good day." });
        return { content: [say("Sorry to see you go! Maybe a discount?")] };
      },
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Please never write to me again" });
    expect(r).toMatchObject({ status: "replied", text: "Understood. We won't contact you again. Have a good day.", calls: 1 });
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("opted_out");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    expect(conv.status).toBe("closed");
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(call).toMatchObject({ name: "record_opt_out", outcome: "ok" });
    expect((await runBuyerTurn(db, new ScriptedLlm([]), { accountId: acc, conversationId: c.conversationId, text: "hello?" })).status).toBe("opted_out");
    // Hebrew chat gets the Hebrew fixed reply.
    const he = await newConv("he");
    const r2 = await runBuyerTurn(db, new ScriptedLlm([step(use("o2", "record_opt_out", { reason: "לא רוצה הודעות" })), step(say("ok"))]), { accountId: acc, conversationId: he.conversationId, text: "אני לא רוצה לקבל מכם הודעות" });
    expect(r2).toMatchObject({ status: "replied", text: "הבנתי, לא נפנה אליך שוב. יום טוב." });
  });

  it("broadened opt-out phrases opt out without calling the model", async () => {
    for (const text of ["Stop messaging me!", "תפסיקו לשלוח"]) {
      const c = await newConv(text.startsWith("S") ? "en" : "he");
      const llm = new ScriptedLlm([]);
      const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text });
      expect(r.status).toBe("replied");
      expect(llm.requests).toHaveLength(0);
      expect((await db.select().from(leads).where(eq(leads.id, c.leadId)))[0].status).toBe("opted_out");
    }
  });

  it("placeholder values do not satisfy gating fields, and create_quote stays refused", async () => {
    const c = await newConv();
    const llm = new ScriptedLlm([
      step(use("p1", "update_deal_state", { updates: [
        { key: "business_type", value: "n/a", provenance: "inferred" }, { key: "sites", value: " Unknown ", provenance: "inferred" },
        { key: "decision_maker", value: "לא ידוע", provenance: "inferred" },
      ], next_step: null, objection: null })),
      (req: LlmRequest) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
        expect(res).toMatchObject({ ok: true, saved: [], rejected_placeholder: ["business_type", "sites", "decision_maker"] });
        return { content: [use("p2", "create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 0, sites: null })] };
      },
      step(say("What kind of business is it?")),
    ]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "just quote" });
    expect((await getDealState(db, acc, c.leadId))?.fields ?? {}).toEqual({});
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId)).orderBy(toolCalls.sequence);
    expect(calls.map((x) => [x.name, x.outcome, x.rule])).toEqual([["update_deal_state", "ok", null], ["create_quote", "refused", "Before-quote fields missing"]]);
    expect(await db.select().from(quotes).where(eq(quotes.leadId, c.leadId))).toEqual([]);
  });

  it("a paused account gets 'paused' with no model call; the message is kept and STOP still works", async () => {
    const c = await newConv();
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, acc));
    try {
      const llm = new ScriptedLlm([]);
      expect(await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "hi there" })).toEqual({ status: "paused" });
      expect(llm.requests).toHaveLength(0);
      const thread = await conversationMessages(db, acc, c.conversationId);
      expect(thread.map((x) => [x.message.actor, x.message.body])).toEqual([["buyer", "hi there"]]);
      expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "STOP" })).status).toBe("replied");
      expect((await db.select().from(leads).where(eq(leads.id, c.leadId)))[0].status).toBe("opted_out");
    } finally {
      await db.update(sellerAccounts).set({ status: "setting_up" }).where(eq(sellerAccounts.id, acc));
    }
  });

  it("a hand-off during the turn keeps the lead with a person (no move to agent_handling)", async () => {
    const c = await newConv();
    await runBuyerTurn(db, new ScriptedLlm([
      step(use("h1", "hand_off_to_human", { reason: "asks for a person", summary: "", suggested_reply: "" })),
      step(say("A person will continue.")),
    ]), { accountId: acc, conversationId: c.conversationId, text: "a human please" });
    expect((await db.select().from(leads).where(eq(leads.id, c.leadId)))[0].status).toBe("human_handling");
  });

  it("a conversation thread shows the latest 100 messages, oldest first, each with its own tool calls", async () => {
    const c = await newConv();
    const base = Date.now() - 1_000_000;
    const rows = Array.from({ length: 105 }, (_, i) => ({
      id: crypto.randomUUID(), accountId: acc, conversationId: c.conversationId, actor: i % 2 ? "agent" : "buyer", body: `m${i}`, createdAt: new Date(base + i * 1000),
    }));
    await db.insert(messages).values(rows);
    await db.insert(toolCalls).values([
      { accountId: acc, conversationId: c.conversationId, messageId: rows[103].id, sequence: 2, name: "check_fit", input: {}, result: {}, outcome: "ok" as const },
      { accountId: acc, conversationId: c.conversationId, messageId: rows[103].id, sequence: 1, name: "search_catalog", input: {}, result: {}, outcome: "ok" as const },
      { accountId: acc, conversationId: c.conversationId, messageId: rows[1].id, sequence: 1, name: "lookup_knowledge", input: {}, result: {}, outcome: "ok" as const },
    ]);
    const thread = await conversationMessages(db, acc, c.conversationId);
    expect(thread).toHaveLength(100);
    expect(thread[0].message.body).toBe("m5");
    expect(thread.at(-1)!.message.body).toBe("m104");
    expect(thread.find((x) => x.message.body === "m103")!.calls.map((x) => x.name)).toEqual(["search_catalog", "check_fit"]);
    expect(thread.filter((x) => x.calls.length).map((x) => x.message.body)).toEqual(["m103"]);
    expect(await conversationMessages(db, other, c.conversationId)).toEqual([]);
  });

  it("tools reuse the turn's memo: catalog and facts load once, create_quote prices with the loaded account", async () => {
    const { runTool } = await import("@/lib/agent/tools");
    const c = await newConv();
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const draft = await ensureDraftVersion(db, acc);
    const memo: import("@/lib/agent/tools").TurnMemo = { account: { ...account, maxDiscountBp: 0 } };
    const ctx = (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, memo });
    await runTool("search_catalog", { query: "" }, ctx("m1"));
    const firstCatalog = memo.catalog;
    expect(firstCatalog).toBeInstanceOf(Promise);
    await runTool("check_fit", { lines: [{ sku: "GW-10", qty: 1 }], sites: 1 }, ctx("m2"));
    expect(memo.catalog).toBe(firstCatalog);
    await runTool("lookup_knowledge", { query: "warranty" }, ctx("m3"));
    const firstFacts = memo.facts;
    await runTool("lookup_knowledge", { query: "sensor warranty" }, ctx("m4"));
    expect(memo.facts).toBe(firstFacts);
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx("m5"));
    // The memo account (limit 0%) is used, not a re-read (limit 7%): a 5% discount needs approval.
    const q = await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 5, sites: 1 }, ctx("m6"));
    expect(q.result).toMatchObject({ ok: true, status: "awaiting_seller_approval" });
    // Without a memo the account is read from the database (limit 7%): ready.
    const c2 = await newConv();
    const plain = (callId: string) => ({ db, accountId: acc, conversationId: c2.conversationId, leadId: c2.leadId, playbook: draft.playbook, currency: "ILS", callId });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, plain("n1"));
    expect((await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 5, sites: 1 }, plain("n2"))).result).toMatchObject({ status: "ready" });
    // Rows of another account in the memo are ignored.
    const c3 = await newConv();
    const [otherAcc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, other));
    const foreign = { account: { ...otherAcc, maxDiscountBp: 0 } };
    const fctx = (callId: string) => ({ ...plain(callId), conversationId: c3.conversationId, leadId: c3.leadId, memo: foreign });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, fctx("f1"));
    expect((await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 5, sites: 1 }, fctx("f2"))).result).toMatchObject({ status: "ready" });
  });
  // --- Markets and price lists (wave 2, lane Q) ------------------------------

  const toolCtx = async (memo?: import("@/lib/agent/tools").TurnMemo) => {
    const c = await newConv();
    const draft = await ensureDraftVersion(db, acc);
    return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, memo }) };
  };
  const qualify = { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }], next_step: null, objection: null };

  /** Records a conversation fact (lib/agent/core/facts.ts) as lane A's update_deal_state will. */
  const setFact = async (leadId: string, key: string) => {
    const fields = { [key]: { value: "yes", provenance: "buyer" as const, updatedAt: new Date().toISOString() } };
    await db.insert(dealStates).values({ accountId: acc, leadId, fields }).onConflictDoUpdate({ target: dealStates.leadId, set: { fields } });
  };

  it("search_catalog and check_fit withhold prices until the recommendation is confirmed; plain names and value lines come back", async () => {
    const { runTool, PRICES_WITHHELD } = await import("@/lib/agent/tools");
    const memo: import("@/lib/agent/tools").TurnMemo = {};
    const { c, ctx } = await toolCtx(memo);
    const hidden = await runTool("search_catalog", { query: "" }, ctx("w1"));
    expect(hidden.result).toMatchObject({ ok: true, prices: PRICES_WITHHELD });
    expect(hidden.result).not.toHaveProperty("prices_include_tax");
    const hiddenItems = (hidden.result as { items: Record<string, unknown>[] }).items;
    expect(hiddenItems.find((i) => i.sku === "SNS-200")).toMatchObject({ sold_here: true, plain_name: "Wireless fridge sensor", unit: "device" });
    for (const i of hiddenItems) {
      for (const k of ["one_time_price", "recurring_price", "volume_prices", "priced_by_seller_from_qty"]) expect(i).not.toHaveProperty(k);
    }
    expect(JSON.stringify(hidden.result)).not.toContain("₪");
    const hiddenFit = await runTool("check_fit", { lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], sites: 2 }, ctx("w2"));
    expect(hiddenFit.result).toMatchObject({ ok: true, prices: PRICES_WITHHELD, added_automatically: ["SVC-INST"], delivery: expect.any(String) });
    expect(hiddenFit.result).not.toHaveProperty("totals");
    expect(JSON.stringify(hiddenFit.result)).not.toContain("₪");

    // The buyer confirmed the recommendation: prices come back.
    await setFact(c.leadId, "_recommendation_confirmed");
    const s = await runTool("search_catalog", { query: "" }, ctx("s1"));
    expect(s.outcome).toBe("ok");
    const items = (s.result as { items: Record<string, unknown>[] }).items;
    expect(items.find((i) => i.sku === "SNS-200")).toMatchObject({ sold_here: true, one_time_price: "₪590.00", recurring_price: null });
    expect(items.find((i) => i.sku === "PLAN-M")).toMatchObject({ sold_here: true, one_time_price: null, recurring_price: "₪90.00/month", kind: "service" });
    expect(items.find((i) => i.sku === "EXPORT-ONLY")).toMatchObject({ sold_here: false });
    expect(items.find((i) => i.sku === "EXPORT-ONLY")).not.toHaveProperty("one_time_price");
    expect(s.result).toMatchObject({ currency: "ILS", prices_include_tax: true, price_basis: "Prices include VAT 18%." });
    expect(s.result).not.toHaveProperty("prices");
    const firstPricing = memo.pricing;
    expect(firstPricing).toBeInstanceOf(Promise);

    const fit = await runTool("check_fit", { lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], sites: 2 }, ctx("s2"));
    expect(memo.pricing).toBe(firstPricing);
    expect(fit.result).toMatchObject({
      ok: true, added_automatically: ["SVC-INST"],
      totals: { total_today_including_vat: "₪3,680.00", vat_rate: "18%", recurring_total_including_vat: "₪180.00/month" },
      lines: expect.arrayContaining([{ sku: "SVC-INST", name: "Installation", plain_name: "Installation", qty: 2, charge: "one-time", total_including_vat: "included", added_automatically: true, buyer_can_remove: true }]),
    });
    const bad = await runTool("check_fit", { lines: [{ sku: "EXPORT-ONLY", qty: 1 }], sites: null }, ctx("s3"));
    expect(bad.result).toMatchObject({ ok: false, not_sold_here: ["EXPORT-ONLY"], problems: ["EXPORT-ONLY is not sold in this market."] });

    // The buyer asked for the price early: released too.
    const asked = await toolCtx();
    await setFact(asked.c.leadId, "_price_asked");
    expect((await runTool("search_catalog", { query: "sensor" }, asked.ctx("a1"))).result).not.toHaveProperty("prices");
    // A quote exists for the conversation: released.
    const quoted = await toolCtx();
    await runTool("update_deal_state", qualify, quoted.ctx("qq1"));
    expect((await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, quoted.ctx("qq2"))).outcome).toBe("ok");
    const after = await runTool("check_fit", { lines: [{ sku: "GW-10", qty: 1 }], sites: 1 }, quoted.ctx("qq3"));
    expect(after.result).toHaveProperty("totals");
  });

  it("create_quote refuses items not sold in the market, and every price tool refuses without a price list", async () => {
    const { runTool } = await import("@/lib/agent/tools");
    const { ctx } = await toolCtx();
    await runTool("update_deal_state", qualify, ctx("ns1"));
    const r = await runTool("create_quote", { lines: [{ sku: "EXPORT-ONLY", qty: 1 }], discount_percent: 0, sites: 2 }, ctx("ns2"));
    expect(r).toMatchObject({ outcome: "refused", rule: "Not sold in this buyer's market", result: { not_sold_here: ["EXPORT-ONLY"] } });

    const { createMarket } = await import("@/lib/markets/service");
    const cy = await createMarket(db, { userId: me.id, actingAs: false }, acc, { name: "Cyprus", countries: ["CY"], phonePrefixes: ["+357"] });
    if (!cy.ok) throw new Error();
    const { c, ctx: ctx2 } = await toolCtx();
    await db.update(leads).set({ marketId: cy.market.id }).where(eq(leads.id, c.leadId));
    await runTool("update_deal_state", qualify, ctx2("np1"));
    for (const [name, input] of [
      ["search_catalog", { query: "" }],
      ["create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 }],
    ] as const) {
      expect(await runTool(name, input, ctx2(`np-${name}`))).toMatchObject({ outcome: "refused", rule: "No price list for this buyer's market" });
    }
    expect((await runTool("check_fit", { lines: [{ sku: "GW-10", qty: 1 }], sites: 1 }, ctx2("np3"))).result).toMatchObject({ ok: true, prices: "No price list for this buyer's market" });
    expect(await db.select().from(quotes).where(eq(quotes.leadId, c.leadId))).toEqual([]);
  });

  it("create_quote prices in the lead's market; a memo loaded for another market or account is not used", async () => {
    const { runTool } = await import("@/lib/agent/tools");
    const { createMarket } = await import("@/lib/markets/service");
    const gr = await createMarket(db, { userId: me.id, actingAs: false }, acc, { name: "Greece", countries: ["GR"], phonePrefixes: ["+30"] });
    if (!gr.ok) throw new Error();
    await seedPricing(db, acc, [{ sku: "GW-10", oneTime: 20_000 }, { sku: "PLAN-M", recurring: 50_000, period: "year" }], { name: "EUR", currency: "EUR", marketId: gr.market.id });
    // The memo holds the home market's prices (as if loaded earlier in the turn for another lead).
    const homeMemo: import("@/lib/agent/tools").TurnMemo = {};
    const { ctx: homeCtx } = await toolCtx(homeMemo);
    await runTool("search_catalog", { query: "" }, homeCtx("hm1"));
    const { c, ctx } = await toolCtx(homeMemo);
    await db.update(leads).set({ marketId: gr.market.id }).where(eq(leads.id, c.leadId));
    await runTool("update_deal_state", qualify, ctx("gr1"));
    const r = await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }, { sku: "PLAN-M", qty: 1 }], discount_percent: 0, sites: 1 }, ctx("gr2"));
    expect(r.result).toMatchObject({ ok: true, totals: { total_today_including_vat: "€200.00", recurring_total_including_vat: "€500.00/year" }, status: "ready" });
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.marketId).toBe(gr.market.id);
  });
});
