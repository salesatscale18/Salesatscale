/**
 * Tool history (owner, 26 Nov): a chat turn sends the model every earlier tool call of the conversation, with its
 * exact input and the result the model got, as tool_use / tool_result blocks in order (lib/agent/history.ts).
 * Calls stored by a voice call replay in the next chat turn; a call turn's own history stays text only.
 * The figure check allows an earlier result's figures and still withholds a held quote's. Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { agentVersions, conversations, messages, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { buildRequestParams, countCacheBreakpoints, ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { resultForModel } from "@/lib/agent/tools";
import { historyToolUseId, replayedResult } from "@/lib/agent/history";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createVoiceSession } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

type Loose = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; cache_control?: unknown };
const say = (text: string) => () => ({ content: [{ type: "text", text } as Block] });
const use = (id: string, name: string, input: unknown) => () => ({ content: [{ type: "tool_use", id, name, input } as Block] });
const blocks = (req: LlmRequest) => req.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Loose[]).map((b) => ({ role: m.role, ...b })) : [{ role: m.role, type: "text", text: m.content as string }]));
const lastUserText = (req: LlmRequest) => {
  const m = req.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : (m.content as Loose[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
};
const lastResult = (req: LlmRequest) => JSON.parse(String(((req.messages.at(-1)!.content as Loose[])[0]).content)) as Record<string, unknown>;

const OFFERS: StoredOffer[] = [
  { type: "smaller_start", on: false },
  { type: "more_units", on: false, percentBp: 500, minUnits: 10 },
  { type: "decide_now", on: false, percentBp: 800 },
  { type: "general", on: true, percentBp: 500 },
  { type: "pay_yearly", on: false, percentBp: 800 },
];
const LINES = [{ sku: "SNS-200", qty: 2 }];
const dealState = (more: Record<string, unknown> = {}) => ({ updates: [], next_step: null, objection: null, recommendation_confirmed: true, price_asked: true, asked: null, ...more });
const quoteInput = (more: Record<string, unknown> = {}) => ({ lines: LINES, discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null, ...more });

describe("tool history in chat turns", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "th@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "th-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id });
    const { sellerAccounts } = await import("@/db/schema");
    await db.update(sellerAccounts).set({ maxDiscountBp: 500 }).where(eq(sellerAccounts.id, acc));
    const d = await ensureDraftVersion(db, acc);
    const pb: PlaybookWithOffers = { ...d.playbook, fields: [], maxDiscountBp: 500, offers: OFFERS, exceptions: [{ id: "exc1", text: "Free installation from 3 sites", approvedAt: "2026-11-20T10:00:00Z", approvedBy: null }] };
    await saveDraftPlaybook(db, acc, pb);
  });
  afterAll(async () => t.close());

  const conv = async () => (await startTestConversation(db, acc, me.id, { language: "en" }))!;
  const turn = (conversationId: string, llm: ScriptedLlm, text: string) => runBuyerTurn(db, llm, { accountId: acc, conversationId, text });
  const rows = (conversationId: string) => db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));

  it("turn 3 sees turn 1's tool calls and their exact results, paired and in order, before turn 1's reply", async () => {
    const c = await conv();
    let quote = "";
    const t1 = new ScriptedLlm([
      use("a1", "update_deal_state", dealState({ objection: { play: "too_expensive", buyer_words: "too expensive", step: 1, attempt: false, status: "open" } })),
      use("a2", "create_quote", quoteInput()),
      (req) => { quote = String(lastResult(req).quote).split(" ")[0]; return use("a3", "check_offer", { quote, reason: "next", lines: null, sites: null })(); },
      (req) => {
        const offer = lastResult(req).offer as { totals: { total_today_including_vat: string } };
        return say(`I can take 5% off: ${offer.totals.total_today_including_vat} including VAT. Shall I update the quote?`)();
      },
    ]);
    const r1 = await turn(c.conversationId, t1, "Two sensors please, but it is too expensive.");
    expect(r1.status).toBe("replied");
    const t2 = new ScriptedLlm([say("Sure, take your time.")]);
    await turn(c.conversationId, t2, "Let me think.");
    const stored = await rows(c.conversationId);
    expect(stored.map((s) => s.name)).toEqual(["update_deal_state", "create_quote", "check_offer"]);
    const offerRow = stored[2];
    expect((offerRow.result.offer as { offer_id?: string } | null)?.offer_id).toBeTruthy();
    const total = (offerRow.result.offer as { totals: { total_today_including_vat: string } }).totals.total_today_including_vat;

    // Turn 3 states the offer's figure from turn 1's result: allowed now (no regeneration).
    const t3 = new ScriptedLlm([say(`Yes, the offer stands: ${total} including VAT.`)]);
    const r3 = await turn(c.conversationId, t3, "Is the offer still on?");
    expect(r3).toMatchObject({ status: "replied", text: `Yes, the offer stands: ${total} including VAT.` });
    expect(t3.requests).toHaveLength(1);
    const req = t3.requests[0];
    const all = blocks(req);
    const uses = all.filter((b) => b.type === "tool_use");
    const results = all.filter((b) => b.type === "tool_result");
    expect(uses.map((u) => [u.name, u.id])).toEqual(stored.map((s) => [s.name, historyToolUseId(s.id)]));
    expect(uses.map((u) => u.input)).toEqual(stored.map((s) => s.input));
    expect(results.map((r) => r.tool_use_id)).toEqual(uses.map((u) => u.id));
    expect(results.map((r) => r.content)).toEqual(stored.map((s) => JSON.stringify(replayedResult(s))));
    // The earlier update_deal_state result is replayed without its stale stage block (the current one is in the context).
    expect(stored[0].result.stage).toMatch(/^## Stage now/);
    expect(results[0].content).not.toContain("Stage now");
    expect(JSON.parse(String(results[0].content))).toEqual((({ stage: _s, ...rest }) => rest)(stored[0].result));
    // The order of the whole history: buyer 1, calls, the quote card create_quote posted, reply 1, buyer 2, reply 2, buyer 3.
    const texts = all.filter((b) => b.type === "text" || b.type === "tool_use").map((b) => (b.type === "tool_use" ? `use:${b.name}` : `${b.role}:${b.text?.split("\n")[0]}`));
    expect(texts).toEqual([
      "user:Two sensors please, but it is too expensive.",
      "use:update_deal_state", "use:create_quote", "use:check_offer",
      `assistant:*Quote ${quote}*`,
      `assistant:${r1.status === "replied" ? r1.text : ""}`,
      "user:Let me think.", "assistant:Sure, take your time.", "user:Is the offer still on?",
    ]);
    // Every tool_use is followed at once by the user message with its result (the API's pairing rule).
    req.messages.forEach((m, i) => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return;
      const ids = (m.content as Loose[]).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (!ids.length) return;
      const next = req.messages[i + 1].content as Loose[];
      expect(next.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)).toEqual(ids);
    });
    // Caching: the system breakpoint, the per-turn context (last block, after the history), the history's end (the
    // buyer's latest message) and the previous turn's history end ("Let me think."); none on other replayed blocks.
    const params = buildRequestParams(req);
    expect(countCacheBreakpoints(params)).toBe(4);
    expect(params.system).toHaveLength(1);
    const last = params.messages.at(-1)!.content as Loose[];
    expect(last.map((b) => [b.text?.slice(0, 20), !!b.cache_control])).toEqual([["Is the offer still o", true], [req.system[1].slice(0, 20), true]]);
    const marked = params.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Loose[]) : [])).filter((b) => b.cache_control).map((b) => b.text?.slice(0, 20));
    expect(marked).toEqual(["Let me think.", "Is the offer still o", req.system[1].slice(0, 20)]);
  });

  it("a failed tool and a refusal are replayed as they were, the failure marked as an error", async () => {
    const c = await conv();
    const t1 = new ScriptedLlm([
      use("b1", "send_order_form", { quote: "Q-9999" }),
      use("b2", "no_such_tool_any_more", { x: 1 }),
      say("Let me check that with the team."),
    ]);
    await turn(c.conversationId, t1, "Send me the form.");
    const stored = await rows(c.conversationId);
    expect(stored.map((s) => [s.name, s.outcome])).toEqual([["send_order_form", "refused"], ["no_such_tool_any_more", "failed"]]);
    const t2 = new ScriptedLlm([say("Okay.")]);
    await turn(c.conversationId, t2, "Thanks.");
    const all = blocks(t2.requests[0]);
    const results = all.filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: historyToolUseId(stored[0].id), content: JSON.stringify(stored[0].result) });
    expect(results[0].is_error).toBeUndefined();
    // A tool the request does not define is shown as a text line in its place, never as a tool_use.
    expect(all.some((b) => b.type === "tool_use" && b.name === "no_such_tool_any_more")).toBe(false);
    const asText = all.find((b) => b.type === "text" && b.text?.includes("no_such_tool_any_more"));
    expect(asText).toMatchObject({ role: "user" });
    expect(asText!.text).toContain(`-> failed: ${JSON.stringify(stored[1].result)}`);
  });

  it("a failed tool (an error thrown) replays with is_error", async () => {
    const c = await conv();
    const t1 = new ScriptedLlm([say("Hello there.")]);
    await turn(c.conversationId, t1, "Hi");
    const [agent] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.body, "Hello there.")));
    const result = { ok: false, error: "The tool failed. Tell the buyer you will check and get back to them." };
    await db.insert(toolCalls).values({ accountId: acc, conversationId: c.conversationId, messageId: agent.id, sequence: 1, name: "check_payment", input: {}, result, outcome: "failed" });
    const t2 = new ScriptedLlm([say("Okay.")]);
    await turn(c.conversationId, t2, "Did my payment go through?");
    const [r] = blocks(t2.requests[0]).filter((b) => b.type === "tool_result");
    expect(r).toMatchObject({ content: JSON.stringify(result), is_error: true });
  });

  it("an old conversation without stored calls keeps its text lines", async () => {
    const c = await conv();
    const [conv0] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, conv0.agentVersionId));
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "Old question" });
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "agent", body: "Old answer", agentVersionId: version.id });
    const llm = new ScriptedLlm([say("Okay.")]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "New question" });
    expect(llm.requests[0].messages.map((m) => [m.role, typeof m.content === "string" ? m.content : (m.content as Loose[]).map((b) => b.text).join("")]))
      .toEqual([["user", "Old question"], ["assistant", "Old answer"], ["user", "New question"]]);
  });

  it("a held quote from an earlier turn: its figures stay blocked", async () => {
    const c = await conv();
    const t1 = new ScriptedLlm([
      use("h1", "update_deal_state", dealState()),
      use("h2", "create_quote", quoteInput({ exception: "exc1" })),
      say("I've asked the team to approve it."),
    ]);
    await turn(c.conversationId, t1, "Two sensors, with the free installation.");
    const [held] = (await rows(c.conversationId)).filter((s) => s.name === "create_quote");
    expect(held.result).toMatchObject({ status: "awaiting_seller_approval", lines: [{ total_before_vat: "₪1,180.00" }] });
    const t2 = new ScriptedLlm([say("The sensors come to ₪1,180.00 before VAT."), say("The team will confirm the price.")]);
    const r = await turn(c.conversationId, t2, "What is the price?");
    expect(r).toMatchObject({ status: "replied", text: "The team will confirm the price." });
    expect(lastUserText(t2.requests[1])).toMatch(/Your reply states 1,180\.00, but the quote waits for the team's approval/);
    // The held quote's call is in the history all the same.
    expect(blocks(t2.requests[0]).filter((b) => b.type === "tool_use").map((b) => b.name)).toEqual(["update_deal_state", "create_quote"]);
  });

  it("strict mode with a long history: the first call's mode is sent on every round", async () => {
    const c = await conv();
    for (let i = 0; i < 6; i++) {
      await turn(c.conversationId, new ScriptedLlm([use(`s${i}`, "search_catalog", { query: "sensor" }), say(`Answer ${i}.`)]), `Question ${i}`);
    }
    const llm = new ScriptedLlm([
      () => ({ content: [{ type: "tool_use", id: "x1", name: "search_catalog", input: { query: "" } } as Block], strictTools: false }),
      say("Done."),
    ]);
    await turn(c.conversationId, llm, "One more");
    expect(blocks(llm.requests[0]).filter((b) => b.type === "tool_use")).toHaveLength(6);
    expect(llm.requests[0].strictTools).toBeUndefined();
    expect(llm.requests[1].strictTools).toBe(false);
    expect(llm.requests[1].tools).toEqual(llm.requests[0].tools);
  });

  it("chat, then a call that checked an offer, then chat: the call's check_offer is in the chat request, in order", async () => {
    const c = await conv();
    await turn(c.conversationId, new ScriptedLlm([say("Happy to help.")]), "Hello");
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const [conv0] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "Any discount?", voiceSessionId: s.sessionId });
    const [line] = await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "agent", body: "I can take 5% off.", agentVersionId: conv0.agentVersionId, voiceSessionId: s.sessionId }).returning();
    const result = { ok: true, offer: { offer_id: "OF-abc123", trade: "general", totals: { total_today_including_vat: "₪1,331.04" } }, record: { binding: true }, message: "Offer this as a trade." };
    const [row] = await db.insert(toolCalls).values({ accountId: acc, conversationId: c.conversationId, messageId: line.id, sequence: 1, name: "check_offer", input: { quote: "Q-1001", reason: "next" }, result, outcome: "ok" }).returning();
    // A voice-only tool stored by the call is shown as text.
    await db.insert(toolCalls).values({ accountId: acc, conversationId: c.conversationId, messageId: line.id, sequence: 2, name: "end_call", input: {}, result: { ok: true }, outcome: "ok" });
    await db.update(voiceSessions).set({ status: "ended" }).where(eq(voiceSessions.id, s.sessionId));

    const llm = new ScriptedLlm([say("Yes: ₪1,331.04 including VAT.")]);
    const r = await turn(c.conversationId, llm, "Is the 5% still on?");
    expect(r).toMatchObject({ status: "replied", text: "Yes: ₪1,331.04 including VAT." });
    const all = blocks(llm.requests[0]);
    const seq = all.map((b) => (b.type === "tool_use" ? `use:${b.name}` : b.type === "tool_result" ? `result:${b.tool_use_id}` : `${b.role}:${(b.text ?? "").slice(0, 40)}`));
    expect(seq).toEqual([
      "user:Hello", "assistant:Happy to help.", "user:(On the voice call) Any discount?",
      "use:check_offer", `result:${historyToolUseId(row.id)}`,
      "user:[From the system, not from the buyer] An",
      "assistant:I can take 5% off.", "user:Is the 5% still on?",
    ]);
    // The stored result, as the model reads results (the binding record taken off); jsonb keeps the values, not the key order.
    expect(JSON.parse(String(all.find((b) => b.type === "tool_result")!.content))).toEqual(resultForModel(result));
  });

  it("a call turn (callSessionId) keeps its text-only history", async () => {
    const c = await conv();
    await turn(c.conversationId, new ScriptedLlm([use("v1", "search_catalog", { query: "sensor" }), say("We have a sensor.")]), "What do you sell?");
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    await db.update(voiceSessions).set({ status: "live" }).where(eq(voiceSessions.id, s.sessionId));
    const llm = new ScriptedLlm([say("Sure.")]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId: c.conversationId, text: "Tell me more", callSessionId: s.sessionId });
    expect(llm.requests[0].messages.map((m) => [m.role, typeof m.content === "string" ? m.content : (m.content as Loose[]).map((b) => b.type)]))
      .toEqual([["user", "What do you sell?"], ["assistant", "We have a sensor."], ["user", ["text"]]]);
  });
});
