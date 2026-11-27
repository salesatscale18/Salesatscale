/**
 * Agent memory (owner decisions 1-6, 27 Nov, agreed with the Voice session). Scripted model only:
 * - the per-turn context goes after the history, and the cache breakpoints let turn N+1 read turn N's history;
 * - renderHistoryText gives the same entries, in the same order, as the next chat turn replays;
 * - the facts builder and renderer (quotes, offers, order form; a held quote's figures stay blocked), and the facts'
 *   figures in the reply check;
 * - check_offer `standing_offer`, create_quote `matching_offer` and `missing`;
 * - the neutral OFFER_OK_MESSAGE and the quote argument descriptions without the "Q-1001" example.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { conversations, orderForms, quotes, sellerAccounts, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { buildRequestParams, ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { OFFER_NONE_MESSAGE, OFFER_OK_MESSAGE, TOOL_DEFS } from "@/lib/agent/tools";
import { historySources, renderHistoryText, resultContent } from "@/lib/agent/history";
import { conversationFacts, renderConversationFacts } from "@/lib/agent/conversation-facts";
import { createQuote } from "@/lib/quotes/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

type Loose = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; cache_control?: unknown };
const say = (text: string) => () => ({ content: [{ type: "text", text } as Block] });
const use = (id: string, name: string, input: unknown) => () => ({ content: [{ type: "tool_use", id, name, input } as Block] });
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
const objection = dealState({ objection: { play: "too_expensive", buyer_words: "too expensive", step: 1, attempt: false, status: "open" } });

/** A block without its cache flag (the cached prefix is the content, not where the breakpoints are). */
const plain = (m: Anthropic.Beta.BetaMessageParam) => ({
  role: m.role,
  content: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Loose[])).map(({ cache_control: _c, ...b }) => { void _c; return b; }),
});
/** A rough token count for the report: characters / 4 (no tokenizer offline; the API was not called). */
const approxTokens = (v: unknown) => Math.round(JSON.stringify(v).length / 4);

describe("agent memory", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "am@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "am-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id });
    await db.update(sellerAccounts).set({ maxDiscountBp: 500 }).where(eq(sellerAccounts.id, acc));
    const d = await ensureDraftVersion(db, acc);
    const pb: PlaybookWithOffers = { ...d.playbook, fields: [], maxDiscountBp: 500, offers: OFFERS, exceptions: [{ id: "exc1", text: "Free installation from 3 sites", approvedAt: "2026-11-20T10:00:00Z", approvedBy: null }] };
    await saveDraftPlaybook(db, acc, pb);
  });
  afterAll(async () => t.close());

  const conv = async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const [row] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    return { id: c.conversationId, leadId: row.leadId };
  };
  const turn = (conversationId: string, llm: ScriptedLlm, text: string) => runBuyerTurn(db, llm, { accountId: acc, conversationId, text });
  const rows = (conversationId: string) => db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));

  it("the per-turn context comes after the history; turn N+1's request starts with turn N's cached history", async () => {
    const c = await conv();
    const turns: ScriptedLlm[] = [
      new ScriptedLlm([use("a1", "update_deal_state", dealState()), use("a2", "create_quote", quoteInput()), say("Here is your quote. Shall I send the order form?")]),
      new ScriptedLlm([say("Sure, take your time.")]),
      new ScriptedLlm([use("c1", "search_catalog", { query: "sensor" }), say("It is a wireless sensor.")]),
      new ScriptedLlm([say("Happy to help.")]),
    ];
    const texts = ["Two sensors please.", "Let me think.", "What is the sensor like?", "Thanks."];
    const report: string[] = [];
    for (let i = 0; i < turns.length; i++) await turn(c.id, turns[i], texts[i]);
    const firsts = turns.map((l) => l.requests[0]);
    for (const [i, req] of firsts.entries()) {
      const params = buildRequestParams(req);
      // One system block (stable, cached); the per-turn context is the last block of the buyer's message, unchanged.
      expect(params.system).toHaveLength(1);
      expect((params.system as Loose[])[0].cache_control).toEqual({ type: "ephemeral" });
      expect(req.historyLength).toBe(req.messages.length);
      const last = params.messages.at(-1)!.content as Loose[];
      expect(last.at(-1)).toEqual({ type: "text", text: req.system[1], cache_control: { type: "ephemeral" } });
      expect(last.at(-2)).toMatchObject({ type: "text", text: texts[i], cache_control: { type: "ephemeral" } });
      // Turn N+1 starts with turn N's history (up to and including turn N's buyer message), byte for byte.
      if (i > 0) {
        const prev = firsts[i - 1];
        const prevEnd = prev.messages.length - 1;
        const prevPrefix = prev.messages.slice(0, prevEnd + 1).map(plain);
        expect(req.messages.slice(0, prevEnd + 1).map(plain)).toEqual(prevPrefix);
        // ...and puts a breakpoint where turn N wrote its cache (turn N's buyer message): previousHistoryEnd.
        expect(req.previousHistoryEnd).toBe(prevEnd);
        expect((params.messages[prevEnd].content as Loose[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
      }
      const marks = params.messages.flatMap((m, mi) => (Array.isArray(m.content) ? (m.content as Loose[]) : []).flatMap((b, bi) => (b.cache_control ? [`${mi}.${bi}`] : [])));
      expect(marks.length + 1).toBeLessThanOrEqual(4);
      const history = params.messages.map((m, mi) => (mi === params.messages.length - 1 ? { ...m, content: (m.content as Loose[]).slice(0, -1) } : m));
      report.push(`turn ${i + 1}: stable+tools ~${approxTokens([params.system, params.tools])} tok, history ~${approxTokens(history)} tok (${req.messages.length} messages), per-turn context ~${approxTokens(req.system[1])} tok; breakpoints: system, ${marks.map((m) => `messages[${m}]`).join(", ")}`);
    }
    // Later rounds of a turn: the moving breakpoint goes to the last tool result; the history end keeps its own.
    const round2 = buildRequestParams(turns[2].requests[1]);
    const lastBlocks = params2Last(round2);
    expect(lastBlocks.at(-1)).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } });
    console.log(`[agent-memory] approx token counts (chars/4) per turn's first request:\n${report.join("\n")}`);
  });
  const params2Last = (p: ReturnType<typeof buildRequestParams>) => p.messages.at(-1)!.content as Loose[];

  it("renderHistoryText: the same entries, in the same order, as the next chat turn replays (calls with their results)", async () => {
    const c = await conv();
    await turn(c.id, new ScriptedLlm([use("r1", "update_deal_state", dealState()), use("r2", "create_quote", quoteInput()), say("Here you go.")]), "Two sensors please.");
    await turn(c.id, new ScriptedLlm([use("r3", "search_catalog", { query: "sensor" }), say("It runs on batteries.")]), "How is it powered?");
    const src = await historySources(db, acc, c.id);
    const text = renderHistoryText(src.recent, src.calls);
    const next = new ScriptedLlm([say("Okay.")]);
    await turn(c.id, next, "Thanks.");
    const req = next.requests[0];
    const stored = await rows(c.id);
    const outcomeOf = new Map(stored.map((s) => [s.name + JSON.stringify(s.input), s]));
    // The request's history (without this turn's buyer message), as lines.
    const results = new Map(req.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Loose[]) : [])).filter((b) => b.type === "tool_result").map((b) => [b.tool_use_id, b.content]));
    const expected = req.messages.slice(0, -1).flatMap((m) => {
      if (typeof m.content === "string") return [`${m.role === "user" ? "Buyer" : "Agent"}: ${m.content}`];
      return (m.content as Loose[]).filter((b) => b.type === "tool_use").map((b) => {
        const row = outcomeOf.get(b.name! + JSON.stringify(b.input))!;
        return `Tool call: ${b.name} ${JSON.stringify(b.input)} -> ${row.outcome}: ${results.get(b.id)}`;
      });
    });
    expect(text).toBe(expected.join("\n"));
    expect(text).toContain("Tool call: create_quote");
    expect(text).not.toContain("Stage now");
    expect(text.startsWith("Buyer: Two sensors please.\nTool call: update_deal_state ")).toBe(true);
    // The row's content is the history's content (resultContent).
    const quoteRow = stored.find((s) => s.name === "create_quote")!;
    expect(text).toContain(`-> ok: ${resultContent(quoteRow)}`);
  });

  it("check_offer: standing_offer when nothing more can be offered; create_quote: missing and matching_offer", async () => {
    const c = await conv();
    let quote = "";
    let offerId = "";
    const llm = new ScriptedLlm([
      use("o1", "update_deal_state", objection),
      use("o2", "create_quote", quoteInput()),
      (req) => { quote = String(lastResult(req).quote).split(" ")[0]; return use("o3", "check_offer", { quote, reason: "next", lines: null, sites: null })(); },
      (req) => {
        const r = lastResult(req);
        expect(r.message).toBe(OFFER_OK_MESSAGE);
        expect(r.standing_offer).toBeUndefined();
        offerId = (r.offer as { offer_id: string }).offer_id;
        return use("o4", "check_offer", { quote, reason: "next", lines: null, sites: null })();
      },
      (req) => {
        const r = lastResult(req);
        expect(r).toMatchObject({ ok: true, offer: null, message: OFFER_NONE_MESSAGE, standing_offer: { id: offerId, terms: "5% off the one-time charges.", quote: `${quote} v1` } });
        expect(Object.keys(r.standing_offer as object).sort()).toEqual(["id", "quote", "terms"]);
        // 5% on other lines: the standing offer cannot be bound; the refusal names it, as data.
        return use("o5", "create_quote", quoteInput({ lines: [{ sku: "SNS-200", qty: 3 }], discount_percent: 5 }))();
      },
      (req) => {
        const r = lastResult(req);
        expect(r).toMatchObject({
          ok: false, refused: true, rule: "Discount not from an offer", missing: ["offer"],
          matching_offer: { id: offerId, terms: "5% off the one-time charges.", quote: `${quote} v1`, lines: [{ sku: "SNS-200", qty: 2 }] },
        });
        expect(r.message).toBe("A discount comes only from check_offer. Call it with the buyer's quote and reason, offer what it returns, and pass its offer id when the buyer accepts.");
        // 3%: no standing offer of that percent, so no matching_offer.
        return use("o6", "create_quote", quoteInput({ discount_percent: 3 }))();
      },
      (req) => {
        const r = lastResult(req);
        expect(r).toMatchObject({ ok: false, rule: "Discount not from an offer", missing: ["offer"] });
        expect(r.matching_offer).toBeUndefined();
        return say("Let me check.")();
      },
    ]);
    const r = await turn(c.id, llm, "Two sensors, but it is too expensive.");
    expect(r.status).toBe("replied");
    expect(llm.requests).toHaveLength(7);
  });

  it("facts: builder and renderer (quotes newest first, offers, order form; held quote without prices), in the per-turn context", async () => {
    const c = await conv();
    let quote = "";
    await turn(c.id, new ScriptedLlm([
      use("f1", "update_deal_state", objection),
      use("f2", "create_quote", quoteInput()),
      (req) => { quote = String(lastResult(req).quote).split(" ")[0]; return use("f3", "check_offer", { quote, reason: "next", lines: null, sites: null })(); },
      say("I can take 5% off."),
    ]), "Two sensors, but it is too expensive.");
    // A held quote, made by the app's service directly (no tool row): its figures are not the agent's to state.
    const held = await createQuote(db, acc, { kind: "agent" }, c.leadId, { lines: [{ sku: "SNS-200", qty: 3 }], discountBp: 0, exception: { id: "exc1", text: "Free installation from 3 sites" } });
    if (!held.ok) throw new Error(held.reason);
    expect(held.quote.status).toBe("awaiting_approval");
    const [first] = await db.select().from(quotes).where(eq(quotes.number, Number(quote.slice(2))));
    await db.insert(orderForms).values({
      id: randomUUID(), accountId: acc, leadId: c.leadId, quoteId: first.id, quoteVersionId: (await db.query.quoteVersions.findFirst({ where: (v, { eq: e }) => e(v.quoteId, first.id) }))!.id,
      tokenHash: `h-${c.id}`, language: "en", status: "opened", snapshot: {} as never, expiresAt: new Date(Date.now() + 86_400_000), createdBy: "agent",
    });

    const facts = await conversationFacts(db, acc, c.id);
    expect(facts.quotes.map((q) => [q.number, q.status, q.held])).toEqual([[`Q-${held.quote.number}`, "awaiting_approval", true], [quote, "sent", false]]);
    expect(facts.quotes[1]).toMatchObject({ version: 1, currency: "ILS", lines: [{ code: "SNS-200", name: "Wireless fridge sensor", qty: 2, charge: "one-time", price: "₪1,180.00" }], totals: { todayIncludingVat: "₪1,392.40", recurringIncludingVat: null, discountPercent: 0 } });
    expect(facts.quotes[1].validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(facts.offers).toEqual([{ id: expect.stringMatching(/^OF-/), terms: "5% off the one-time charges.", quote: `${quote} v1`, outcome: "offered" }]);
    expect(facts.orderForm).toEqual({ quote: `${quote} v1`, status: "opened", outdated: true, signed: false, paid: false });
    // Another account sees nothing.
    expect(await conversationFacts(db, "00000000-0000-0000-0000-000000000000", c.id)).toEqual({ quotes: [], offers: [], orderForm: null });

    const text = renderConversationFacts(facts);
    expect(text).toBe([
      "## Facts of this conversation",
      "Quotes (newest first):",
      `- Q-${held.quote.number} v1. Status: waiting for the seller's approval.`,
      "  Lines: 3 × SNS-200 (Wireless fridge sensor), one-time.",
      "  Totals: not final until the seller approves.",
      `- ${quote} v1. Status: sent to the buyer. Valid until: ${facts.quotes[1].validUntil}.`,
      "  Lines: 2 × SNS-200 (Wireless fridge sensor), one-time: ₪1,180.00.",
      "  Totals: today ₪1,392.40 including VAT.",
      "Offers made (oldest first):",
      `- ${facts.offers[0].id} on ${quote} v1: 5% off the one-time charges. Outcome: open.`,
      `Order form: for ${quote} v1, opened, not signed yet; for an earlier quote or version.`,
    ].join("\n"));
    // Labels only: no instructions.
    expect(text).not.toMatch(/\bcall\b|\bif the buyer\b|\bdo not\b|\btell\b/i);
    expect(renderConversationFacts({ quotes: [], offers: [], orderForm: null })).toBe("");

    // In the chat turn's per-turn context; the held quote's line price stays blocked in the reply.
    const llm = new ScriptedLlm([say("The three sensors come to ₪1,770.00 before VAT."), say("The team is checking that price.")]);
    const r = await turn(c.id, llm, "And the three?");
    expect(llm.requests[0].system[1]).toContain(text);
    expect(r).toMatchObject({ status: "replied", text: "The team is checking that price." });
  });

  it("facts figures are allowed in a reply: a quote no tool call of this conversation returned", async () => {
    const c = await conv();
    await turn(c.id, new ScriptedLlm([say("Hello!")]), "Hi");
    // Made outside the agent's tools (no tool row, no quote message): only the facts give its total.
    const q = await createQuote(db, acc, { kind: "agent" }, c.leadId, { lines: [{ sku: "SNS-200", qty: 1 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const llm = new ScriptedLlm([say("Your quote comes to ₪696.20 including VAT.")]);
    const r = await turn(c.id, llm, "What does my quote come to?");
    expect(r).toMatchObject({ status: "replied", text: "Your quote comes to ₪696.20 including VAT." });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].system[1]).toContain("Totals: today ₪696.20 including VAT.");
    // A figure from nowhere is still caught.
    const bad = new ScriptedLlm([say("It is ₪650.00 now."), say("It is in the quote.")]);
    expect(await turn(c.id, bad, "Any better price?")).toMatchObject({ text: "It is in the quote." });
  });

  it("the approved texts: OFFER_OK_MESSAGE, and the quote argument descriptions without the Q-1001 example", () => {
    expect(OFFER_OK_MESSAGE).toBe("Offer this in your own words, with these terms and figures only. Do not offer more, and add no other amount or percentage. When the buyer accepts, call create_quote with this offer id, these lines, these sites and this discount_percent. If the buyer turns it down, you may call check_offer again for the next offer. If the buyer needs more than this, create_quote with the discount they need (offer null) goes to the seller for approval.");
    const quoteArg = (name: string) => ((TOOL_DEFS.find((d) => d.name === name)!.input_schema as { properties: { quote: { description: string } } }).properties.quote.description);
    expect(quoteArg("check_offer")).toBe("The buyer's current quote number exactly as create_quote returned it or your context lists it (Q- and its number).");
    expect(quoteArg("send_order_form")).toBe("The quote number exactly as create_quote returned it or your context lists it (Q- and its number).");
    expect(JSON.stringify(TOOL_DEFS)).not.toContain("Q-1001");
  });
});
