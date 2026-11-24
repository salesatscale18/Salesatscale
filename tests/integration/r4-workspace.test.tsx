/**
 * Round-4 review, lane R4-1 (lead page, Conversations, Quotes and orders).
 * Rendered pages on PGlite with the agent's tools called directly (no model):
 * isolated names next to dates (F1), the thread entry for a form a person sent
 * and the furthest state on the quote row (F2), seller wording (B7, B8, B9, E1,
 * E2, E7), plain tool labels (C1), Conversations tabs on a phone (D4), the
 * sticky side navigation (D9) and the text font for money and counts (D11).
 *
 * With R4_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { conversations, leads, orderForms, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
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

const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createOrderForm, loadForm, markOpened, personSentForms, signForm, startPayment } = await import("@/lib/orders/service");
const { simulateFakePayment } = await import("@/lib/payments/events");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.R4_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block"><div class="sas-shell__main">${html}</div></div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ account, ...extra }) as Promise<{ account: string } & Record<string, string>>,
  searchParams: Promise.resolve(sp),
});
const FSI = "⁨";
const PDI = "⁩";

describe("R4-1: lead page, Conversations, Quotes and orders", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let acc = "";
  const ids: Record<string, string> = {};

  const session = async (name: string, company: string) => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc);
    await db.update(leads).set({ isTest: false, fullName: name, company }).where(eq(leads.id, c.leadId));
    await db.update(conversations).set({ isTest: false, channel: "simulator" }).where(eq(conversations.id, c.conversationId));
    return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, language: "en" }) };
  };
  const qualify = { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: "Quote on assumption of 1 site", objection: null };
  const quoteInput = { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null };
  const fields = { company_name: "Cohen Ltd", company_id: "516000111", billing_address: "1 Herzl St, Haifa", delivery_address: "1 Herzl St, Haifa", invoice_email: "noa@cafe.test" };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc));
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
    ]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      fields: [
        ...draft.playbook.fields.filter((f) => f.stage === "before_quote"),
        { key: "company_name", label: "Company name", stage: "before_order_form" },
        { key: "company_id", label: "Company ID", stage: "before_order_form" },
      ],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };

    // Noa (Hebrew name): the agent quotes and sends the form; she signs and pays. The deal is won.
    const noa = await session("נועה כהן", "קפה נועה");
    ids.noaLead = noa.c.leadId;
    ids.noaConv = noa.c.conversationId;
    await runTool("update_deal_state", qualify, noa.ctx("u1"));
    const q = await runTool("create_quote", quoteInput, noa.ctx("q1"));
    ids.noaQuote = String(q.result.quote_id);
    const sent = await runTool("send_order_form", { quote: String(q.result.quote).split(" ")[0] }, noa.ctx("o1"));
    const token = String(sent.result.link).split("/f/")[1];
    if (!(await signForm(db, token, { fields, fullName: "נועה כהן", role: "Owner", agreed: true }, {})).ok) throw new Error("sign");
    const pay = await startPayment(db, token, { method: "card", recurringConsent: true });
    if (!pay.ok || pay.kind !== "card") throw new Error("pay");
    await simulateFakePayment(db, pay.providerRef, "succeeded");
    await db.update(leads).set({ status: "won" }).where(eq(leads.id, ids.noaLead));

    // Tamar: the agent quotes, then a person sends the order form; the buyer opens it.
    const tamar = await session("Tamar Golan", "Golan Bakery");
    ids.tamarLead = tamar.c.leadId;
    ids.tamarConv = tamar.c.conversationId;
    await runTool("update_deal_state", qualify, tamar.ctx("u2"));
    const tq = await runTool("create_quote", quoteInput, tamar.ctx("q2"));
    ids.tamarQuote = String(tq.result.quote_id);
    const r = await createOrderForm(db, acc, { kind: "human", userId: me.id, actingAs: false }, ids.tamarQuote);
    if (!r.ok) throw new Error("form");
    ids.tamarForm = r.form.id;
    ids.tamarToken = r.token;
  });
  afterAll(async () => t.close());

  it("F2: a form a person sent shows in the thread, with the sender, the time and the link; Conversations too", async () => {
    const rows = await personSentForms(db, acc, ids.tamarLead);
    expect(rows.map((r) => r.id)).toEqual([ids.tamarForm]);
    // Another lead's forms (agent-sent) are not listed.
    expect(await personSentForms(db, acc, ids.noaLead)).toEqual([]);
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    save("lead-tamar", lead);
    const note = lead.match(/<div class="sas-thread-note" data-thread-note="order_form"[\s\S]*?Only you see this note\.<\/span><\/div>/)?.[0] ?? "";
    expect(note).toContain(`Order form sent by ${FSI}you${PDI}`);
    expect(note).toContain(`/f/${ids.tamarToken}`);
    expect(note).toContain("Copy link");
    // In the thread, after the agent's opener (it happened later).
    const thread = lead.split('class="sas-chat"')[1] ?? "";
    expect(thread.indexOf('data-thread-note="order_form"')).toBeGreaterThan(thread.indexOf('class="sas-msg sas-msg--agent"'));
    expect(thread.indexOf('class="sas-msg sas-msg--agent"')).toBeGreaterThanOrEqual(0);
    const conv = await page(ConversationsPage(props(account.slug, { c: ids.tamarConv })));
    expect(conv).toContain('data-thread-note="order_form"');
  });

  it("F2: the quote row shows the furthest state: Sent, then Opened once the buyer opens the form; Paid for a paid order", async () => {
    const row = (html: string) => html.match(/<a class="sas-list__row sas-lead-doc__row" href="[^"]*orders\?quote=[^"]*"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(row(await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never)))).toContain('data-status="quote.sent"');
    const view = await loadForm(db, ids.tamarToken);
    if (!view || view.state !== "open") throw new Error("form not open");
    await markOpened(db, view.form);
    const opened = row(await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never)));
    expect(opened).toContain('data-status="order_form.opened"');
    expect(opened).toContain('<span class="sas-id">Q-');
    // The form is still open: the thread keeps its link; a replaced form says the link no longer works.
    await db.update(orderForms).set({ status: "link_expired" }).where(eq(orderForms.id, ids.tamarForm));
    const after = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    expect(after).toContain("This link no longer works.");
    expect(after).not.toContain(`/f/${ids.tamarToken}`);
    await db.update(orderForms).set({ status: "opened" }).where(eq(orderForms.id, ids.tamarForm));
    expect(row(await page(LeadCardPage(props(account.slug, {}, { leadId: ids.noaLead }) as never)))).toContain('data-status="payment.paid"');
  });

  it("F1: a Hebrew signer's name is isolated from the date in the order panel; names in tables use <bdi>", async () => {
    const html = await page(OrdersPage(props(account.slug, { tab: "orders", quote: ids.noaQuote })));
    save("order-noa", html);
    expect(html).toMatch(new RegExp(`Signed by ${FSI}נועה כהן${PDI} · \\d`));
    expect(html).toContain("<bdi>קפה נועה</bdi>");
  });

  it("F1: the Conversations preview is the sender, then the message in its own direction", async () => {
    const conv = await page(ConversationsPage(props(account.slug)));
    save("conversations", conv);
    // conv-list-fixes 3: a left-to-right line, the speaker first, the message an isolated run in its own direction.
    expect(conv).toMatch(/<span class="sas-inbox__preview" dir="ltr" data-line="2" data-preview="" title="[^"]*"><span class="sas-inbox__preview-who">(Agent|Buyer|You|Team):<\/span> <bdi class="sas-inbox__preview-text" dir="auto">/);
    expect(conv).not.toContain(">System:<");
    expect(css).toContain(".sas-inbox__preview-text { unicode-bidi: isolate; }");
  });

  it("B7: Monthly incl. VAT, and the monthly line of an item also bought once is '<name> · monthly service'", async () => {
    const html = await page(OrdersPage(props(account.slug, { quote: ids.tamarQuote })));
    save("quote-tamar", html);
    expect(html).toContain('<dt class="sas-kv__total">Monthly incl. VAT</dt>');
    expect(html).not.toContain("Monthly total incl. VAT");
    // R5-4: the quantity on both lines of one item, 1 included.
    expect(html).toContain('data-line-name="">1 × Kitchen hub · monthly service<');
    expect(html).toContain('data-line-name="">1 × Kitchen hub<');
    // D11: only the reference is code in the header.
    expect(html).toMatch(/<span class="sas-small"><span class="sas-id">Q-\d+ v1<\/span> · valid until /);
  });

  it("B8: the quote card in the thread says Agent (tests/integration/quote-card.test.tsx); the panel says 'Sent by you'", async () => {
    const panel = await page(OrdersPage(props(account.slug, { quote: ids.tamarQuote })));
    expect(panel).toContain(`Sent by ${FSI}you${PDI} · `);
    expect(panel).not.toContain("Sent by You");
  });

  it("B9, E1: Conversations tabs 'All buyer chats' and 'Human handling'; the phone summary names order form details", async () => {
    const conv = await page(ConversationsPage(props(account.slug)));
    // ConvListV2: the views are the options of one menu.
    expect(conv).toMatch(/class="sas-rowmenu__item sas-inbox__option"[^>]*>All buyer chats <span class="sas-num">/);
    expect(conv).toMatch(/class="sas-rowmenu__item sas-inbox__option"[^>]*>Human handling <span class="sas-num">/);
    expect(conv).toMatch(/class="sas-rowmenu__item sas-inbox__option"[^>]*>Test lab chats <span class="sas-num">/);
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    expect(lead).toMatch(/data-testid="lead-summary"[\s\S]*?Order form details: (\d+ not known yet|all known)/);
  });

  it("E2: a won deal says so, and Take over chat is secondary", async () => {
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.noaLead }) as never));
    save("lead-noa", lead);
    expect(lead).toContain("This deal is won. The agent still answers the buyer&#x27;s questions.");
    expect(lead).not.toContain("The agent is handling this conversation.");
    expect(lead).toMatch(/class="sas-btn sas-btn--secondary sas-btn--sm" data-testid="header-take-over" data-take-over="secondary"/);
    const conv = await page(ConversationsPage(props(account.slug, { c: ids.noaConv })));
    save("conv-noa", conv);
    expect(conv).toContain("This deal is won.");
    expect(conv).toContain('data-take-over="secondary"');
    // The thread header follows the lead page's title rule (R5-6): each Hebrew part one isolated unit, breaking only at " · ".
    expect(conv).toMatch(/<strong data-thread-title="" dir="ltr" style="[^"]*"><bdi class="sas-title-part" dir="auto">נועה כהן<\/bdi> · <bdi class="sas-title-part" dir="auto">קפה נועה<\/bdi><\/strong>/);
    expect(lead).toContain('<bdi class="sas-title-part">נועה כהן</bdi> · <bdi class="sas-title-part">קפה נועה</bdi>');
    // An open deal keeps the primary Take over.
    const tamar = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    expect(tamar).toContain('data-take-over="primary"');
  });

  it("E7: win events get the green filled circle; Orders says '… ago'; amount headings do not wrap", async () => {
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.noaLead }) as never));
    expect(lead.match(/class="sas-av sas-av--success" aria-hidden="true" data-tone="success"/g)?.length).toBe(2);
    expect(css).toContain(".sas-av--success { background: var(--success); color: var(--on-agent); }");
    const orders = await page(OrdersPage(props(account.slug, { tab: "orders" })));
    expect(orders).toMatch(/data-label="Signed"[^>]*>(just now|\d+ (min|h) ago|\d+ \w+)</);
    // The table's headings never wrap (quote table polish: one CSS rule instead of an inline style).
    expect(orders).toContain('class="lqq-c-total" data-sort-col="one_time"');
    expect(css).toContain(".sas-table.lqq-table th { padding: var(--space-2) 12px; white-space: nowrap;");
  });

  it("C1: trace chips use plain labels; platform admins get the internal name as a tooltip", async () => {
    const { traceChips } = await import("@/app/app/[account]/leads/[leadId]/conversation");
    const { ChatMessage } = await import("@/components/sas/chat");
    const call = (name: string, outcome: "ok" | "refused" = "ok") => ({ name, input: {}, result: {}, outcome }) as never;
    const calls = [call("update_deal_state"), call("check_fit"), call("search_catalog"), call("create_quote", "refused"), call("send_order_form"), call("some_new_tool")];
    expect(traceChips(calls).map((c) => c.label)).toEqual(["Deal details updated", "Checked fit", "Searched catalog", "Quote created", "Order form sent", "Tool used"]);
    expect(traceChips(calls).every((c) => c.title === undefined)).toBe(true);
    expect(traceChips(calls, true).map((c) => c.title)).toEqual(["deal_state.update", "catalog.check_fit", "catalog.search", "quote.create", "order_form.send", "some_new_tool"]);
    const html = renderToStaticMarkup(ChatMessage({ actor: "agent", who: "Agent", trace: traceChips(calls, true), children: "Hi" }));
    expect(html).toContain('title="deal_state.update"><span class="sas-chip sas-chip--plain">');
    expect(html).toContain(">Deal details updated</span>");
    const seller = renderToStaticMarkup(ChatMessage({ actor: "agent", who: "Agent", trace: traceChips(calls), children: "Hi" }));
    expect(seller).not.toContain("deal_state.update");
  });

  it("D11, D9, D4: money and counts in the text font, codes in the code font; sticky side nav; Conversations tabs wrap on a phone", () => {
    expect(css).toContain(".sas-num { font-family: var(--font-sans); font-variant-numeric: tabular-nums;");
    expect(css).toContain(".sas-id { font-family: var(--font-mono);");
    expect(css).toContain(".sas-nav__count { font-family: var(--font-sans);");
    expect(css).toMatch(/\.sas-shell__nav > \.sas-nav \{ position: sticky; top: 0; height: 100vh;/);
    // ConvListV2: the tabs became one views menu; it and the sort menu share one line at any width.
    expect(css).toMatch(/\.sas-inbox__bar \{ display: flex; gap: var\(--space-2\); min-width: 0; \}/);
  });
});
