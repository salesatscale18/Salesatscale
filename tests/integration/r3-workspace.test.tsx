/**
 * Round-3 review, lane R3-1 (lead page, Conversations, Quotes and orders,
 * Leads list). Rendered pages on PGlite with the agent's tools called directly
 * (no model): one deal-state pane and next step for the lead page and
 * Conversations (A1, A2), one term for test chats (A8), the paid order panel
 * and "Ordered" (B1), won chats under Closed (B2), the consent line under Next
 * step (B3), sortable headings, instant filters and search (C), and the reply
 * buttons under the close with no buyer reply yet.
 *
 * With R3_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { conversations, leads, orders, messages, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
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
const { signForm, startPayment } = await import("@/lib/orders/service");
const { simulateFakePayment } = await import("@/lib/payments/events");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: BuyerChatPage } = await import("@/app/chat/[token]/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string, extraCss = "") => {
  const dir = process.env.R3_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}${extraCss}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ account, ...extra }) as Promise<{ account: string } & Record<string, string>>,
  searchParams: Promise.resolve(sp),
});

describe("R3-1: lead page, Conversations, Quotes and orders, Leads", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let acc = "";
  const ids: Record<string, string> = {};

  /** A real (non-test) lead in a chat on the buyer simulator channel, with the agent's tools at hand. */
  const session = async (name: string, company: string) => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc);
    await db.update(leads).set({ isTest: false, fullName: name, company }).where(eq(leads.id, c.leadId));
    await db.update(conversations).set({ isTest: false, channel: "simulator" }).where(eq(conversations.id, c.conversationId));
    return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, language: "en" }) };
  };
  const qualify = { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: "Quote on assumption of 1 site", objection: null };
  const quoteInput = { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc));
    // "Wireless fridge sensor" is both the chat name and the internal name; the hub has its own chat name.
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
        { key: "signatory_name", label: "Signatory name", stage: "before_order_form" },
        { key: "signatory_role", label: "Signatory role", stage: "before_order_form" },
        { key: "invoice_email", label: "Invoice email", stage: "before_order_form" },
      ],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };

    // Eli: quote, form, signed and paid (Won).
    const eli = await session("Eli Shapiro", "Shapiro Pizza");
    ids.eliLead = eli.c.leadId;
    ids.eliConv = eli.c.conversationId;
    await runTool("update_deal_state", qualify, eli.ctx("u1"));
    const q = await runTool("create_quote", quoteInput, eli.ctx("q1"));
    ids.eliQuote = String(q.result.quote_id);
    ids.eliQuoteNo = String(q.result.quote).split(" ")[0];
    const sent = await runTool("send_order_form", { quote: ids.eliQuoteNo }, eli.ctx("o1"));
    const token = String(sent.result.link).split("/f/")[1];
    const fields = { company_name: "Shapiro Pizza Ltd", company_id: "516000111", billing_address: "1 Herzl St, Haifa", delivery_address: "1 Herzl St, Haifa", invoice_email: "eli@pizza.test" };
    if (!(await signForm(db, token, { fields, fullName: "Eli Shapiro", role: "Owner", agreed: true }, {})).ok) throw new Error("sign");
    const pay = await startPayment(db, token, { method: "card", recurringConsent: true });
    if (!pay.ok || pay.kind !== "card") throw new Error("pay");
    await simulateFakePayment(db, pay.providerRef, "succeeded");

    // Noa: the order form is out, not signed. The agent's free text is from before.
    const noa = await session("Noa Cohen", "Cafe Noa");
    ids.noaLead = noa.c.leadId;
    ids.noaConv = noa.c.conversationId;
    await runTool("update_deal_state", qualify, noa.ctx("u2"));
    const nq = await runTool("create_quote", quoteInput, noa.ctx("q2"));
    await runTool("send_order_form", { quote: String(nq.result.quote).split(" ")[0] }, noa.ctx("o2"));

    // Tamar: qualified, no quote yet (the agent's next step stays).
    const tamar = await session("Tamar Golan", "Golan Bakery");
    ids.tamarLead = tamar.c.leadId;
    await runTool("update_deal_state", qualify, tamar.ctx("u3"));

    // A test-lab chat (hidden test lead).
    await startTestConversation(db, acc, me.id, { language: "en" });
  });
  afterAll(async () => t.close());

  it("A1: Conversations shows the lead page's deal pane for a won, paid lead (verified details, paid next step)", async () => {
    const conv = await page(ConversationsPage(props(account.slug, { c: ids.eliConv })));
    save("conv-eli", conv);
    const side = conv.split('class="sas-inbox__side"')[1];
    expect(side).toContain('data-testid="deal-pane"');
    // As text: the check keeps the last word in its own span (W6).
    for (const v of ["Shapiro Pizza Ltd", "516000111", "Eli Shapiro", "Owner"]) expect(side.replace(/<[^>]+>/g, "")).toContain(v);
    expect(side).toContain('aria-label="From the signed order form, ');
    expect(side).toMatch(/data-testid="next-step"[\s\S]*Order PD-10001 is paid\. Next: delivery\./);
    expect(side).not.toContain("Quote on assumption of 1 site");
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.eliLead }) as never));
    save("lead-eli", lead);
    // Same next step in both.
    expect(lead).toMatch(/data-testid="next-step"[\s\S]*Order PD-10001 is paid\. Next: delivery\./);
  });

  it("A1: the unknown order-form details are grouped in one line in Conversations too", async () => {
    const conv = await page(ConversationsPage(props(account.slug, { c: ids.noaConv })));
    const side = conv.split('class="sas-inbox__side"')[1];
    expect(side).toMatch(/data-testid="unknown-group"[\s\S]*Order form details: 5 not known yet/);
  });

  it("A2: with the form out, the next step comes from the stage on the lead page, the phone summary and Conversations", async () => {
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.noaLead }) as never));
    save("lead-noa", lead);
    const want = "Waiting for Noa to sign and pay.";
    expect(lead).toMatch(new RegExp(`data-testid="lead-summary"[\\s\\S]*?${want}`));
    expect(lead).toMatch(new RegExp(`data-testid="next-step"[\\s\\S]*?${want}`));
    expect(lead).not.toContain("Quote on assumption of 1 site");
    const conv = await page(ConversationsPage(props(account.slug, { c: ids.noaConv })));
    expect(conv.split('class="sas-inbox__side"')[1]).toContain(want);
    // Before the quote the agent's own words stay.
    const tamar = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    expect(tamar).toMatch(/data-testid="next-step"[\s\S]*?Quote on assumption of 1 site\./);
  });

  it("B3: the consent line sits right under Next step", async () => {
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.tamarLead }) as never));
    const side = lead.split('class="sas-lead__side"')[1];
    const next = side.indexOf('data-testid="next-step"');
    const consent = side.indexOf('data-testid="consent"');
    expect(next).toBeGreaterThan(0);
    expect(consent).toBeGreaterThan(next);
    expect(side.indexOf("Set and verify")).toBeGreaterThan(consent);
    expect(css).toMatch(/\.sas-lead__side \{[^}]*position: sticky;[^}]*max-height: calc\(100vh/);
  });

  it("B2: a won lead's chat sits under Closed, not Agent handling; counts match", async () => {
    const all = await page(ConversationsPage(props(account.slug)));
    save("conversations", all);
    const groups = all.split('class="sas-label sas-inbox__group"').slice(1);
    const closed = groups.find((g) => g.startsWith(">Closed"))!;
    const agent = groups.find((g) => g.startsWith(">Agent handling"))!;
    expect(closed).toContain("Eli Shapiro");
    expect(agent).not.toContain("Eli Shapiro");
    expect(agent).toContain("Noa Cohen");
    expect(all).toMatch(/>Agent handling <span class="sas-num">2<\/span>/);
    expect(all).toMatch(/>Closed <span class="sas-num">1<\/span>/);
  });

  it("A8: one term for test chats: Test lab chats, the flask chip in the normal font, 1 test conversation", async () => {
    const all = await page(ConversationsPage(props(account.slug)));
    expect(all).toMatch(/>Test lab chats <span class="sas-num">1<\/span>/);
    const tests = await page(ConversationsPage(props(account.slug, { filter: "test" })));
    save("conversations-test", tests);
    expect(tests).toMatch(/<span class="sas-channel-pill"[^>]*data-test-chat="">[\s\S]*?Test lab chat<\/span>/);
    expect(tests).not.toContain('class="sas-chip" data-test-chat');
    expect(all).not.toMatch(/Test chats?</);
    // The empty All view names the hidden ones in the plural form.
    const { t: tr } = await import("@/lib/i18n");
    expect(tr("inbox.empty.tests_one")).toBe("1 test conversation");
    expect(tr("inbox.empty.tests", { count: 3 })).toBe("3 test conversations");
  });

  it("B1: signed but unpaid keeps Cancel quote behind a confirm step, without Create new version", async () => {
    const [ord] = await db.select().from(orders).where(eq(orders.quoteId, ids.eliQuote));
    await db.update(orders).set({ paymentStatus: "bank_transfer_expected" }).where(eq(orders.id, ord.id));
    try {
      const html = await page(OrdersPage(props(account.slug, { tab: "orders", quote: ids.eliQuote })));
      const panel = html.split('class="sas-side-panel sas-sheet"')[1];
      expect(panel).toContain('data-testid="quote-cancel-signed"');
      expect(panel).toMatch(/<summary[^>]*>Cancel quote<\/summary>/);
      expect(panel).toContain("Yes, cancel quote");
      expect(panel).not.toContain("Create new version");
      expect(panel).not.toContain('data-testid="quote-actions"');
    } finally {
      await db.update(orders).set({ paymentStatus: ord.paymentStatus }).where(eq(orders.id, ord.id));
    }
  });

  it("B1: a paid order's panel is headed by the order, without validity or quote actions; Monthly sub-heading; code only when names match", async () => {
    const html = await page(OrdersPage(props(account.slug, { tab: "orders", quote: ids.eliQuote })));
    save("order-detail", html);
    const panel = html.split('class="sas-side-panel sas-sheet"')[1];
    expect(panel).toMatch(/<h2 id="q-h" class="sas-title">Order <span class="sas-id" style="font-size:inherit">PD-10001<\/span><\/h2>/);
    // Only the reference is a code (round-4 review D11).
    expect(panel).toContain(`from quote <span class="sas-id">${ids.eliQuoteNo} v1</span>`);
    expect(panel).not.toContain("valid until");
    expect(panel).toMatch(/data-testid="detail-status"[^>]*><span class="sas-pill sas-pill--success" data-status="payment.paid"/);
    expect(panel).not.toContain('data-testid="quote-actions"');
    expect(panel).not.toContain("Create new version");
    expect(panel).not.toContain("Cancel quote");
    // "Monthly" right before the second Subtotal.
    expect(panel).toMatch(/<dt class="sas-kv__sub">Monthly<\/dt><\/div><div style="display:contents" data-total-row="rec-0"><dt>Subtotal<\/dt>/);
    // The chat name equals the internal name: the code alone; else the internal name and the code.
    expect(panel).toMatch(/1 × Wireless fridge sensor<div class="sas-small" data-line-sub=""><span class="sas-id">SNS-200<\/span><\/div>/);
    expect(panel).toMatch(/1 × Kitchen hub<div class="sas-small" data-line-sub="">Site gateway <span class="sas-id">GW-10<\/span>/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{ \.sas-detail-status \{ padding-block-start/);
  });

  it("B1: the quote an order came from shows Ordered, on the lead page and in the Quotes list", async () => {
    const lead = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.eliLead }) as never));
    const row = lead.match(/<a class="sas-list__row sas-lead-doc__row" href="[^"]*orders\?quote=[^"]*"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    // The lead page shows the furthest state: the order is paid (round-4 review F2).
    expect(row).toContain('data-status="payment.paid"');
    expect(row).toContain(">Paid<");
    expect(row).not.toContain(">Sent<");
    const list = await page(OrdersPage(props(account.slug)));
    const qRow = list.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*quote=${ids.eliQuote}(?:(?!</tr>)[\\s\\S])*</tr>`))?.[0] ?? "";
    expect(qRow).toContain(">Ordered<");
    // A quote whose form is only out is "Order form sent" (Quotes and orders V2: one Where it is pill).
    expect(list.match(/>Order form sent</g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("C: Quotes and orders search by quote number, lead name or company, with sortable headings", async () => {
    const byName = await page(OrdersPage(props(account.slug, { q: "noa" })));
    expect(byName).toContain("Cafe Noa");
    expect(byName).not.toContain("Shapiro Pizza");
    const byNumber = await page(OrdersPage(props(account.slug, { q: ids.eliQuoteNo })));
    expect(byNumber).toContain("Shapiro Pizza");
    expect(byNumber).not.toContain("Cafe Noa");
    const none = await page(OrdersPage(props(account.slug, { q: "zzz" })));
    expect(none).toContain("Nothing matches your search.");
    const orders = await page(OrdersPage(props(account.slug, { tab: "orders", q: "PD-10001" })));
    expect(orders).toContain("Shapiro Pizza");
    // Sorting: lead name A–Z puts Cafe Noa first; aria-sort on the heading; links keep the search.
    const sorted = await page(OrdersPage(props(account.slug, { sort: "lead", dir: "asc" })));
    expect(sorted.indexOf("Cafe Noa")).toBeLessThan(sorted.indexOf("Shapiro Pizza"));
    expect(sorted).toContain('aria-sort="ascending" data-sort-col="lead"');
    expect(sorted).toMatch(/data-sort-col="lead"><a class="sas-sort" href="\/app\/[^"]*\/orders\?sort=lead&amp;dir=desc"/);
    const desc = await page(OrdersPage(props(account.slug, { sort: "lead", dir: "desc" })));
    expect(desc.indexOf("Shapiro Pizza")).toBeLessThan(desc.indexOf("Cafe Noa"));
  });

  it("C: Leads sort on the server, filters apply at once (Apply only without JS), a set filter keeps its prefix", async () => {
    const asc = await page(LeadsPage(props(account.slug, { sort: "lead", dir: "asc" })));
    save("leads", asc);
    const order = ["Eli Shapiro", "Noa Cohen", "Tamar Golan"].map((n) => asc.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(asc).toContain('aria-sort="ascending" data-sort-col="lead"');
    expect(asc).toMatch(/aria-sort="none"[^>]*data-sort-col="activity"/);
    const desc = await page(LeadsPage(props(account.slug, { sort: "lead", dir: "desc" })));
    expect(desc.indexOf("Tamar Golan")).toBeLessThan(desc.indexOf("Eli Shapiro"));
    // Default: latest activity first, with aria-sort on Last activity.
    const def = await page(LeadsPage(props(account.slug)));
    expect(def).toMatch(/aria-sort="descending"[^>]*data-sort-col="activity"/);
    // Instant filters: the Apply button only inside <noscript>; the sort survives as hidden inputs.
    expect(asc).toMatch(/<noscript><button type="submit"[^>]*>Apply<\/button><\/noscript>/);
    expect(asc).toContain('<input type="hidden" name="sort" value="lead"/>');
    // Prefix on set values; shorter placeholder.
    const he = await page(LeadsPage(props(account.slug, { language: "en" })));
    expect(he).toMatch(/<option value="en" selected="">Language: English<\/option>/);
    expect(he).toContain('placeholder="Search leads"');
  });

  it("CSS: pills keep their background on a selected row (a ring), sort icons, phone filters two by two", () => {
    expect(css).toContain(".sas-row--selected .sas-pill");
    expect(css).toMatch(/\.sas-sort__icon\[data-dir="ascending"\] \.sas-ico \{ transform: rotate\(180deg\); \}/);
    expect(css).toMatch(/\.sas-filters__toggle:checked ~ \.sas-filter \{ flex: 1 1 calc\(50% - 4px\)/);
  });

  it("verify: reply buttons show under the close of a quote the buyer has not answered yet", async () => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, account, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc);
    const ctx = (callId: string) => ({ db, accountId: acc, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language: "en" });
    await runTool("update_deal_state", { ...qualify, next_step: null }, ctx("r1"));
    const r = await runTool("create_quote", { ...quoteInput, headline: null }, ctx("r2"));
    await db.insert(toolCalls).values({ accountId: acc, conversationId: started.conversationId, sequence: 1, name: "create_quote", input: {}, result: r.result, outcome: r.outcome });
    await new Promise((res) => setTimeout(res, 3));
    await db.insert(messages).values({ accountId: acc, conversationId: started.conversationId, actor: "agent", body: "If this looks right, I'll send the order form now. Sounds good?", language: "en", deliveryStatus: "delivered" });
    const html = renderToStaticMarkup(await BuyerChatPage({ params: Promise.resolve({ token: made.token }) }));
    expect(html.match(/data-reply-buttons/g)).toHaveLength(1);
    expect(html.indexOf("data-reply-buttons")).toBeGreaterThan(html.indexOf("I&#x27;ll send the order form now"));
    expect(html).toMatch(/<button type="button" class="c-reply">Sounds good<\/button><button type="button" class="c-reply">Change something<\/button>/);
  });
});
