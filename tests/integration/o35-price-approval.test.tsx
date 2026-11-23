/**
 * O1 part 5: special-price approval as a step. A quote above the discount
 * limit waits for approval and the chat goes on with the agent; Approve tells
 * the buyer it was approved, Decline withdraws the quote and tells the buyer
 * (EN and HE), and the decline reaches the agent's next turn ("Price
 * approval"). Account scoping. Scripted model only, never the API.
 *
 * With O35_RENDER_DIR set, the seller's approval panels are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, leadEvents, messages, quotes, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
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
const { declineQuoteInThreadAction } = await import("@/app/app/[account]/leads/[leadId]/quote-card-actions");
const { declineQuoteAction } = await import("@/app/app/[account]/orders/actions");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { runTool } = await import("@/lib/agent/tools");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { approveHeldQuote, declineHeldQuote, declineOfferBp } = await import("@/lib/agent/quote-approval");
const { priceApprovalContext, priceApprovalText } = await import("@/lib/agent/price-approval");
const { turnContext } = await import("@/lib/agent/prompt");
const { buyerChat, createSimulatedBuyer, resolveChatToken, startSimulatorConversation } = await import("@/lib/simulator/service");

const OUT = process.env.O35_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
}
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const run = async (p: Promise<unknown>) => {
  try { return await p; } catch (e) { const url = (e as { url?: string }).url; if (!url) throw e; return { redirect: url }; }
};

describe("O1 part 5: special-price approval as a step", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  let seq = 0;
  const access = (a: SellerAccount = acc) => ({ account: a, user: me, actingAs: false, role: "seller_admin" as const });

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "danny@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (tradeName: string, email: string) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: email });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    };
    acc = await mk("Polar Demo", "o@polar.test");
    other = await mk("Other Co", "o@other.test");
    for (const a of [acc, other]) {
      await db.update(sellerAccounts).set({ maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" }).where(eq(sellerAccounts.id, a.id));
      await seedCatalog(db, a.id, [
        { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
        { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
      ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
      await seedPricing(db, a.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel" });
      const draft = await ensureDraftVersion(db, a.id);
      await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya", maxDiscountBp: 500, fields: draft.playbook.fields.filter((f) => f.stage === "before_quote") });
      await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    }
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    [other] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, other.id));
    holder.access = access();
  });
  afterAll(async () => t.close());

  /** A simulated buyer whose agent made a quote with `discount` percent (stored as the agent's turn would). */
  const heldQuote = async (language: "en" | "he", discount: number) => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    // Offers (part 2): a first quote without a discount, a price objection and check_offer, stored as an earlier turn.
    if (discount > 0) await primeOffers(db, ctx, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], sites: 1 });
    const callId = `q${++seq}`;
    const input = { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: discount, offer: null, sites: 1, remove_auto_added: null, exception: null, headline: null };
    const r = await runTool("create_quote", input, ctx(callId));
    await db.insert(toolCalls).values({ accountId: acc.id, conversationId: started.conversationId, sequence: seq, name: "create_quote", input, result: r.result, outcome: r.outcome });
    const chatCtx = (await resolveChatToken(db, made.token))!;
    return { r, lead: made.lead, conversationId: started.conversationId, quoteId: String(r.result.quote_id), chat: () => buyerChat(db, chatCtx, {}) };
  };

  it("an above-limit quote waits for approval, the tool says to tell the buyer and keep going, and the chat is not paused", async () => {
    const b = await heldQuote("en", 10);
    expect(b.r.result).toMatchObject({ status: "awaiting_seller_approval", quote_held: true });
    expect(String(b.r.result.message)).toContain("Tell the buyer you have asked the team to approve that price, and keep going: the conversation does not pause.");
    const [q] = await db.select().from(quotes).where(eq(quotes.id, b.quoteId));
    expect(q.status).toBe("awaiting_approval");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    expect(conv.status).toBe("open");
    // The buyer writes again: the agent answers (no pause), with the waiting stage in its context.
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Yes, it works with your app. The team is checking that price." }] })]);
    const turn = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: b.conversationId, text: "Does it work with our app?" });
    expect(turn).toMatchObject({ status: "replied" });
    expect(llm.requests[0].system[1]).toContain("The quote waits for the seller's approval: you asked the team for that price.");
    expect(llm.requests[0].system[1]).toContain("then keep going: answer questions and handle anything else they raise.");
    expect(llm.requests[0].system[0]).toContain("Tell the buyer you have asked the team to approve that price, and keep going");
  });

  it("Approve: the buyer is told the team approved it, in English and Hebrew", async () => {
    const en = await heldQuote("en", 10);
    expect(await approveHeldQuote(db, access(), en.quoteId, null)).toMatchObject({ ok: true });
    expect((await en.chat()).messages.at(-1)).toMatchObject({ kind: "quote_close", body: expect.stringMatching(/^The team approved your quote\. If this looks right, I'll send the order form now/) });
    const he = await heldQuote("he", 10);
    expect(await approveHeldQuote(db, access(), he.quoteId, null)).toMatchObject({ ok: true });
    expect((await he.chat()).messages.at(-1)!.body).toMatch(/^הצוות אישר את ההצעה שלך\. אם זה נראה לך נכון/);
  });

  it("Decline: the quote is withdrawn and the buyer is told (neutral line, no counter-offer), in English and Hebrew; audited", async () => {
    const en = await heldQuote("en", 10);
    const r = await declineHeldQuote(db, access(), en.quoteId, null);
    expect(r).toMatchObject({ ok: true, followUp: { sent: true, messages: [{ kind: "quote_declined" }] } });
    const chat = await en.chat();
    expect(chat.messages.at(-1)).toMatchObject({ from: "agent", body: "We couldn't approve that price. Shall we look at what else could work for you?" });
    // The placeholder card shows the quote withdrawn; no order form can go out for it.
    expect(chat.cards[String(en.r.result.quote_message_id)]).toMatchObject({ state: "withdrawn" });
    const [q] = await db.select().from(quotes).where(eq(quotes.id, en.quoteId));
    expect(q.status).toBe("cancelled");
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, en.lead.id), eq(leadEvents.type, "quote.declined")));
    expect(ev.data).toMatchObject({ discountBp: 1000, toldBuyer: "We couldn't approve that price. Shall we look at what else could work for you?" });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc.id), eq(auditLog.action, "quote.declined"), eq(auditLog.targetId, en.quoteId)))).toHaveLength(1);
    // The seller's thread: the withdrawn card, then the app's line to the buyer.
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, en.conversationId));
    const thread = renderToStaticMarkup(ConversationPanel({ slug: acc.slug, view: await conversationView(db, acc.id, conv), me, buyerName: "Rina Cohen", leadOptedOut: false }));
    save("thread-declined", thread);
    expect(thread).toContain("We couldn&#x27;t approve that price. Shall we look at what else could work for you?");
    // A second decline changes nothing.
    expect(await declineHeldQuote(db, access(), en.quoteId, null)).toEqual({ ok: false, reason: "quote_closed" });

    const he = await heldQuote("he", 10);
    expect(await declineHeldQuote(db, access(), he.quoteId, null)).toMatchObject({ ok: true });
    expect((await he.chat()).messages.at(-1)!.body).toBe("לא הצלחנו לאשר את המחיר הזה. נבדוק יחד מה עוד יכול להתאים לך?");
  });

  it("Decline without an in-limit offer (more than the discount, or no limit): the plain line, EN and HE", () => {
    expect(declineOfferBp([{ kind: "discount_over_limit", requestedBp: 1000, limitBp: 500 }])).toBe(500);
    expect(declineOfferBp([{ kind: "discount_over_limit", requestedBp: 1000, limitBp: 0 }])).toBeNull();
    expect(declineOfferBp([{ kind: "discount_over_limit", requestedBp: 1000, limitBp: 500 }, { kind: "exception", id: "x", text: "Free install" }])).toBeNull();
  });

  it("the decline reaches the agent's next turn as \"Price approval\", until a new quote", async () => {
    const b = await heldQuote("en", 10);
    await declineHeldQuote(db, access(), b.quoteId, null);
    const ctx = await priceApprovalContext(db, acc.id, b.lead.id);
    expect(ctx).toContain("## Price approval");
    expect(ctx).toMatch(/The team declined Q-\d+ with a 10% discount \(Discount 10\.0% is above the 5\.0% limit\.\)\. That quote is withdrawn\./);
    expect(ctx).toContain("The app told the buyer: \"We couldn't approve that price. Shall we look at what else could work for you?\"");
    expect(ctx).toContain("a smaller first step or a discount only as a trade, each from check_offer (one offer at a time)");
    expect(ctx).not.toContain("if the buyer accepts");
    expect(ctx).toContain("Never ask the team to approve the same price again.");
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Done, here it is." }] })]);
    await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: b.conversationId, text: "OK, 5% then." });
    expect(llm.requests[0].system[1]).toContain("## Price approval");
    // Account scoping: another account reads nothing for this lead.
    expect(await priceApprovalContext(db, other.id, b.lead.id)).toBe("");
    // A new quote after the decline: the block goes.
    const draft = await ensureDraftVersion(db, acc.id);
    await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, offer: null, sites: 1, remove_auto_added: null, exception: null, headline: null },
      { db, accountId: acc.id, conversationId: b.conversationId, leadId: b.lead.id, playbook: draft.playbook, currency: "ILS", callId: `q${++seq}`, language: "en" });
    expect(await priceApprovalContext(db, acc.id, b.lead.id)).toBe("");
    // turnContext places it next to the other blocks; nothing when empty.
    expect(turnContext(draft.playbook, null, { priceApproval: priceApprovalText({ number: 7, discountBp: 1500, reasons: [], toldBuyer: null, offerBp: null }) }))
      .toContain("The team declined Q-7 with a 15% discount. That quote is withdrawn.\nThe buyer has not been told yet");
  });

  it("account scoping and admins only; the thread and the Quotes and orders screen both decline", async () => {
    const b = await heldQuote("en", 10);
    expect(await declineHeldQuote(db, access(other), b.quoteId, null)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(await declineHeldQuote(db, { ...access(), role: "viewer" as never }, b.quoteId, null)).toEqual({ ok: false, reason: "forbidden" });
    // The thread panel shows Decline next to Approve.
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const view = await conversationView(db, acc.id, conv);
    const panel = renderToStaticMarkup(ConversationPanel({ slug: acc.slug, view, me, buyerName: "Rina Cohen", leadOptedOut: false }));
    save("thread-approval", panel);
    expect(panel).toContain("Approve and send");
    expect(panel).toMatch(/data-decline="">.*Decline<\/button>/);
    holder.access = access();
    expect(await run(declineQuoteInThreadAction(form({ slug: acc.slug, quoteId: b.quoteId, back: `/app/${acc.slug}/leads/${b.lead.id}#conversation` }))))
      .toEqual({ redirect: `/app/${acc.slug}/leads/${b.lead.id}?notice=quote_declined#conversation` });

    const c = await heldQuote("en", 12);
    const before = renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ quote: c.quoteId }) }));
    save("orders-approval", before);
    expect(before).toContain(">Decline</button>");
    expect(before).toContain("Decline: the buyer is told the price could not be approved");
    expect(await run(declineQuoteAction(form({ slug: acc.slug, quoteId: c.quoteId })))).toEqual({ redirect: `/app/${acc.slug}/orders?quote=${c.quoteId}&declined=1` });
    const after = renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ quote: c.quoteId, declined: "1" }) }));
    save("orders-declined", after);
    expect(after).toContain("Quote declined. If the agent made it in a chat, the buyer was told there and the agent continues from it.");
    const [m] = await db.select().from(messages).where(eq(messages.conversationId, c.conversationId)).orderBy(messages.createdAt).then((rows) => rows.slice(-1));
    expect(m.body).toBe("We couldn't approve that price. Shall we look at what else could work for you?");
  });
});
