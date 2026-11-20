/**
 * O4, park and continue: a question with no approved answer goes to the team
 * (ask_team) without pausing the chat or telling the buyer; Knowledge lists it
 * with the lead, the buyer's words and must-have; Needs you shows it as a
 * question to answer; the answer reaches the agent's turn context, and a quiet
 * buyer gets it as a message, inside contact hours, once. Scripted model only:
 * nothing here calls the real API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, conversations, leadEvents, leads, messages, sellerAccounts, toolCalls, users, type ContactHours, type SellerAccount, type User } from "@/db/schema";
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example.com" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { runTool, TOOL_DEFS } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { answerQuestion, getConversation, ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation, unansweredQuestions } = await import("@/lib/agent/service");
const { conversationScenarioCheck } = await import("@/lib/agent/scenario-results");
const { needsYou, needsYouCount, needsYouHref } = await import("@/lib/overview/service");
const { runTeamAnswers, teamQuestionsContext } = await import("@/lib/team-questions/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { coreDesign } = await import("@/lib/agent/core/design");
const { realtimeTools, toolLabel, VOICE_TOOL_NAMES } = await import("@/lib/voice/tool-schema");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const HOUR = 3_600_000;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
/** Mondays 09:00-10:00 only (Asia/Jerusalem). */
const MONDAY_NINE: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i === 1, from: "09:00", to: "10:00" }));
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const QUESTION = "Do you offer on-site training in Haifa, and how long does it take?";

describe("Park and continue: questions to the team (O4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const as = (account: SellerAccount) => { holder.access = { account, user: me, actingAs: false, role: "seller_admin" }; };

  const mkAccount = async (name: string, hours: ContactHours = ALL_DAY) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `q${n++}@polar.test` });
    if (!p.ok) throw new Error("account");
    const a = (await createAccount(db, actor(), p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live", contactHours: hours }).where(eq(sellerAccounts.id, a.id));
    const draft = await ensureDraftVersion(db, a.id);
    await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya" });
    await publishDraftVersion(db, actor(), a.id);
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.id)))[0];
  };
  /** A simulated (real, not test) buyer with an open simulator chat. */
  const mkChat = async (a: SellerAccount, name = `Rina ${n++}`) => {
    const made = await createSimulatedBuyer(db, actor(), a, { fullName: name, company: "Rina Co", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, actor(), a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    return { leadId: made.lead.id, conversationId: started.conversationId };
  };
  const ctxFor = async (a: SellerAccount, c: { leadId: string; conversationId: string }, accountId = a.id) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, a.id), eq(agentVersions.status, "live")));
    return { db, accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** A scripted turn: lookup finds nothing, the agent sends the question to the team silently, and keeps selling. */
  const parkTurn = (question = QUESTION, mustHave: boolean | null = null) => new ScriptedLlm([
    step(use("k", "lookup_knowledge", { query: "on-site training Haifa duration" })),
    step(use("a", "ask_team", { question, buyer_words: "on-site training in our city", must_have: mustHave })),
    step(say("I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.")),
  ]);
  const appMessages = async (conversationId: string) => {
    const calls = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.name, "app_message")));
    return calls.filter((c) => c.result.kind === "team_answer");
  };
  const delivered = async (leadId: string) =>
    (await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, "team_question.delivered")))).map((e) => (e.data as { how: string }).how);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "uq", email: "sol@polar.test", firstName: "Sol", role: "user" }).returning();
    acc = await mkAccount("Polar Demo");
    other = await mkAccount("Other Co");
    as(acc);
  }, 120_000);
  afterAll(async () => t.close());

  it("logs the question with the lead, the buyer's words and must-have, does not pause the chat and does not hand off", async () => {
    const c = await mkChat(acc);
    const llm = parkTurn();
    const r = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "Do you offer on-site training in our city, and how long does it take?" });
    expect(r).toMatchObject({ status: "replied" });
    // The chat stays with the agent: not paused, not handed off.
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    expect(conv.status).toBe("open");
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).not.toBe("human_handling");
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId));
    expect(calls.map((x) => x.name)).not.toContain("hand_off_to_human");
    expect(calls.find((x) => x.name === "ask_team")).toMatchObject({ outcome: "ok", result: { ok: true, sent: true } });
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "handoff.requested")))).toHaveLength(0);

    // The lead event links the lead and the conversation, with the words and the flag.
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "team_question.asked")));
    expect(ev).toMatchObject({ accountId: acc.id, actor: "agent" });
    expect(ev.data).toMatchObject({ question: QUESTION, buyerWords: "on-site training in our city", mustHave: null, conversationId: c.conversationId, lookups: ["on-site training haifa duration"] });

    // Knowledge's list: once (the empty lookup of the same turn is covered by the ask), with the lead and the words.
    let qs = await unansweredQuestions(db, acc.id);
    expect(qs.map((q) => q.question)).toEqual([QUESTION]);
    expect(qs[0].asks).toEqual([expect.objectContaining({ leadId: c.leadId, conversationId: c.conversationId, buyerWords: "on-site training in our city", mustHave: null, isTest: false })]);
    // The buyer says it is a must-have: the agent calls again with the same question; still one entry, now must-have.
    await runTool("ask_team", { question: QUESTION, buyer_words: "", must_have: true }, await ctxFor(acc, c));
    qs = await unansweredQuestions(db, acc.id);
    expect(qs).toHaveLength(1);
    expect(qs[0].asks[0]).toMatchObject({ mustHave: true, buyerWords: "on-site training in our city" });

    // Account-scoped: the other account sees nothing, and cannot log into this conversation.
    expect(await unansweredQuestions(db, other.id)).toEqual([]);
    expect(await runTool("ask_team", { question: "x?", buyer_words: "x", must_have: null }, await ctxFor(acc, c, other.id))).toMatchObject({ outcome: "refused", rule: "Conversation not found" });
    expect(await runTool("ask_team", { question: "  ", buyer_words: "x", must_have: null }, await ctxFor(acc, c))).toMatchObject({ outcome: "refused", rule: "No question" });

    // The old hand-off is gone from the prompt and the tool's no-result message.
    const system = llm.requests[0].system as unknown as string[];
    expect(system[0]).toContain("call ask_team with the question, the buyer's own words and must_have");
    expect(system[0]).not.toContain("the team sees the question in their list; do nothing more");
    const lookup = calls.find((x) => x.name === "lookup_knowledge")!;
    expect(String(lookup.result.message)).toContain("call ask_team");
    expect(String(lookup.result.message)).not.toMatch(/hand_off|pass you|colleague/);
  });

  it("shows the question in Needs you as a question to answer, linked to Knowledge's answer panel; test chats stay out", async () => {
    const c = await mkChat(acc, "Dana Q");
    await runTool("ask_team", { question: "Can it run on 110V?", buyer_words: "will it work on 110 volt", must_have: false }, await ctxFor(acc, c));
    const test = (await startTestConversation(db, acc.id, me.id, { language: "en" }))!;
    await runTool("ask_team", { question: "Test lab only question?", buyer_words: "t", must_have: null }, await ctxFor(acc, test));

    const items = await needsYou(db, acc.id, new Date());
    const item = items.find((i) => i.kind === "team_question" && i.leadId === c.leadId);
    expect(item).toMatchObject({ kind: "team_question", question: "Can it run on 110V?", buyerWords: "will it work on 110 volt", mustHave: false, leadName: "Dana Q", conversationId: c.conversationId });
    expect(items.some((i) => i.kind === "team_question" && i.leadId === test.leadId)).toBe(false);
    expect(items.some((i) => i.kind === "human_handling" && i.leadId === c.leadId)).toBe(false);
    expect(await needsYouCount(db, acc.id, new Date())).toBe(items.length);
    expect(needsYouHref("/app/x", item!)).toBe("/app/x/setup/knowledge?panel=answer&question=Can+it+run+on+110V%3F");
    expect((await needsYou(db, other.id, new Date())).some((i) => i.kind === "team_question")).toBe(false);

    const html = await page(OverviewPage, { account: acc.slug });
    expect(html).toContain("Question to answer: Can it run on 110V?");
    expect(html).toContain("Good to know");
    expect(html).toContain(`/app/${acc.slug}/setup/knowledge?panel=answer&amp;question=Can+it+run+on+110V%3F`);

    // Knowledge: the list and the answer panel show the lead, the flag and the words; the test chat says so.
    const k = await page(KnowledgePage, { account: acc.slug }, { panel: "answer", question: "Can it run on 110V?" });
    expect(k).toContain("data-asked-by");
    expect(k).toContain(`href="/app/${acc.slug}/leads/${c.leadId}"`);
    expect(k).toContain("“will it work on 110 volt”");
    expect(k).toContain("Test lab chat");
    expect(k).toContain("Your answer also goes back to the chats that asked.");
  });

  it("answering in Knowledge puts the answer into that conversation's turn context while the buyer is active", async () => {
    const c = await mkChat(acc);
    const now = new Date();
    await db.insert(messages).values({ accountId: acc.id, conversationId: c.conversationId, actor: "buyer", body: "Does the gateway need its own power socket?", language: "en", createdAt: new Date(now.getTime() - 10 * 60_000) });
    await runTool("ask_team", { question: "Does the gateway need its own power socket?", buyer_words: "own power socket", must_have: true }, await ctxFor(acc, c));
    expect(await teamQuestionsContext(db, acc.id, c.leadId, c.conversationId)).toContain('Sent to the team, no answer yet: "own power socket" (must-have).');

    const { answerQuestionsAction } = await import("@/app/app/[account]/setup/knowledge/actions");
    const f = new FormData();
    for (const [k, v] of Object.entries({ slug: acc.slug, filter: "", list: "", panel: "answer", "q.0.question": "Does the gateway need its own power socket?", "q.0.answer": "Yes, one standard socket within 1.5 m.", "q.0.topic": "Installation" })) f.set(k, v);
    await answerQuestionsAction(f).catch(() => undefined);

    // The buyer wrote 10 minutes ago: no message is sent; the agent has the answer in its context.
    expect(await appMessages(c.conversationId)).toHaveLength(0);
    const ctxText = await teamQuestionsContext(db, acc.id, c.leadId, c.conversationId);
    expect(ctxText).toContain(`Answer from the team to the buyer's question "own power socket": Yes, one standard socket within 1.5 m.`);
    expect(ctxText).not.toContain("no answer yet");
    expect(await teamQuestionsContext(db, other.id, c.leadId, c.conversationId)).toBe("");
    // Needs you drops it.
    expect((await needsYou(db, acc.id, new Date())).some((i) => i.kind === "team_question" && i.leadId === c.leadId)).toBe(false);

    // The next turn's system prompt carries it, next to the open objection.
    const llm = new ScriptedLlm([step(say("Yes, it needs one standard socket within 1.5 m. How many sites do you have?"))]);
    await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "OK, and what else?" });
    const system = llm.requests[0].system as unknown as string[];
    expect(system[1]).toContain("## Questions sent to the team");
    expect(system[1]).toContain("Yes, one standard socket within 1.5 m.");
    // The buyer wrote after the answer: the scheduler records it reached the chat and sends nothing.
    await runTeamAnswers(db, null, new Date(Date.now() + 6 * HOUR));
    expect(await delivered(c.leadId)).toEqual(["in_chat"]);
    expect(await appMessages(c.conversationId)).toHaveLength(0);
  });

  it("sends the answer to a quiet buyer only, inside contact hours, once", async () => {
    const quietAcc = await mkAccount("Quiet Co", MONDAY_NINE);
    const c = await mkChat(quietAcc, "Noa Quiet");
    const active = await mkChat(quietAcc, "Avi Active");
    // Monday 23 Nov 2026, 12:00 in Jerusalem (10:00 UTC): outside the 09:00-10:00 hours.
    const answeredAt = new Date("2026-11-23T10:00:00Z");
    await db.insert(messages).values([
      { accountId: quietAcc.id, conversationId: c.conversationId, actor: "buyer", body: "Is there a Hebrew manual?", language: "en", createdAt: new Date(answeredAt.getTime() - 5 * HOUR) },
      { accountId: quietAcc.id, conversationId: active.conversationId, actor: "buyer", body: "Is there a Hebrew manual?", language: "en", createdAt: new Date(answeredAt.getTime() - 30 * 60_000) },
    ]);
    for (const x of [c, active]) {
      await runTool("ask_team", { question: "Is there a Hebrew manual?", buyer_words: "a Hebrew manual", must_have: false }, await ctxFor(quietAcc, x));
    }
    await answerQuestion(db, actor(), quietAcc.id, { question: "Is there a Hebrew manual?", answer: "Yes, a Hebrew PDF manual comes with every order." }, { transport: null, now: answeredAt });
    // Outside contact hours: nothing yet, for either.
    expect(await appMessages(c.conversationId)).toHaveLength(0);
    expect(await appMessages(active.conversationId)).toHaveLength(0);

    // Next Monday 09:15 Jerusalem (07:15 UTC): inside hours. The quiet buyer gets it; the active one wrote 30 minutes before the answer…
    const inside = new Date("2026-11-30T07:15:00Z");
    // …and wrote again after it, so the agent had it in context: nothing is sent there.
    await db.insert(messages).values({ accountId: quietAcc.id, conversationId: active.conversationId, actor: "buyer", body: "Thanks", language: "en", createdAt: new Date(answeredAt.getTime() + 5 * 60_000) });
    const s1 = await runTeamAnswers(db, null, inside);
    expect(s1.sent).toBeGreaterThanOrEqual(1);
    const sent = await appMessages(c.conversationId);
    expect(sent).toHaveLength(1);
    const [m] = await db.select().from(messages).where(eq(messages.id, sent[0].messageId!));
    expect(m).toMatchObject({ actor: "agent", body: 'Hi Noa, you asked: "a Hebrew manual". The answer: Yes, a Hebrew PDF manual comes with every order.' });
    expect(await appMessages(active.conversationId)).toHaveLength(0);
    expect(await delivered(c.leadId)).toEqual(["sent"]);
    expect(await delivered(active.leadId)).toEqual(["in_chat"]);

    // Once: later runs send nothing more.
    await runTeamAnswers(db, null, new Date(inside.getTime() + 10 * 60_000));
    await runTeamAnswers(db, null, new Date(inside.getTime() + 20 * 60_000));
    expect(await appMessages(c.conversationId)).toHaveLength(1);
    // The agent's context says it was sent.
    expect(await teamQuestionsContext(db, quietAcc.id, c.leadId, c.conversationId, inside)).toContain("already sent to the buyer");
    // The lead page timeline shows the question.
    as(quietAcc);
    const html = await page(LeadCardPage, { account: quietAcc.slug, leadId: c.leadId });
    expect(html).toContain("Question sent to the team");
    expect(html).toContain("Team&#x27;s answer reached the chat");
    as(acc);
  });

  it("the scenario \"Question with no approved answer\" passes on park and continue, with no hand-off", async () => {
    const test = (await startTestConversation(db, acc.id, me.id, { language: "en", scenario: "no_approved_answer" }))!;
    await runBuyerTurn(db, parkTurn("On-site training in the buyer's city: offered, and how long?"), { accountId: acc.id, conversationId: test.conversationId, text: "Do you offer on-site training in our city, and how long does it take?" });
    expect(await conversationScenarioCheck(db, acc.id, (await getConversation(db, acc.id, test.conversationId))!)).toMatchObject({ result: "passed" });

    // The old behaviour (hand off on the unknown question) fails it.
    const old = (await startTestConversation(db, acc.id, me.id, { language: "en", scenario: "no_approved_answer" }))!;
    await runBuyerTurn(db, new ScriptedLlm([
      step(use("k", "lookup_knowledge", { query: "zzz qqq nothing" })),
      step(use("h", "hand_off_to_human", { reason: "no approved answer", summary: "", suggested_reply: "" })),
      step(say("I don't know, I'll pass you to a colleague.")),
    ]), { accountId: acc.id, conversationId: old.conversationId, text: "Do you offer on-site training in our city, and how long does it take?" });
    expect(await conversationScenarioCheck(db, acc.id, (await getConversation(db, acc.id, old.conversationId))!)).toMatchObject({ result: "failed" });
  });

  it("ask_team converts through the voice tool schema", () => {
    const def = TOOL_DEFS.find((d) => d.name === "ask_team")!;
    expect(def.input_schema).toMatchObject({ required: ["question", "buyer_words", "must_have"] });
    const gemini = realtimeTools("gemini").find((d) => d.name === "ask_team")!;
    expect(gemini.parameters).toEqual({
      type: "object",
      properties: {
        question: { type: "string", description: expect.any(String) },
        buyer_words: { type: "string", description: expect.any(String) },
        must_have: { type: "boolean", description: expect.any(String), nullable: true },
      },
      required: ["question", "buyer_words", "must_have"],
    });
    const openai = realtimeTools("openai").find((d) => d.name === "ask_team")!;
    expect((openai.parameters as { properties: Record<string, { type: unknown }> }).properties.must_have.type).toEqual(["boolean", "null"]);
    expect(openai.description).toContain("silently");
    expect(VOICE_TOOL_NAMES.has("ask_team")).toBe(true);
    // No call-screen label yet (lib/voice is the Voice session's): the generic one shows.
    expect(toolLabel("ask_team")).toBe("Checking");
    // The voice version of the method keeps the new line (no chat-only wording to replace).
    expect(coreDesign({ tradeName: "Polar", meeting: false }, undefined, "voice")).toContain("call ask_team with the question");
  });
});
