/**
 * When an ask counts (update_deal_state `asked`, fix of the 23 Nov 2026 call): a repeat of a field still
 * unknown counts only after the buyer had a real chance to answer it. The two observed faults (an ask
 * recorded before the question was put; a second record after the buyer replied with a question of their
 * own) no longer make "asked twice"; a real non-answer twice still does; the ceiling still holds.
 * Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { askedCount, endsWithQuestion, repeatAskCounts } from "@/lib/agent/core/facts";
import { agentQuestionsAsked, QUESTION_CEILING } from "@/lib/agent/core/stage";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, readDealState, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const ask = (keys: string[]) => ({ updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: keys });
const lastToolResult = (req: LlmRequest) => JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
const pause = () => new Promise((r) => setTimeout(r, 3));

describe("asked counter", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "a@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      fields: [
        { key: "sites", label: "Number of sites", stage: "before_quote" },
        { key: "business_type", label: "Business type", stage: "before_quote" },
        { key: "fridges", label: "Number of fridges", stage: "before_quote" },
        { key: "current_monitoring", label: "How they check today", stage: "optional" },
      ],
    });
  });
  afterAll(async () => t.close());

  const newConv = async () => (await startTestConversation(db, acc, me.id, { language: "en" }))!;
  const sitesAsked = async (leadId: string) => askedCount((await readDealState(db, acc, leadId))!.fields, "sites");
  /** One chat turn: the agent records `keys` as asked, then replies with `reply`. Returns the update_deal_state result. */
  const turn = async (conversationId: string, buyer: string, keys: string[], reply: string) => {
    await pause();
    let result: Record<string, unknown> = {};
    const llm = new ScriptedLlm([
      () => ({ content: [use("u", "update_deal_state", ask(keys))] }),
      (req) => { result = lastToolResult(req); return { content: [say(reply)] }; },
    ]);
    expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: buyer })).status).toBe("replied");
    return result;
  };

  it("unit: a question of the buyer's own, and when a repeat counts", () => {
    expect(endsWithQuestion("Does it work with walk-in freezers?")).toBe(true);
    expect(endsWithQuestion("Does it work with freezers? 🙂")).toBe(true);
    expect(endsWithQuestion("זה עובד עם מקפיאים?")).toBe(true);
    expect(endsWithQuestion("I'm not sure.")).toBe(false);
    expect(endsWithQuestion("Why? I just want the price")).toBe(false);
    expect(repeatAskCounts([])).toBe(false);
    expect(repeatAskCounts(["How long is the battery life?"])).toBe(false);
    expect(repeatAskCounts(["How long is the battery life?", "And the warranty?"])).toBe(false);
    expect(repeatAskCounts(["Not sure."])).toBe(true);
    expect(repeatAskCounts(["How long?", "ok"])).toBe(true);
    expect(repeatAskCounts(["A?", "B?", "C?"])).toBe(true);
  });

  it("fault 1 + 2: recorded before the question was put, then again after the buyer's own question: still asked once", async () => {
    const c = await newConv();
    // Turn 1: the agent records sites although its reply asks something else (the ask was not put yet).
    await turn(c.conversationId, "Hi, we need fridge sensors.", ["sites"], "Happy to help. What kind of business is it?");
    expect(await sitesAsked(c.leadId)).toBe(1);
    // Turn 2: the buyer answers with a question of their own; the agent answers and now really asks sites.
    const r2 = await turn(c.conversationId, "Do they work with walk-in freezers?", ["sites"], "Yes, they do. How many sites do you have?");
    expect(r2).not.toHaveProperty("recorded_as_asked");
    expect(await sitesAsked(c.leadId)).toBe(1);
    expect(String(r2.stage)).toContain("Number of sites (asked once; needed for the quote: ask once more, in different words, just before the quote)");
    expect(String(r2.stage)).not.toContain("quote on a stated assumption");
    // The same within one turn: a second update_deal_state never counts twice.
    const r3 = await turn(c.conversationId, "OK. And how long does the battery last?", ["sites"], "About five years. How many locations is that for?");
    // "OK. And …?" is still a question of the buyer's own: one more line, not yet a chance.
    expect(r3).not.toHaveProperty("recorded_as_asked");
    expect(await sitesAsked(c.leadId)).toBe(1);
  });

  it("a real non-answer twice still counts twice and moves to quoting on an assumption", async () => {
    const c = await newConv();
    const r1 = await turn(c.conversationId, "Hi, we need fridge sensors.", ["sites"], "How many sites do you have?");
    expect(r1).toMatchObject({ recorded_as_asked: ["sites"] });
    const r2 = await turn(c.conversationId, "We'll see, depends.", ["sites"], "Roughly how many locations would it be for?");
    expect(r2).toMatchObject({ recorded_as_asked: ["sites"] });
    expect(await sitesAsked(c.leadId)).toBe(2);
    expect(String(r2.stage)).toContain("Number of sites (asked twice; needed for the quote: do not ask again; quote on a stated assumption)");
  });

  it("a buyer who answers only with questions does not keep the agent asking forever", async () => {
    const c = await newConv();
    await turn(c.conversationId, "Hi.", ["sites"], "How many sites do you have?");
    expect((await turn(c.conversationId, "What does it cost?", ["sites"], "It depends on the sites. How many?"))).not.toHaveProperty("recorded_as_asked");
    expect((await turn(c.conversationId, "Is there a warranty?", ["sites"], "Yes, two years. How many sites?"))).not.toHaveProperty("recorded_as_asked");
    // The third question since the counted ask: the buyer had their chances, the repeat counts.
    expect(await turn(c.conversationId, "Do you install it?", ["sites"], "We do. How many sites?")).toMatchObject({ recorded_as_asked: ["sites"] });
    expect(await sitesAsked(c.leadId)).toBe(2);
  });

  it("a first ask always counts, a known field asked again counts as before, and the ceiling still holds", async () => {
    const c = await newConv();
    const ctx = (callId: string): ToolContext => ({
      db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: (c.version.playbook), currency: "ILS", callId, language: "en", memo: {}, agentMessages: 2,
    });
    const buyer = async (body: string) => {
      await pause();
      await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body, language: "en" });
      await pause();
    };
    // Four fields asked for the first time with no buyer line between: each first ask counts.
    expect(await runTool("update_deal_state", ask(["sites", "business_type", "fridges", "current_monitoring"]), ctx("c1"))).toMatchObject({ result: { recorded_as_asked: ["sites", "business_type", "fridges", "current_monitoring"] } });
    // Two non-answers, a repeat each: counted, and the total reaches the ceiling.
    await buyer("Hmm, not sure.");
    expect(await runTool("update_deal_state", ask(["sites"]), ctx("c2"))).toMatchObject({ result: { recorded_as_asked: ["sites"] } });
    await buyer("Let me think.");
    const last = await runTool("update_deal_state", ask(["business_type"]), ctx("c3"));
    expect(last).toMatchObject({ result: { recorded_as_asked: ["business_type"] } });
    const fields = (await readDealState(db, acc, c.leadId))!.fields;
    expect(agentQuestionsAsked(fields)).toBe(QUESTION_CEILING);
    expect(String(last.result.stage)).not.toMatch(/^## Stage now: Understand/);
    // A field the buyer already gave, asked again (e.g. to confirm): counts as before, with no buyer line between.
    await runTool("update_deal_state", { ...ask([]), updates: [{ key: "fridges", value: "6", provenance: "buyer" }] }, ctx("c4"));
    expect(await runTool("update_deal_state", ask(["fridges"]), ctx("c5"))).toMatchObject({ result: { recorded_as_asked: ["fridges"] } });
  });
});
