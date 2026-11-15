import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import type { Actor } from "@/lib/accounts/audit";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { parsePlaybookRows, playbookRowsFromForm } from "@/lib/agent/playbook";
import {
  addFact, answerQuestion, applyAgentUpdates, approveAllSuggested, approvedFacts, ensureDraftVersion, getDealState, getFact, listFacts,
  listTopics, removeFact, saveDraftPlaybook, setFactStatus, startTestConversation, unansweredQuestions, updateFact,
} from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";

describe("playbook editor and knowledge", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string, other: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
  });
  afterAll(async () => t.close());

  // -------------------------------------------------------------------------
  // Playbook
  // -------------------------------------------------------------------------

  /** What the client form posts for a playbook, row by row (as FormData entries). */
  const formFor = (pb: Awaited<ReturnType<typeof ensureDraftVersion>>["playbook"], change: (e: [string, string][]) => [string, string][] = (e) => e) => {
    const e: [string, string][] = [
      ["slug", "polar"], ["agentName", pb.agentName], ["goal", pb.goal], ["tone", pb.tone], ["maxDiscount", String(pb.maxDiscountBp / 100)],
      ["offerMeetingWhen", pb.offerMeetingWhen], ["handOffWhen", pb.handOffWhen],
      ...(pb.outcomes.orderForm ? [["orderForm", "on"] as [string, string]] : []),
      ...(pb.outcomes.meeting ? [["meeting", "on"] as [string, string]] : []),
    ];
    pb.fields.forEach((f, i) => {
      e.push([`field.${i}.key`, f.key], [`field.${i}.label`, f.label], [`field.${i}.stage`, f.stage], [`field.${i}.example`, f.example ?? ""]);
      if (f.hint) e.push([`field.${i}.hint`, f.hint]);
    });
    pb.objections.forEach((o, i) => e.push([`objection.${i}.objection`, o.objection], [`objection.${i}.answer`, o.answer], [`objection.${i}.source`, o.source ?? ""]));
    pb.neverDo.forEach((n, i) => e.push([`never.${i}`, n]));
    return change(e);
  };

  it("saves the structured playbook into the draft and reads it back unchanged", async () => {
    const draft = await ensureDraftVersion(db, acc);
    const input = playbookRowsFromForm([
      ...formFor(draft.playbook),
      ["field.3.label", "Fridges and freezers"], ["field.3.stage", "before_quote"], ["field.3.example", "How many fridges do you need to watch?"],
      ["objection.0.objection", "I need to check with my partner"], ["objection.0.answer", "Offer a short call with both of them."], ["objection.0.source", "Call notes"],
      ["never.0", "Promise an installation date"],
    ]);
    const r = parsePlaybookRows(input);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    await saveDraftPlaybook(db, acc, r.value);
    const again = await ensureDraftVersion(db, acc);
    expect(again.id).toBe(draft.id);
    expect(again.playbook.fields.map((f) => f.key)).toEqual(["business_type", "sites", "decision_maker", "fridges_and_freezers"]);
    expect(again.playbook.fields[3]).toEqual({ key: "fridges_and_freezers", label: "Fridges and freezers", stage: "before_quote", example: "How many fridges do you need to watch?" });
    expect(again.playbook.fields[1].hint).toBe("Whole number"); // kept through the hidden input
    expect(again.playbook.objections).toEqual([{ objection: "I need to check with my partner", answer: "Offer a short call with both of them.", source: "Call notes" }]);
    expect(again.playbook.neverDo).toEqual(["Promise an installation date"]);

    // Saving the same form again changes nothing.
    const r2 = parsePlaybookRows(playbookRowsFromForm(formFor(again.playbook)));
    expect(r2.ok && r2.value).toEqual(again.playbook);
  });

  it("keeps keys stable on rename and reorder, so deal-state values stay attached", async () => {
    const draft = await ensureDraftVersion(db, acc);
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    await applyAgentUpdates(db, acc, c.leadId, draft.playbook, [{ key: "sites", value: "2", provenance: "buyer" }]);

    // Rename "Number of sites" and move it to the top.
    const pb = { ...draft.playbook, fields: [{ ...draft.playbook.fields[1], label: "Locations" }, draft.playbook.fields[0], ...draft.playbook.fields.slice(2)] };
    const r = parsePlaybookRows(playbookRowsFromForm(formFor(pb)));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    await saveDraftPlaybook(db, acc, r.value);
    const saved = (await ensureDraftVersion(db, acc)).playbook;
    expect(saved.fields.slice(0, 2).map((f) => [f.key, f.label])).toEqual([["sites", "Locations"], ["business_type", "Business type"]]);
    const deal = await getDealState(db, acc, c.leadId);
    expect(saved.fields.find((f) => f.key === "sites") && deal?.fields.sites?.value).toBe("2");
  });

  it("refuses an invalid playbook without touching the draft", async () => {
    const before = (await ensureDraftVersion(db, acc)).playbook;
    const r = parsePlaybookRows(playbookRowsFromForm(formFor(before, (e) => [...e.filter(([k]) => k !== "maxDiscount"), ["maxDiscount", "60"]])));
    expect(!r.ok && r.errors).toHaveProperty("maxDiscount");
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Knowledge
  // -------------------------------------------------------------------------

  it("adds, edits, changes status and deletes facts, only within the account", async () => {
    const f = await addFact(db, actor, acc, { topic: "Warranty", statement: "Sensors have a 12-month warranty.", sourceLabel: "Spec p.5" });
    expect(f.status).toBe("approved");
    const edited = await updateFact(db, acc, f.id, { topic: "Warranty", statement: "Sensors have a 24-month warranty.", sourceLabel: "Spec p.5" });
    expect(edited).toMatchObject({ statement: "Sensors have a 24-month warranty.", status: "approved" });

    // Another account cannot read, edit, change or delete it.
    expect(await getFact(db, other, f.id)).toBeNull();
    expect(await updateFact(db, other, f.id, { topic: "X", statement: "hacked", sourceLabel: null })).toBeNull();
    expect(await setFactStatus(db, other, f.id, "rejected")).toBeNull();
    expect(await removeFact(db, other, f.id)).toBe(false);
    expect(await getFact(db, acc, f.id)).toMatchObject({ statement: "Sensors have a 24-month warranty.", status: "approved" });
    // Not a uuid: no error, nothing found.
    expect(await setFactStatus(db, acc, "not-a-uuid", "approved")).toBeNull();

    expect((await setFactStatus(db, acc, f.id, "rejected"))?.status).toBe("rejected");
    expect((await approvedFacts(db, acc)).map((x) => x.id)).not.toContain(f.id);
    expect((await setFactStatus(db, acc, f.id, "approved"))?.status).toBe("approved");
    expect(await removeFact(db, acc, f.id)).toBe(true);
    expect(await getFact(db, acc, f.id)).toBeNull();
  });

  it("lists topics with counts and approves all suggested in one topic of one account", async () => {
    await addFact(db, actor, acc, { topic: "Product", statement: "Measures from -40 to +60 °C.", status: "suggested" });
    await addFact(db, actor, acc, { topic: "Product", statement: "One gateway handles 30 sensors.", status: "suggested" });
    await addFact(db, actor, acc, { topic: "Product", statement: "Battery lasts 3 years.", status: "approved" });
    await addFact(db, actor, acc, { topic: "Installation", statement: "No wiring needed.", status: "suggested" });
    await addFact(db, actor, other, { topic: "Product", statement: "Other seller fact.", status: "suggested" });

    const topics = await listTopics(db, acc);
    expect(topics.find((x) => x.topic === "Product")).toEqual({ topic: "Product", total: 3, approved: 1, suggested: 2, rejected: 0 });
    expect((await listFacts(db, acc, { topic: "Installation" })).map((f) => f.statement)).toEqual(["No wiring needed."]);

    expect(await approveAllSuggested(db, acc, "Product")).toBe(2);
    expect((await listFacts(db, acc, { topic: "Product" })).every((f) => f.status === "approved")).toBe(true);
    expect((await listFacts(db, acc, { topic: "Installation" }))[0].status).toBe("suggested");
    expect((await listFacts(db, other, { topic: "Product" }))[0].status).toBe("suggested");
    expect(await approveAllSuggested(db, acc, "Product")).toBe(0);
  });

  const ctxFor = async (accountId: string, callId: string): Promise<ToolContext> => {
    const c = (await startTestConversation(db, accountId, me.id, { language: "en" }))!;
    return { db, accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: c.version.playbook, currency: "ILS", callId };
  };

  it("lookup_knowledge only returns approved facts of the account", async () => {
    await addFact(db, actor, acc, { topic: "Pricing terms", statement: "Monthly plan can be cancelled any time.", status: "approved" });
    await addFact(db, actor, acc, { topic: "Pricing terms", statement: "Monthly plan has a 12-month minimum.", status: "suggested" });
    const rej = await addFact(db, actor, acc, { topic: "Pricing terms", statement: "Monthly plan is free for schools.", status: "approved" });
    await setFactStatus(db, acc, rej.id, "rejected");
    await addFact(db, actor, other, { topic: "Pricing terms", statement: "Monthly plan of the other seller.", status: "approved" });

    const r = await runTool("lookup_knowledge", { query: "monthly plan" }, await ctxFor(acc, "k1"));
    const facts = (r.result.facts as { fact: string }[]).map((f) => f.fact);
    expect(facts).toEqual(["Monthly plan can be cancelled any time."]);
  });

  it("collects questions the agent could not answer, deduplicated, and drops them once answered", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const use = (id: string, query: string): Block => ({ type: "tool_use", id, name: "lookup_knowledge", input: { query } });
    // A real turn: the lookup finds nothing, and the call is stored.
    const llm = new ScriptedLlm([() => ({ content: [use("q1", "cellular backup cost")] }), () => ({ content: [{ type: "text", text: "I will check with the team." }] })]);
    expect(await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "What does the cellular backup cost?" })).toMatchObject({ status: "replied" });

    // More gaps, written straight into the trace: a repeat (different case), another question, a hit, and another account's gap.
    const row = (conversationId: string, accountId: string, seq: number, query: string, facts: unknown[], at: string) => ({
      accountId, conversationId, sequence: seq, name: "lookup_knowledge", input: { query }, result: { ok: true, facts }, outcome: "ok" as const, createdAt: new Date(at),
    });
    const o = (await startTestConversation(db, other, me.id, { language: "en" }))!;
    await db.insert(toolCalls).values([
      row(c.conversationId, acc, 10, "Cellular backup COST?", [], "2030-01-01T10:00:00Z"),
      row(c.conversationId, acc, 11, "minimum contract length", [], "2030-01-01T09:00:00Z"),
      row(c.conversationId, acc, 12, "battery life", [{ id: "x", fact: "3 years" }], "2030-01-01T11:00:00Z"),
      row(o.conversationId, other, 1, "do you deliver abroad", [], "2030-01-01T12:00:00Z"),
    ]);

    const qs = await unansweredQuestions(db, acc);
    expect(qs.map((q) => [q.question, q.times])).toEqual([["Cellular backup COST?", 2], ["minimum contract length", 1]]);
    expect((await unansweredQuestions(db, other)).map((q) => q.question)).toEqual(["do you deliver abroad"]);

    // Answering creates an approved fact sourced to the question; the question disappears.
    const fact = await answerQuestion(db, actor, acc, { question: "Cellular backup COST?", answer: "The cellular backup is ₪25 per month per gateway.", topic: "Pricing terms" });
    expect(fact).toMatchObject({ status: "approved", topic: "Pricing terms", sourceLabel: "Buyer question: Cellular backup COST?" });
    expect((await unansweredQuestions(db, acc)).map((q) => q.question)).toEqual(["minimum contract length"]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc), eq(auditLog.action, "knowledge.question_answered")));
    expect(audit.targetId).toBe(fact!.id);
    // The other account still sees its own question.
    expect((await unansweredQuestions(db, other)).map((q) => q.question)).toEqual(["do you deliver abroad"]);

    // The agent now finds the answer.
    const r = await runTool("lookup_knowledge", { query: "cellular backup cost" }, await ctxFor(acc, "k2"));
    expect((r.result.facts as { fact: string }[]).map((f) => f.fact)).toContain("The cellular backup is ₪25 per month per gateway.");

    // Deleting the answer brings the question back; empty answers are refused.
    await removeFact(db, acc, fact!.id);
    expect((await unansweredQuestions(db, acc)).map((q) => q.question)).toContain("Cellular backup COST?");
    expect(await answerQuestion(db, actor, acc, { question: "minimum contract length", answer: "  " })).toBeNull();
  });

  it("limits the list to the 10 most recent questions", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    await db.insert(toolCalls).values(Array.from({ length: 12 }, (_, i) => ({
      accountId: acc, conversationId: c.conversationId, sequence: i + 1, name: "lookup_knowledge", input: { query: `gap question ${i}` },
      result: { ok: true, facts: [] }, outcome: "ok" as const, createdAt: new Date(Date.UTC(2031, 0, 1, i)),
    })));
    const qs = await unansweredQuestions(db, acc);
    expect(qs).toHaveLength(10);
    expect(qs[0].question).toBe("gap question 11");
  });
});
