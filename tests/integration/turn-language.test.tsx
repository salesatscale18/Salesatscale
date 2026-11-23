/**
 * Turn language (owner rule, text chat): replies, fixed system messages and cards follow the language of the
 * buyer's LATEST message; a short or neutral message keeps the previous turn's language; the lead's stored
 * language is only the starting value and never changes. ScriptedLlm only: no model call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, asc, eq } from "drizzle-orm";
import { conversations, followUps, leads, messages, quotes, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
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
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { approveHeldQuote } = await import("@/lib/agent/quote-approval");
const { buyerChat, createSimulatedBuyer, resolveChatToken, startSimulatorConversation } = await import("@/lib/simulator/service");
const { scheduleFollowUp } = await import("@/lib/follow-ups/schedule");
const { runDueFollowUps } = await import("@/lib/follow-ups/scheduler");
const { currentBuyerLanguage } = await import("@/lib/conversations/current-language");

const HE_UPDATED = "ההצעה המעודכנת שלך";
const HELD_EN = "Polar Demo is reviewing this quote. It will appear here when it's ready, and nothing is charged before you sign.";
const REPLY_LINE = (lang: string) => `\nReply language: ${lang} (the language of the buyer's latest message). Write your reply and any text you pass to tools in it.`;

describe("Turn language: the buyer's latest message decides", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-tl", email: "danny@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error("account");
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" })
      .where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }],
      { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel 2026 price list" });
    const draft = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...draft.playbook, agentName: "Maya", fields: draft.playbook.fields.filter((f) => f.stage === "before_quote") });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" as const };
  });
  afterAll(async () => t.close());

  /** A simulated Hebrew buyer with an open chat (the conversation starts in Hebrew, the lead's language). */
  const hebrewBuyer = async () => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "רינה כהן", company: "Rina's Kitchen", language: "he", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null },
      { db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId: `u${++seq}`, language: "he" });
    const conv = async () => (await db.select().from(conversations).where(eq(conversations.id, started.conversationId)))[0];
    const lead = async () => (await db.select().from(leads).where(eq(leads.id, made.lead.id)))[0];
    const turn = (text: string, reply: string, tools: { name: string; input: Record<string, unknown> }[] = []) => {
      const llm = new ScriptedLlm([
        ...(tools.length ? [() => ({ content: tools.map((x, i) => ({ type: "tool_use" as const, id: `tu${++seq}-${i}`, name: x.name, input: x.input })) })] : []),
        () => ({ content: [{ type: "text" as const, text: reply }] }),
      ]);
      return { llm, done: runBuyerTurn(db, llm, { accountId: acc.id, conversationId: started.conversationId, text }) };
    };
    const chatCtx = (await resolveChatToken(db, made.token))!;
    return { lead: made.lead, token: made.token, conversationId: started.conversationId, conv, leadRow: lead, turn, chat: () => buyerChat(db, chatCtx) };
  };

  const contextOf = (llm: InstanceType<typeof ScriptedLlm>) => llm.requests[0].system[1];

  it("a Hebrew lead writing English gets an English held-quote line and an English quote card; the lead keeps Hebrew", async () => {
    const b = await hebrewBuyer();
    expect((await b.conv()).language).toBe("he");
    const { llm, done } = b.turn("Hi, I need a quote for two sensors please, with a 10% discount", "I'm checking the discount with the team.", [{
      name: "create_quote",
      input: { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 10, sites: 1, remove_auto_added: null, exception: null, headline: null },
    }]);
    const r = await done;
    expect(r.status).toBe("replied");
    // The context tells the model the reply language (before: "Conversation language: he.").
    expect(contextOf(llm).endsWith(REPLY_LINE("en"))).toBe(true);
    expect(contextOf(llm)).not.toContain("Conversation language");
    expect((await b.conv()).language).toBe("en");
    expect((await b.leadRow()).language).toBe("he");

    const rows = await db.select().from(messages).where(eq(messages.conversationId, b.conversationId)).orderBy(asc(messages.createdAt));
    const held = rows.find((m) => m.body === HELD_EN);
    expect(held).toMatchObject({ actor: "agent", language: "en" });
    // The buyer's own message is stored with its language.
    expect(rows.find((m) => m.actor === "buyer")).toMatchObject({ language: "en" });
    const chat = await b.chat();
    expect(chat.language).toBe("en");
    expect(chat.cards[held!.id]).toMatchObject({ state: "held", title: "Your quote", sub: "Being checked by the team" });

    // The seller approves later: the quote and its card are posted in the conversation's current language (English).
    const [q] = await db.select().from(quotes).where(and(eq(quotes.accountId, acc.id), eq(quotes.leadId, b.lead.id)));
    expect(await approveHeldQuote(db, { account: acc, user: me, actingAs: false, role: "seller_admin" } as never, q.id)).toMatchObject({ ok: true });
    const after = await b.chat();
    expect(after.cards[held!.id]).toMatchObject({ state: "sent", title: "Your quote" });
    const close = after.messages.at(-1)!;
    expect(close).toMatchObject({ from: "agent", kind: "quote_close" });
    expect(close.body).toMatch(/^The team approved your quote\./);

    // The buyer page opens in the language the buyer last wrote in.
    const page = renderToStaticMarkup(await BuyerChatPage({ params: Promise.resolve({ token: b.token }) }));
    expect(page).toContain('class="c-root" lang="en"');
  });

  it("'ok' after English stays English; a later Hebrew message switches back; Spanish keeps the previous language", async () => {
    const b = await hebrewBuyer();
    await b.turn("Hello, how much is the sensor for one kitchen?", "It is 590 per sensor.").done;
    expect((await b.conv()).language).toBe("en");

    const ok = b.turn("ok", "Great.");
    expect((await ok.done).status).toBe("replied");
    expect(contextOf(ok.llm).endsWith(REPLY_LINE("en"))).toBe(true);
    expect((await b.conv()).language).toBe("en");

    for (const neutral of ["👍", "12", "David", "https://example.com/menu"]) {
      await b.turn(neutral, "Noted.").done;
      expect((await b.conv()).language, neutral).toBe("en");
    }

    const he = b.turn("אפשר לקבל הצעה לשני חיישנים בבקשה?", "בטח, אני מכינה הצעה.");
    await he.done;
    expect(contextOf(he.llm).endsWith(REPLY_LINE("he"))).toBe(true);
    expect((await b.conv()).language).toBe("he");

    const es = b.turn("Hola, quiero comprar dos sensores para mi restaurante", "…");
    await es.done;
    expect(contextOf(es.llm).endsWith(REPLY_LINE("he"))).toBe(true);
    expect((await b.conv()).language).toBe("he");

    // A fixed reply (card details) follows the turn language too.
    await b.turn("Here is my card number 4111 1111 1111 1111 for the order", "").done;
    const [last] = await db.select().from(messages).where(eq(messages.conversationId, b.conversationId)).orderBy(asc(messages.createdAt)).then((r) => r.slice(-1));
    expect(last).toMatchObject({ actor: "agent", language: "en" });
    expect((await b.leadRow()).language).toBe("he");
  });

  it("a follow-up scheduled earlier is sent in the conversation's current language", async () => {
    const b = await hebrewBuyer();
    const now = new Date();
    const due = new Date(now.getTime() + 60 * 60_000);
    const s = await scheduleFollowUp(db, { accountId: acc.id, leadId: b.lead.id, conversationId: b.conversationId, language: "he" },
      { due_at: due.toISOString(), topic: null, buyer_named_time: true }, now);
    expect(s.ok).toBe(true);
    // The conversation's language changed since (e.g. on a call, which does not cancel the follow-up).
    await db.update(conversations).set({ language: "en" }).where(eq(conversations.id, b.conversationId));
    const run = await runDueFollowUps(db, null, new Date(due.getTime() + 60_000));
    expect(run.sent).toBeGreaterThanOrEqual(1);
    const [f] = await db.select().from(followUps).where(eq(followUps.leadId, b.lead.id));
    const [m] = await db.select().from(messages).where(eq(messages.id, f.sentMessageId!));
    expect(m.language).toBe("en");
    expect(m.body).toMatch(/Is now a good time\?$/);
  });

  it("buyer page: earlier English quote cards (sent and replaced) follow the chat's current language; the stored headline stays", async () => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language: "en" });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    const quote = async (qty: number) => {
      const input = { lines: [{ sku: "SNS-200", qty }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null, headline: "Cold-chain kit for Rina's Kitchen" };
      const r = await runTool("create_quote", input, ctx(`q${++seq}`));
      await db.insert(toolCalls).values({ accountId: acc.id, conversationId: started.conversationId, sequence: seq, name: "create_quote", input, result: r.result, outcome: r.outcome });
      return String(r.result.quote_message_id);
    };
    const first = await quote(2);
    await new Promise((r) => setTimeout(r, 3));
    const second = await quote(3);
    const chatCtx = (await resolveChatToken(db, made.token))!;

    const en = await buyerChat(db, chatCtx);
    expect(en.language).toBe("en");
    expect(en.cards[first]).toMatchObject({ state: "replaced", lang: "en", dir: "ltr" });
    expect(en.cards[second]).toMatchObject({ state: "sent", lang: "en", dir: "ltr", title: "Your updated quote", headline: "Cold-chain kit for Rina's Kitchen" });

    // The buyer went on in Hebrew: the next poll gives every card Hebrew labels and rtl; the stored messages stay as written.
    await db.update(conversations).set({ language: "he" }).where(eq(conversations.id, started.conversationId));
    const he = await buyerChat(db, chatCtx);
    expect(he.language).toBe("he");
    expect(he.cards[second]).toMatchObject({ state: "sent", lang: "he", dir: "rtl", title: HE_UPDATED, headline: "Cold-chain kit for Rina's Kitchen" });
    expect(he.cards[first]).toMatchObject({ state: "replaced", lang: "he", dir: "rtl" });
    expect(JSON.stringify(he.cards[first])).toContain("למטה");
    expect(JSON.stringify(he.cards[first])).not.toContain("below");
    const [stored] = await db.select().from(messages).where(eq(messages.id, second));
    expect(stored.language).toBe("en");

    const page = renderToStaticMarkup(await BuyerChatPage({ params: Promise.resolve({ token: made.token }) }));
    expect(page).toContain('class="c-root" lang="he"');
    expect(page).toMatch(/class="sas-qc sas-qc--sent[^"]*" dir="rtl" lang="he"/);
    expect(page).toContain(HE_UPDATED);
    expect(page).toContain("Cold-chain kit for Rina&#x27;s Kitchen");
    expect(page).not.toContain("Your updated quote");
  });

  it("app texts outside a turn (SMS, order forms) read the conversation's current language, else the lead's", async () => {
    const b = await hebrewBuyer();
    expect(await currentBuyerLanguage(db, acc.id, { id: b.lead.id, language: "he" })).toBe("he");
    await b.turn("Hello, can you send me the price list please?", "Sure.").done;
    expect(await currentBuyerLanguage(db, acc.id, { id: b.lead.id, language: "he" })).toBe("en");
    expect(await currentBuyerLanguage(db, acc.id, { id: b.lead.id, language: "he" }, b.conversationId)).toBe("en");
    // Scoped by account: another account's id finds nothing and falls back to the lead's language.
    expect(await currentBuyerLanguage(db, "00000000-0000-0000-0000-000000000000", { id: b.lead.id, language: "he" }, b.conversationId)).toBe("he");
  });
});
