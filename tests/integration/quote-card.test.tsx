/**
 * P11 wave 2 (lane F): the designed quote card in the buyer simulator chat and
 * the seller's thread. Held → approved replaces the placeholder in place,
 * "Send 5% instead", v1 → v2 collapse, expiry, the headline and its fallback,
 * the reply buttons after the close, and account isolation. No model call:
 * create_quote runs as a tool and its call is stored as the agent turn would.
 *
 * With QCARD_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { conversations, messages, quotes, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
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

const { default: BuyerChatPage } = await import("@/app/chat/[token]/page");
const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
const { approveQuoteInThreadAction, sendInLimitAction } = await import("@/app/app/[account]/leads/[leadId]/quote-card-actions");
const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { loadQuoteCards } = await import("@/lib/agent/quote-card-data");
const { approveHeldQuote, sendHeldQuoteInLimit } = await import("@/lib/agent/quote-approval");
const { buyerChat, createSimulatedBuyer, resolveChatToken, startSimulatorConversation } = await import("@/lib/simulator/service");

const OUT = process.env.QCARD_RENDER_DIR;
const css = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
function save(name: string, html: string, kind: "seller" | "buyer", lang = "en") {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const style = (kind === "seller" ? css("components/sas/sas.css") : css("app/chat/[token]/chat.css")) + css("components/sas/quote-card.css");
  const body = kind === "seller" ? `<div class="sas-app"><div class="sas-shell__main" style="max-width:760px">${html}</div></div>` : html;
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${style}</style></head><body>${body}</body></html>`);
}
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const run = async (p: Promise<unknown>) => {
  try { return await p; } catch (e) { const url = (e as { url?: string }).url; if (!url) throw e; return { redirect: url }; }
};

describe("Quote card", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  let seq = 0;
  const access = (a: SellerAccount = acc) => ({ account: a, user: me, actingAs: false, role: "seller_admin" as const });

  beforeAll(async () => {
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
      await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" })
        .where(eq(sellerAccounts.id, a.id));
      await seedCatalog(db, a.id, [
        { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
        { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
        { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" },
        { sku: "MON-1", name: "Monitoring plan", plainName: "monitoring plan", unit: "site" },
      ], [
        { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
        { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
      ]);
      await seedPricing(db, a.id, [
        { sku: "SNS-200", oneTime: 59_000 },
        { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
        { sku: "SVC-INST", oneTime: 25_000 },
        { sku: "MON-1", recurring: 9_000 },
      ], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel 2026 price list" });
      const draft = await ensureDraftVersion(db, a.id);
      await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya", fields: draft.playbook.fields.filter((f) => f.stage === "before_quote") });
      await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    }
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    [other] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, other.id));
    holder.access = access();
  });
  afterAll(async () => t.close());

  /** A simulated buyer with an open chat; `quote` runs create_quote and stores its call as the agent turn would. */
  const buyer = async (language: "en" | "he" = "en", a: SellerAccount = acc) => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, a, { fullName: language === "he" ? "רינה כהן" : "Rina Cohen", company: "Rina's Kitchen", language, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, a.id);
    const ctx = (callId: string) => ({ db, accountId: a.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    const quote = async (input: Record<string, unknown>) => {
      const callId = `q${++seq}`;
      const r = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null, headline: null, ...input }, ctx(callId));
      await db.insert(toolCalls).values({ accountId: a.id, conversationId: started.conversationId, sequence: seq, name: "create_quote", input, result: r.result, outcome: r.outcome });
      return r;
    };
    const say = async (actor: "agent" | "buyer", body: string) => {
      await new Promise((r) => setTimeout(r, 3));
      await db.insert(messages).values({ accountId: a.id, conversationId: started.conversationId, actor, body, language, deliveryStatus: actor === "agent" ? "delivered" : null });
    };
    const chatCtx = (await resolveChatToken(db, made.token))!;
    return { lead: made.lead, token: made.token, conversationId: started.conversationId, quote, say, chat: (now?: Date) => buyerChat(db, chatCtx, { now }) };
  };

  it("held quote: the buyer sees a placeholder with no numbers; Approve and send replaces it in place", async () => {
    const b = await buyer();
    const r = await b.quote({ discount_percent: 10 });
    expect(r.result).toMatchObject({ status: "awaiting_seller_approval", quote_held: true });
    const id = String(r.result.quote_message_id);
    await b.say("agent", "I'm checking the discount with the team. Your quote will be here shortly.");

    const held = await b.chat();
    expect(held.cards[id]).toMatchObject({ state: "held", title: "Your quote", sub: "Being checked by the team", approval: null, sellerOnly: null });
    expect(held.cards[id].status).toContain("Polar Demo is reviewing this quote");
    expect(JSON.stringify(held.cards[id])).not.toMatch(/₪|\d\.\d\d|SNS-200/);
    expect(held.messages.find((m) => m.id === id)).toMatchObject({ kind: "quote_held" });
    const heldPage = render(await BuyerChatPage({ params: Promise.resolve({ token: b.token }) }));
    save("buyer-held-en", heldPage, "buyer");
    expect(heldPage).toContain('data-quote-state="held"');
    expect(heldPage).not.toContain("data-reply-buttons");

    // Seller: the same placeholder plus the approval panel (reasons, lines, three actions).
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const view = await conversationView(db, acc.id, conv);
    expect(view.quoteCards[id].approval).toMatchObject({ reasons: ["Discount 10.0% is above the 5.0% limit."], canApprove: true, inLimitBp: 500 });
    const panel = render(ConversationPanel({ slug: acc.slug, view, me, buyerName: "Rina Cohen", leadOptedOut: false }));
    save("seller-held", panel, "seller");
    expect(panel).toContain("Approve and send");
    expect(panel).toContain("Send 5% instead");
    expect(panel).toContain(`/app/${acc.slug}/leads/${b.lead.id}/quote?from=${view.quoteCards[id].quoteId}`);
    expect(panel).toContain("Sent by the app");

    const out = await run(approveQuoteInThreadAction(form({ slug: acc.slug, quoteId: view.quoteCards[id].quoteId, back: `/app/${acc.slug}/leads/${b.lead.id}#conversation` })));
    expect(out).toEqual({ redirect: `/app/${acc.slug}/leads/${b.lead.id}?notice=quote_approved#conversation` });
    const after = await b.chat();
    expect(after.cards[id]).toMatchObject({ state: "sent", ref: expect.stringMatching(/^Q-\d+$/), total: { label: "Today", amount: "₪2,219.58" } });
    expect(after.cards[id].rows).toContainEqual({ label: "Discount 10%", amount: "−₪209.00" });
    // A back URL off the account falls back to the inbox.
    const [q] = await db.select().from(quotes).where(eq(quotes.id, view.quoteCards[id].quoteId));
    expect(q.status).toBe("draft");
  });

  it("Send 5% instead: the in-limit version takes the placeholder's place; account admins only", async () => {
    const b = await buyer();
    const r = await b.quote({ discount_percent: 10 });
    const id = String(r.result.quote_message_id);
    const quoteId = String(r.result.quote_id);
    // Not an admin (no such role yet): refused on the server.
    expect(await sendHeldQuoteInLimit(db, { ...access(), role: "viewer" as never }, quoteId)).toEqual({ ok: false, reason: "forbidden" });
    expect(await approveHeldQuote(db, { ...access(), role: "viewer" as never }, quoteId)).toEqual({ ok: false, reason: "forbidden" });
    // Another account's admin cannot reach it.
    expect(await sendHeldQuoteInLimit(db, access(other), quoteId)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(await run(sendInLimitAction(form({ slug: acc.slug, quoteId, back: "https://evil.test/x" })))).toEqual({ redirect: `/app/${acc.slug}/conversations?notice=quote_in_limit` });
    const card = (await b.chat()).cards[id];
    expect(card).toMatchObject({ state: "sent", ref: expect.stringMatching(/^Q-\d+ v2$/) });
    expect(card.rows[0]).toEqual({ label: "Discount 5%", amount: "−₪104.50" });
  });

  it("a new quote collapses the old card to one muted line; the new one is 'Your updated quote' with changed lines", async () => {
    const b = await buyer();
    const v1 = await b.quote({ headline: "2 fridge sensors and a kitchen hub, installed for you" });
    await b.say("agent", "If this looks right, I'll send the order form now. Sounds good?");
    await b.say("buyer", "actually 3 fridges");
    const v2 = await b.quote({ lines: [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10", qty: 1 }] });
    await b.say("agent", "Here is the updated quote. Sounds good?");
    const chat = await b.chat();
    const old = chat.cards[String(v1.result.quote_message_id)];
    const cur = chat.cards[String(v2.result.quote_message_id)];
    expect(old).toMatchObject({ state: "replaced", status: "Replaced by the updated quote below.", summary: "₪2,466.20 today · ₪106.20/month", lines: [] });
    expect(cur).toMatchObject({ state: "sent", title: "Your updated quote", headline: "Wireless fridge sensor and 2 more" });
    expect(cur.lines[0]).toEqual({ label: "3 × Wireless fridge sensor", amount: "₪1,770.00", was: "was 2" });
    expect(cur.lines[1].was).toBeNull();
    const page = render(await BuyerChatPage({ params: Promise.resolve({ token: b.token }) }));
    save("buyer-replaced-en", page, "buyer");
    expect(page).toContain('data-quote-state="replaced"');
    // Reply buttons under the close that follows the current card, and only there.
    expect(page.match(/data-reply-buttons/g)).toHaveLength(1);
    expect(page).toMatch(/<button type="button" class="c-reply">Sounds good<\/button><button type="button" class="c-reply">Change something<\/button>/);
    await b.say("buyer", "Sounds good");
    expect(render(await BuyerChatPage({ params: Promise.resolve({ token: b.token }) }))).not.toContain("data-reply-buttons");

    // Past the valid-until date the current card is expired: headline and the total only.
    const later = new Date(Date.now() + 9 * 86_400_000);
    const exp = (await b.chat(later)).cards[String(v2.result.quote_message_id)];
    expect(exp).toMatchObject({ state: "expired", headline: "Wireless fridge sensor and 2 more", lines: [], total: { label: "Today", amount: "₪3,162.40" } });
    expect(exp.status).toMatch(/^Expired on \d{1,2} [A-Z][a-z]{2}\. Write here and we'll send an updated quote\.$/);
  });

  it("headline: the agent's when valid (stored with the message link), dropped when it has prices; fallback only with 3+ items", async () => {
    // One buyer per quote: a later quote in the same chat would collapse the earlier card.
    const [b1, b2, b3] = [await buyer(), await buyer(), await buyer()];
    const good = await b1.quote({ headline: "  2 fridge sensors and a kitchen hub, installed for you " });
    expect(good.result.headline).toBe("2 fridge sensors and a kitchen hub, installed for you");
    const bad = await b2.quote({ headline: "2 sensors for ₪1,180" });
    expect(bad.result).not.toHaveProperty("headline");
    const monthly = await b3.quote({ lines: [{ sku: "MON-1", qty: 2 }], sites: null });
    expect((await b1.chat()).cards[String(good.result.quote_message_id)].headline).toBe("2 fridge sensors and a kitchen hub, installed for you");
    expect((await b2.chat()).cards[String(bad.result.quote_message_id)].headline).toBe("Wireless fridge sensor and 2 more");
    // Monthly only, one item: no headline, no delivery line, the first-charge footer, "Monthly" total.
    expect((await b3.chat()).cards[String(monthly.result.quote_message_id)]).toMatchObject({
      headline: null, lines: [], total: null, delivery: null, firstCharge: "First charge when the service starts",
      monthly: { heading: null, total: { label: "Monthly", amount: "₪212.40" } },
    });
  });

  it("Hebrew: the chat and the card mirror; amounts and quote numbers stay left-to-right", async () => {
    const b = await buyer("he");
    const r = await b.quote({});
    await b.say("agent", "אם זה נראה לך נכון, אשלח עכשיו את טופס ההזמנה. מתאים?");
    const card = (await b.chat()).cards[String(r.result.quote_message_id)];
    expect(card).toMatchObject({ dir: "rtl", lang: "he", title: "ההצעה שלך", total: { label: "לתשלום היום", amount: "₪2,466.20" } });
    expect(card.delivery).toMatch(/^אספקה עד בערך /);
    const page = render(await BuyerChatPage({ params: Promise.resolve({ token: b.token }) }));
    save("buyer-sent-he", page, "buyer", "he");
    expect(page).toMatch(/class="c-log" role="log" aria-label="[^"]+" dir="rtl"/);
    expect(page).toMatch(/<article class="sas-qc sas-qc--sent" dir="rtl" lang="he" aria-label="הצעת מחיר Q-\d+"/);
    expect(page).toContain('<span class="sas-qc__num">₪2,466.20</span>');
    expect(page).toContain("sas-qc__ic--truck");
    expect(page).toContain(">מתאים</button>");
    expect(page).toContain(">לשנות משהו</button>");
  });

  it("seller strip: product codes, price list and Open quote for the account only; never on the buyer's card", async () => {
    const b = await buyer();
    const r = await b.quote({});
    const id = String(r.result.quote_message_id);
    await b.say("agent", "If this looks right, I'll send the order form now. Sounds good?");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const view = await conversationView(db, acc.id, conv);
    expect(view.quoteCards[id].sellerOnly).toEqual({ skus: ["SNS-200", "GW-10", "SVC-INST"], priceList: "Israel 2026 price list" });
    const html = render(ConversationPanel({ slug: acc.slug, view, me, buyerName: "Rina Cohen", leadOptedOut: false }));
    save("seller-sent", html, "seller");
    expect(html).toContain("Only you see this:");
    expect(html).toContain(`href="/app/${acc.slug}/orders?quote=${r.result.quote_id}"`);
    expect(JSON.stringify((await b.chat()).cards[id])).not.toContain("SNS-200");

    // Another account sees nothing: not through its own conversations, not through a forged link to this quote.
    expect(await loadQuoteCards(db, other.id, [b.conversationId], { audience: "seller" })).toEqual({});
    const ob = await buyer("en", other);
    const fake = randomUUID();
    await db.insert(messages).values({ id: fake, accountId: other.id, conversationId: ob.conversationId, actor: "agent", body: "x" });
    await db.insert(toolCalls).values({
      accountId: other.id, conversationId: ob.conversationId, sequence: 1, name: "create_quote", input: {}, outcome: "ok",
      result: { quote: String(r.result.quote), quote_id: r.result.quote_id, quote_version: 1, quote_message_id: fake },
    });
    const forged = await loadQuoteCards(db, other.id, [ob.conversationId], { audience: "seller" });
    expect(forged[fake]).toBeUndefined();
    expect(await db.select().from(quotes).where(and(eq(quotes.accountId, other.id), eq(quotes.id, String(r.result.quote_id))))).toEqual([]);
  });
});
