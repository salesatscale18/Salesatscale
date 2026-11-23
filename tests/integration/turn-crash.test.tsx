/**
 * A chat turn whose model call fails after tools ran (prod, 23 Nov 17:50 UTC):
 * round 1 fell back to non-strict tools, round 2 sent them strict again and the
 * API rejected round 1's thinking block ("The `tools` list differs …"). The
 * buyer got "could not reply" and the held quote lost its card and approval.
 * Mocked SDK only: no paid calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { conversations, messages, quotes, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { primeOffers } from "../helpers/offers";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { AnthropicLlm, resetStrictToolsMemo } = await import("@/lib/agent/llm");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { approveHeldQuote } = await import("@/lib/agent/quote-approval");
const { buyerChat, createSimulatedBuyer, resolveChatToken, startSimulatorConversation } = await import("@/lib/simulator/service");

type Body = Anthropic.Beta.MessageCreateParamsNonStreaming;
const apiError = (status: number, message: string) => Object.assign(new Error(`${status} ${message}`), { status, error: { type: "error", error: { type: "invalid_request_error", message } } });
const GRAMMAR = apiError(400, "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.");
const TOOLS_CHANGED = apiError(400, "messages.1.content.0: Invalid `signature` in `thinking` block. The `tools` list differs from the one this block was created with.");
const OVERLOADED = apiError(529, "Overloaded");
const BAD_REQUEST = apiError(400, "messages: something else is wrong");

/** A fake SDK: `step(n, body)` returns the n-th response (1-based) or throws. Records every body. */
function fakeSdk(step: (n: number, body: Body) => unknown) {
  const sent: Body[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Body) => {
          sent.push(structuredClone(params));
          const out = step(sent.length, params);
          if (out instanceof Error) throw out;
          return out;
        },
      },
    },
  } as unknown as Anthropic;
  return { sent, llm: new AnthropicLlm(client) };
}
const reply = (content: unknown[], stop = "end_turn") => ({ content, stop_reason: stop, model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 20 } });
const thinking = { type: "thinking", thinking: "Quote with the discount.", signature: "sig-round-1" };
let useSeq = 0;
/** A create_quote call with a fresh tool_use id (the id is its idempotency key). */
const quoteUse = () => ({ type: "tool_use", id: `toolu_q${++useSeq}`, name: "create_quote", input: { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 10, sites: 1, remove_auto_added: null, exception: null, headline: null } });
const FINAL = "I have asked the team to approve that price.";

describe("A turn that fails after its tools ran", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let seq = 0;
  const access = () => ({ account: acc, user: me, actingAs: false, role: "seller_admin" as const });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "danny@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" })
      .where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
    ]);
    await seedPricing(db, acc.id, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "SVC-INST", oneTime: 25_000 },
    ], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel 2026 price list" });
    const draft = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...draft.playbook, agentName: "Maya", fields: draft.playbook.fields.filter((f) => f.stage === "before_quote") });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = access();
  });
  afterAll(async () => t.close());
  beforeEach(() => resetStrictToolsMemo());

  /** A simulated buyer whose deal state is ready for a quote. */
  const buyer = async () => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language: "en" });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    // Offers (part 2): a first quote without a discount, a price objection and check_offer, stored as an earlier turn; the 10% quote is then held.
    const primed = await primeOffers(db, ctx, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], sites: 1 });
    const chatCtx = (await resolveChatToken(db, made.token))!;
    const turn = (llm: InstanceType<typeof AnthropicLlm>, text = "Can I get 10% off?") => runBuyerTurn(db, llm, { accountId: acc.id, conversationId: started.conversationId, text, trigger: "test" });
    const calls = async () => (await db.select().from(toolCalls).where(and(eq(toolCalls.accountId, acc.id), eq(toolCalls.conversationId, started.conversationId))).orderBy(asc(toolCalls.createdAt))).filter((c) => c.sequence < 900);
    const thread = () => db.select().from(messages).where(eq(messages.conversationId, started.conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
    const quoteCount = async () => (await db.select().from(quotes).where(and(eq(quotes.accountId, acc.id), eq(quotes.leadId, made.lead.id)))).filter((q) => `Q-${q.number}` !== primed.quote).length;
    return { lead: made.lead, conversationId: started.conversationId, turn, calls, thread, quoteCount, chat: () => buyerChat(db, chatCtx, {}) };
  };

  it("round 1 falls back to non-strict tools: round 2 sends the same non-strict tools, byte for byte", async () => {
    const b = await buyer();
    // Strict is refused as too large; the API rejects a thinking block sent with another tool list than its own.
    let round1Tools: string | null = null;
    const sdk = fakeSdk((n, body) => {
      const tools = JSON.stringify(body.tools);
      if (body.tools?.some((x) => (x as { strict?: boolean }).strict)) return round1Tools ? TOOLS_CHANGED : GRAMMAR;
      if (!round1Tools) { round1Tools = tools; return reply([thinking, quoteUse()], "tool_use"); }
      return tools === round1Tools ? reply([{ type: "text", text: FINAL }]) : TOOLS_CHANGED;
    });
    const r = await b.turn(sdk.llm);
    expect(r).toMatchObject({ status: "replied", text: FINAL, calls: 1 });
    // Call 1: strict (too large); call 2: round 1 without strict; call 3: round 2, the same tools as call 2.
    expect(sdk.sent).toHaveLength(3);
    expect(sdk.sent[0].tools!.some((x) => (x as { strict?: boolean }).strict)).toBe(true);
    expect(sdk.sent[1].tools!.some((x) => "strict" in x)).toBe(false);
    expect(JSON.stringify(sdk.sent[2].tools)).toBe(JSON.stringify(sdk.sent[1].tools));
    // Round 1's thinking block goes back unchanged.
    const assistant = sdk.sent[2].messages.find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "thinking"));
    expect((assistant!.content as unknown[])[0]).toEqual(thinking);

    // The next turn (same process) skips the failing strict attempt.
    const sdk2 = fakeSdk(() => reply([{ type: "text", text: "Sure." }]));
    expect(await b.turn(sdk2.llm, "thanks")).toMatchObject({ status: "replied" });
    expect(sdk2.sent).toHaveLength(1);
    expect(JSON.stringify(sdk2.sent[0].tools)).toBe(JSON.stringify(sdk.sent[1].tools));
  });

  it("round 2 fails once (overloaded): retried once, the buyer gets the reply, the tool ran once", async () => {
    const b = await buyer();
    const sdk = fakeSdk((n) => (n === 1 ? reply([thinking, quoteUse()], "tool_use") : n === 2 ? OVERLOADED : reply([{ type: "text", text: FINAL }])));
    const r = await b.turn(sdk.llm);
    expect(r).toMatchObject({ status: "replied", text: FINAL, calls: 1 });
    expect(sdk.sent).toHaveLength(3);
    // The retry is the same request.
    expect(JSON.stringify(sdk.sent[2])).toBe(JSON.stringify(sdk.sent[1]));
    expect((await b.calls()).map((c) => c.name)).toEqual(["create_quote"]);
    expect(await b.quoteCount()).toBe(1);
    expect((await b.thread()).filter((m) => m.actor === "system")).toHaveLength(0);
  });

  it("round 2 fails twice: the system line stays, the steps are stored, the held card shows and approval finds the conversation", async () => {
    const b = await buyer();
    const sdk = fakeSdk((n) => (n === 1 ? reply([thinking, quoteUse()], "tool_use") : OVERLOADED));
    const r = await b.turn(sdk.llm);
    expect(r).toMatchObject({ status: "error" });
    expect(sdk.sent).toHaveLength(3); // round 1, round 2, its one retry
    const thread = await b.thread();
    const system = thread.filter((m) => m.actor === "system");
    expect(system.map((m) => m.body)).toEqual(["The agent could not reply (model error). Try again."]);
    expect(system[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    // No agent reply was made up: the only agent line is the app's held-quote placeholder.
    const calls = await b.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "create_quote", outcome: "ok", messageId: system[0].id, sequence: 1 });
    expect(calls[0].result).toMatchObject({ quote_held: true });
    const heldId = String(calls[0].result.quote_message_id);
    const afterBuyer = thread.slice(thread.findIndex((m) => m.actor === "buyer") + 1);
    expect(afterBuyer.map((m) => m.actor === "agent" ? m.id : m.actor)).toEqual([heldId, "system"]);

    // Buyer: the placeholder card. Seller: the card with its approval panel, and the step on the system line.
    expect((await b.chat()).cards[heldId]).toMatchObject({ state: "held" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const view = await conversationView(db, acc.id, conv);
    expect(view.quoteCards[heldId].approval).toMatchObject({ canApprove: true });
    const html = renderToStaticMarkup(ConversationPanel({ slug: acc.slug, view, me, buyerName: "Rina Cohen", leadOptedOut: false }));
    expect(html).toContain("Approve and send");
    const sysAt = html.indexOf("The agent could not reply");
    const sysLine = html.slice(sysAt);
    const nextLine = sysLine.indexOf('class="sas-msg sas-msg--');
    expect(nextLine > 0 ? sysLine.slice(0, nextLine) : sysLine).toContain("sas-msg__trace");

    // Approval finds the conversation through the stored create_quote call.
    expect(await approveHeldQuote(db, access(), String(calls[0].result.quote_id))).toMatchObject({ ok: true });
    expect((await b.chat()).cards[heldId]).toMatchObject({ state: "sent" });
    expect(await b.quoteCount()).toBe(1);
  });

  it("a request error that fails again is not retried; the steps are still stored", async () => {
    const b = await buyer();
    const sdk = fakeSdk((n) => (n === 1 ? reply([thinking, quoteUse()], "tool_use") : BAD_REQUEST));
    expect(await b.turn(sdk.llm)).toMatchObject({ status: "error" });
    expect(sdk.sent).toHaveLength(2);
    const [system] = (await b.thread()).filter((m) => m.actor === "system");
    expect((await b.calls()).map((c) => [c.name, c.messageId])).toEqual([["create_quote", system.id]]);
    // The buyer's next message is a new turn: the stored call is not run again.
    const sdk2 = fakeSdk(() => reply([{ type: "text", text: "The team is checking that price." }]));
    expect(await b.turn(sdk2.llm, "any news?")).toMatchObject({ status: "replied" });
    expect((await b.calls()).filter((c) => c.name === "create_quote")).toHaveLength(1);
    expect(await b.quoteCount()).toBe(1);
  });

  it("a failing first call (no tools ran yet) is not retried by the turn", async () => {
    const b = await buyer();
    const sdk = fakeSdk(() => OVERLOADED);
    expect(await b.turn(sdk.llm)).toMatchObject({ status: "error" });
    expect(sdk.sent).toHaveLength(1);
    expect(await b.calls()).toHaveLength(0);
  });
});
