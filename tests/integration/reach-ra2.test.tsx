/**
 * Reach RA2 (production review of Reach part A): the order form a person sends
 * shows in the seller's thread as the buyer's form card (lead page and
 * Conversations), with the private "Order form sent by you" note after it,
 * never above the chat's first line; the continuation line a lead the agent
 * already talked to elsewhere gets instead of the intro (one per state, with
 * its card); the demo leads with a recorded SMS card. On the one-click demo
 * account: no model call, no network, no Twilio.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, asc, eq } from "drizzle-orm";
import { conversations, leadEvents, leads, messages, orderForms, quotes, quoteVersions, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { formatDayMonthIn } from "@/lib/format";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
// No real model client may be built: nothing here spends.
const h = vi.hoisted(() => ({ anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));
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

const { createDemoAccount } = await import("@/lib/demo/seed");
const { STATE_LEADS } = await import("@/lib/demo/states");
const { ensureChatStarted } = await import("@/lib/chat/start");
const { continuationText, continuationState, quoteRef } = await import("@/lib/chat/continuation");
const { conversationView } = await import("@/lib/agent/conversation");
const { loadQuoteCards } = await import("@/lib/agent/quote-card-data");
const { buyerChat, resolveChatToken, activeChatToken } = await import("@/lib/simulator/service");
const { createOrderForm, linkFor } = await import("@/lib/orders/service");
const { createQuote, markQuoteSent } = await import("@/lib/quotes/service");
const { offerOrderFormInChat } = await import("@/lib/sms/outbound");
const { messages: i18n } = await import("@/lib/i18n");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const OUT = process.env.RA2_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
}

const NOW = new Date("2026-11-19T09:00:00Z");
const LATER = new Date("2026-11-19T10:00:00Z");

describe("Reach RA2", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc: SellerAccount;
  const leadOf = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, acc.id), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
  const chatOf = async (leadId: string) => (await db.select().from(conversations)
    .where(and(eq(conversations.accountId, acc.id), eq(conversations.leadId, leadId), eq(conversations.channel, "chat"))))[0];
  const thread = async (conversationId: string) => db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
  const actor = () => ({ userId: admin.id, actingAs: true });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", firstName: "Sam", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    if (!a.ok) throw new Error("refused");
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.summary.accountId));
    holder.access = { account: acc, user: admin, actingAs: true, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => { await t.close(); });

  // -------------------------------------------------------------------------
  // 5. Continuation line
  // -------------------------------------------------------------------------

  it("the four lines in both languages: fixed templates, no em dash, no slash", () => {
    const names = { name: "Dana", agent: "Maya", seller: "Polar" };
    const quote = { kind: "quote" as const, ref: "Q-1042", at: NOW, quoteId: "q", number: 1042, version: 1 };
    expect(continuationText(quote, names, "en", "15 Nov")).toBe("Hi Dana, it's Maya again from Polar, picking up where we left off. Here's your quote Q-1042 from 15 Nov, any questions about it?");
    expect(continuationText({ kind: "form", ref: "Q-1042", formId: "f" }, names, "en")).toBe("Hi Dana, it's Maya again from Polar. Your order form for Q-1042 is below; it takes about 2 minutes.");
    expect(continuationText({ kind: "pay", formId: "f" }, names, "en")).toBe("Hi Dana, it's Maya again from Polar. Thanks for signing. Payment details are below.");
    expect(continuationText({ kind: "other" }, names, "en")).toBe("Hi Dana, it's Maya again from Polar, picking up where we left off. How can I help?");
    expect(continuationText(quote, { name: "דנה", agent: "מאיה", seller: "פולאר" }, "he", "15 בנוב׳")).toBe("היי דנה, כאן מאיה שוב מ-פולאר, ממשיכים מאיפה שעצרנו. הנה ההצעה Q-1042 מ-15 בנוב׳, יש שאלות לגביה?");
    expect(continuationText({ kind: "pay", formId: "f" }, { name: "דנה", agent: "מאיה", seller: "פולאר" }, "he")).toBe("היי דנה, כאן מאיה שוב מ-פולאר. תודה על החתימה, פרטי התשלום כאן למטה.");
    for (const lang of ["en", "he"] as const) {
      for (const k of ["quote", "form", "pay", "other"] as const) {
        const s = i18n[lang][`buyer.chat.continue.${k}`];
        expect(s, `${lang} ${k}`).toBeTruthy();
        expect(s).not.toMatch(/[—–/]/);
      }
    }
    expect(quoteRef(2041, 1)).toBe("Q-2041");
    expect(quoteRef(2041, 2)).toBe("Q-2041 v2");
  });

  it("Yoni Demo (quote sent, earlier WhatsApp chat): the quote line, then the quote card", async () => {
    const yoni = await leadOf(STATE_LEADS.quoteExpiring.n);
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, yoni.id));
    expect(await continuationState(db, acc.id, yoni.id, LATER)).toMatchObject({ kind: "quote", quoteId: q.id, ref: `Q-${q.number}` });
    const r = await ensureChatStarted(db, { accountId: acc.id, leadId: yoni.id, now: LATER, actor: actor() });
    expect(r).toMatchObject({ started: true, continued: { state: "quote", card: { formUrl: null } } });
    if (!r.started) throw new Error();
    const rows = await thread(r.conversationId);
    expect(rows).toHaveLength(2);
    // The quote's day in the lead's zone, short: the seed made it QUOTE_VALID_DAYS - 1 days before its now (in production: 15 Nov).
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, q.id));
    const day = formatDayMonthIn(v.createdAt, "Asia/Jerusalem");
    expect(day).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    expect(rows[0].body).toMatch(new RegExp(`^Hi Yoni, it's .+ again from .+, picking up where we left off\\. Here's your quote Q-${q.number} from ${day}, any questions about it\\?$`));
    expect(rows[1].createdAt.getTime()).toBe(rows[0].createdAt.getTime() + 1);
    // The card, as the app posts a quote card (app_message "quote"): every web chat shows the designed card.
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, rows[1].id));
    expect(call).toMatchObject({ name: "app_message", outcome: "ok", result: expect.objectContaining({ kind: "quote", quote_id: q.id, quote: `Q-${q.number} v1` }) });
    const cards = await loadQuoteCards(db, acc.id, [r.conversationId], { audience: "buyer", now: LATER });
    expect(cards[rows[1].id]).toMatchObject({ state: "sent" });
    // The buyer page shows the line and the card; the seller thread too.
    const token = await activeChatToken(db, acc.id, yoni.id);
    const ctx = await resolveChatToken(db, token!);
    const chat = await buyerChat(db, ctx!, { now: LATER });
    expect(chat.messages.map((m) => m.id)).toEqual(rows.map((m) => m.id));
    expect(Object.keys(chat.cards)).toEqual([rows[1].id]);
    // Idempotent: the chat exists now, nothing more is written.
    expect(await ensureChatStarted(db, { accountId: acc.id, leadId: yoni.id, now: LATER })).toEqual({ started: false, reason: "exists", conversationId: r.conversationId });
    expect(await thread(r.conversationId)).toHaveLength(2);
  });

  it("signed, waiting for payment (Hebrew lead): the thanks line, then the pay card", async () => {
    const ronit = await leadOf(STATE_LEADS.bankTransfer.n);
    const r = await ensureChatStarted(db, { accountId: acc.id, leadId: ronit.id, now: LATER, actor: actor() });
    expect(r).toMatchObject({ started: true, continued: { state: "pay" } });
    if (!r.started) throw new Error();
    const rows = await thread(r.conversationId);
    expect(rows[0].body).toMatch(/^היי רונית, כאן .+ שוב מ-.+\. תודה על החתימה, פרטי התשלום כאן למטה\.$/);
    const [form] = await db.select().from(orderForms).where(eq(orderForms.leadId, ronit.id));
    expect(rows[1]).toMatchObject({ actor: "agent", body: linkFor(form).url });
    // The seller's thread shows it as the form card.
    const view = await conversationView(db, acc.id, (await chatOf(ronit.id)));
    expect(view.formCards?.[rows[1].id]).toEqual([expect.objectContaining({ formId: form.id })]);
  });

  it("order form sent, not signed: the form line and one form card, even when the form came from Send order form", async () => {
    const erez = await leadOf(STATE_LEADS.quoteDeclined.n);
    const q = await createQuote(db, acc.id, { kind: "human", userId: admin.id, actingAs: true }, erez.id, { lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }], sites: 2, discountBp: 0 }, LATER);
    if (!q.ok) throw new Error(JSON.stringify(q));
    await markQuoteSent(db, acc.id, q.quote.id);
    const f = await createOrderForm(db, acc.id, { kind: "human", userId: admin.id, actingAs: true }, q.quote.id, {}, LATER);
    if (!f.ok) throw new Error(f.reason);
    expect(await continuationState(db, acc.id, erez.id, LATER)).toMatchObject({ kind: "form", ref: `Q-${q.quote.number}` });
    const url = linkFor(f.form).url;
    const r = await offerOrderFormInChat(db, actor(), acc.id, erez.id, url, { now: LATER, transport: null });
    if (!r.posted) throw new Error(r.reason);
    const rows = await thread(r.conversationId);
    expect(rows.map((m) => m.body)).toEqual([expect.stringMatching(new RegExp(`^Hi Erez, it's .+ again from .+\\. Your order form for Q-${q.quote.number} is below; it takes about 2 minutes\\.$`)), url]);
    // The SMS (refused quietly for the demo number) points to that one card.
    expect(r.messageId).toBe(rows[1].id);
  });

  it("anything else (earlier WhatsApp chat, no quote): picking up, How can I help?", async () => {
    const lior = await leadOf(STATE_LEADS.needsYou.n);
    const r = await ensureChatStarted(db, { accountId: acc.id, leadId: lior.id, now: LATER, actor: actor() });
    expect(r).toMatchObject({ started: true, continued: { state: "other", card: null } });
    if (!r.started) throw new Error();
    const rows = await thread(r.conversationId);
    expect(rows.map((m) => m.body)).toEqual([expect.stringMatching(/^Hi Lior, it's .+ again from .+, picking up where we left off\. How can I help\?$/)]);
  });

  it("no earlier conversation: the normal intro", async () => {
    const fresh = await leadOf(1);
    expect(await db.select().from(conversations).where(eq(conversations.leadId, fresh.id))).toHaveLength(0);
    const r = await ensureChatStarted(db, { accountId: acc.id, leadId: fresh.id, now: LATER, actor: actor() });
    expect(r).toMatchObject({ started: true, continued: null });
    if (!r.started) throw new Error();
    const rows = await thread(r.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/automated assistant/);
    expect(rows[0].body).not.toMatch(/again from/);
  });

  it("account isolation: another account's lead is not found and gets nothing", async () => {
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner2@platform.test", now: NOW });
    if (!b.ok) throw new Error();
    const yoni = await leadOf(STATE_LEADS.quoteExpiring.n);
    expect(await continuationState(db, b.summary.accountId, yoni.id, LATER)).toEqual({ kind: "other" });
    expect(await ensureChatStarted(db, { accountId: b.summary.accountId, leadId: yoni.id, now: LATER })).toMatchObject({ started: false });
  }, 120_000);

  // -------------------------------------------------------------------------
  // 1. The order-form card in the seller's thread; 2. the demo SMS cards
  // -------------------------------------------------------------------------

  it("lead page: the sent order form is the buyer's card (no raw /f/ URL bubble), its private note after it, and the Delivered SMS card", async () => {
    const avi = await leadOf(STATE_LEADS.payStep.n);
    const html = await page(LeadCardPage, { account: acc.slug, leadId: avi.id });
    save("lead-avi", html);
    const conv = html.slice(html.indexOf('id="conversation"'));
    expect(conv).toContain('data-form-card=""');
    // Avi's form is signed and waits for payment: the pay card (RA3).
    expect(conv).toContain("Pay now");
    // Signed: the order number, as on the pay page (one number per order).
    expect(conv).toMatch(/Payment · <bdi class="sas-id sas-id--plain">(?!Q-)[A-Z]{1,2}-\d+<\/bdi>/);
    // The link is never a text bubble of its own.
    expect(conv).not.toMatch(/<div class="sas-msg__bubble"[^>]*>https?:\/\/[^<]*\/f\//);
    // Order: the continuation line, the card, the private note, then the SMS card.
    const line = conv.indexOf("Thanks for signing");
    const card = conv.indexOf('data-form-card=""');
    const note = conv.indexOf('data-thread-note="order_form"');
    const sms = conv.indexOf('data-sms-entry="delivered"');
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(card);
    expect(card).toBeLessThan(note);
    expect(note).toBeLessThan(sms);
    // The note's link and copy field keep their letters (no contextual alternates): set on .sas-thread-note in sas.css (not on .sas-id since RA3).
    const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
    expect(css).toMatch(/\.sas-token, \.sas-thread-note, \.sas-sim-line, #simulator, \.sas-sms-entry__text, \.sas-input\[readonly\] \{\s*font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0;/);
  });

  it("Conversations shows the same card and note order", async () => {
    const avi = await leadOf(STATE_LEADS.payStep.n);
    const c = await chatOf(avi.id);
    const html = await page(ConversationsPage, { account: acc.slug }, { c: c.id });
    save("conversations-avi", html);
    const card = html.indexOf('data-form-card=""');
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(html.indexOf('data-thread-note="order_form"'));
  });

  it("Gal Demo: the voice call's web chat shows the Not sent: test mode SMS card and no Simulated chip", async () => {
    const gal = await leadOf(16);
    const html = await page(LeadCardPage, { account: acc.slug, leadId: gal.id });
    save("lead-gal", html);
    const conv = html.slice(html.indexOf('id="conversation"'));
    expect(conv).toContain('data-sms-entry="test_mode"');
    expect(conv).toContain("Not sent: test mode");
    expect(conv).toContain('<span class="sas-chip sas-chip--plain">Web chat</span>');
    const events = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, gal.id), eq(leadEvents.type, "sms.mocked")));
    expect(events).toHaveLength(1);
  });
});
