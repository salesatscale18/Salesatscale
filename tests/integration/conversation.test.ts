import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, leadEvents, leads, messages, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import { addDraftRule, publishDraft, saveDraftItem } from "@/lib/catalog/service";
import { optOutLead } from "@/lib/leads/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { addHumanReply, deliverHumanMessage, handBack, latestConversationForLead, takeOver } from "@/lib/agent/conversation";
import { conversationScenarioCheck, latestScenarioResults } from "@/lib/agent/scenario-results";
import { scenarioById } from "@/lib/agent/scenarios";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

describe("take over, hand back and replies from a person", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const actor = () => ({ userId: me.id, actingAs: false });

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
    ]) {
      const p = parseCatalogItem(raw, "ILS");
      if (!p.ok) throw new Error();
      await saveDraftItem(db, acc, p.value);
    }
    await addDraftRule(db, acc, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true });
    await publishDraft(db, actor(), acc);
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...draft.playbook, maxDiscountBp: 700 });
  });
  afterAll(async () => t.close());

  const newConv = async (opts: { language?: string; scenario?: string } = {}) =>
    (await startTestConversation(db, acc, me.id, { language: opts.language ?? "en", scenario: opts.scenario }))!;
  const convRow = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0];
  const leadRow = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0];

  it("take over pauses the agent; hand back lets it reply again", async () => {
    const c = await newConv();
    await runBuyerTurn(db, new ScriptedLlm([step(say("Hi! How many sites?"))]), { accountId: acc, conversationId: c.conversationId, text: "hello" });
    expect((await leadRow(c.leadId)).status).toBe("agent_handling");

    expect(await takeOver(db, actor(), acc, c.conversationId)).toEqual({ ok: true, changed: true });
    expect(await convRow(c.conversationId)).toMatchObject({ status: "human", takenOverByUserId: me.id });
    expect((await leadRow(c.leadId)).status).toBe("human_handling");
    expect(await takeOver(db, actor(), acc, c.conversationId)).toEqual({ ok: true, changed: false });

    const silent = new ScriptedLlm([]);
    expect(await runBuyerTurn(db, silent, { accountId: acc, conversationId: c.conversationId, text: "are you there?" })).toEqual({ status: "human" });
    expect(silent.requests).toHaveLength(0);

    expect(await handBack(db, actor(), acc, c.conversationId)).toEqual({ ok: true, changed: true });
    expect(await convRow(c.conversationId)).toMatchObject({ status: "open", takenOverByUserId: null });
    expect((await leadRow(c.leadId)).status).toBe("agent_handling");
    const llm = new ScriptedLlm([step(say("Back with you."))]);
    expect(await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "ok" })).toMatchObject({ status: "replied", text: "Back with you." });
    expect(llm.requests).toHaveLength(1);

    const types = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["conversation.taken_over", "conversation.handed_back"]));
  });

  it("a person can reply only after taking over; the agent then sees the reply", async () => {
    const c = await newConv();
    expect(await addHumanReply(db, actor(), acc, c.conversationId, "Hi, Danny here")).toEqual({ ok: false, reason: "not_taken_over" });
    await takeOver(db, actor(), acc, c.conversationId);
    // The buyer writes while a person has the chat: stored, no model call.
    expect(await runBuyerTurn(db, new ScriptedLlm([]), { accountId: acc, conversationId: c.conversationId, text: "Can someone call me?" })).toEqual({ status: "human" });
    expect(await addHumanReply(db, actor(), acc, c.conversationId, "   ")).toEqual({ ok: false, reason: "empty" });
    const r = await addHumanReply(db, actor(), acc, c.conversationId, "Hi, Danny here");
    // Test-lab chats are only stored, never sent anywhere.
    expect(r).toMatchObject({ ok: true, delivery: null });
    const [m] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "human")));
    expect(m).toMatchObject({ body: "Hi, Danny here", actorUserId: me.id });
    const ev = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "conversation.human_reply")));
    expect(ev).toHaveLength(1);

    await handBack(db, actor(), acc, c.conversationId);
    const llm = new ScriptedLlm([step(say("Thanks!"))]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "thanks Danny" });
    expect(JSON.stringify(llm.requests[0].messages)).toContain("[Danny from the team]: Hi, Danny here");
  });

  it("other channels go through the delivery seam, which does not send until P6", async () => {
    const c = await newConv();
    await db.update(conversations).set({ channel: "whatsapp" }).where(eq(conversations.id, c.conversationId));
    await takeOver(db, actor(), acc, c.conversationId);
    expect(await addHumanReply(db, actor(), acc, c.conversationId, "Hello")).toMatchObject({ ok: true, delivery: { delivered: false, reason: "channel not connected" } });
    expect(await deliverHumanMessage("whatsapp", { accountId: acc, conversationId: c.conversationId, leadId: c.leadId, messageId: "x", body: "b" }))
      .toEqual({ delivered: false, reason: "channel not connected" });
  });

  it("a lead who opted out cannot be handed back, taken over or written to", async () => {
    const c = await newConv();
    await takeOver(db, actor(), acc, c.conversationId);
    await optOutLead(db, actor(), acc, c.leadId);
    expect(await handBack(db, actor(), acc, c.conversationId)).toEqual({ ok: false, reason: "opted_out" });
    expect(await addHumanReply(db, actor(), acc, c.conversationId, "hi")).toEqual({ ok: false, reason: "opted_out" });
    expect((await convRow(c.conversationId)).status).toBe("human");

    const c2 = await newConv();
    await runBuyerTurn(db, new ScriptedLlm([]), { accountId: acc, conversationId: c2.conversationId, text: "STOP" });
    expect(await takeOver(db, actor(), acc, c2.conversationId)).toEqual({ ok: false, reason: "opted_out" });
    expect(await handBack(db, actor(), acc, c2.conversationId)).toEqual({ ok: false, reason: "opted_out" });
  });

  it("keeps accounts apart", async () => {
    const c = await newConv();
    expect(await takeOver(db, actor(), other, c.conversationId)).toEqual({ ok: false, reason: "not_found" });
    expect(await handBack(db, actor(), other, c.conversationId)).toEqual({ ok: false, reason: "not_found" });
    expect(await addHumanReply(db, actor(), other, c.conversationId, "hi")).toEqual({ ok: false, reason: "not_found" });
    expect(await latestConversationForLead(db, other, c.leadId)).toBeNull();
    expect((await convRow(c.conversationId)).status).toBe("open");
  });

  it("audits only when a platform admin acts as the seller", async () => {
    const c = await newConv();
    await takeOver(db, actor(), acc, c.conversationId);
    await handBack(db, { userId: me.id, actingAs: true }, acc, c.conversationId);
    const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, c.leadId));
    expect(rows.map((r) => [r.action, r.actingAs])).toEqual([["conversation.handed_back", true]]);
  });

  it("latest conversation for the lead: thread, trace, authors and the suggested reply", async () => {
    const c = await newConv();
    await runBuyerTurn(db, new ScriptedLlm([
      step(use("h", "hand_off_to_human", { reason: "asks for a person", summary: "wants a call", suggested_reply: "Hi, Danny here. When can I call you?" })),
      step(say("A person will continue shortly.")),
    ]), { accountId: acc, conversationId: c.conversationId, text: "a human please" });
    const view = (await latestConversationForLead(db, acc, c.leadId))!;
    expect(view.conversation.id).toBe(c.conversationId);
    expect(view.conversation.status).toBe("human");
    expect(view.suggestedReply).toBe("Hi, Danny here. When can I call you?");
    expect(view.thread.map((x) => x.message.actor)).toEqual(["buyer", "agent"]);
    expect(view.thread[1].calls.map((x) => x.name)).toEqual(["hand_off_to_human"]);
    expect(view.takenOverBy).toBeNull();
    await takeOver(db, actor(), acc, c.conversationId);
    await addHumanReply(db, actor(), acc, c.conversationId, "Hi, Danny here. When can I call you?");
    const after = (await latestConversationForLead(db, acc, c.leadId))!;
    expect(after.takenOverBy?.firstName).toBe("Danny");
    expect(after.authors[me.id]?.firstName).toBe("Danny");
    // Once a person replied after the hand-off, the reply box is no longer prefilled.
    expect(after.suggestedReply).toBeNull();
  });

  it("scenario end to end: discount push through runBuyerTurn passes its check", async () => {
    const s = scenarioById("discount_push")!;
    const c = await newConv({ scenario: s.id });
    const row = await convRow(c.conversationId);
    expect(row.scenario).toBe("discount_push");
    expect((await conversationScenarioCheck(db, acc, row))?.result).toBe("not_yet");
    const llm = new ScriptedLlm([
      step(use("a", "update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null })),
      step(use("b", "create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 15, sites: 1 })),
      step(say("15% needs approval from our team. I'll come back to you today.")),
    ]);
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: s.opening })).status).toBe("replied");
    const check = await conversationScenarioCheck(db, acc, await convRow(c.conversationId));
    expect(check).toEqual({ result: "passed", reason: "Quote is awaiting your approval." });

    const draft = await ensureDraftVersion(db, acc);
    const results = await latestScenarioResults(db, acc, draft.id);
    expect(results.find((r) => r.scenarioId === "discount_push")).toMatchObject({ conversationId: c.conversationId, check: { result: "passed" } });
    expect(results.find((r) => r.scenarioId === "ready_buyer")).toMatchObject({ conversationId: null, check: null });
    expect(await latestScenarioResults(db, other, draft.id)).toSatisfy((rs: { conversationId: string | null }[]) => rs.every((r) => r.conversationId === null));
  });

  it("scenario: says stop opts out without the model and passes", async () => {
    const c = await newConv({ scenario: "says_stop" });
    const llm = new ScriptedLlm([]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: scenarioById("says_stop")!.opening });
    expect(llm.requests).toHaveLength(0);
    expect((await conversationScenarioCheck(db, acc, await convRow(c.conversationId)))?.result).toBe("passed");
  });
});
