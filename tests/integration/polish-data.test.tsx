/**
 * Live-review polish, Package 1 (lane Polish-1): data that was wrong or
 * contradicted itself. On PGlite, with the agent's tools called directly (no model).
 * - a quote the app sends (card or WhatsApp text) is Sent, not Draft, also after an approval;
 * - signing fills the deal state's company and signer details (verified) and ends the pre-sale next step;
 * - a paid lead's card shows the order, the paid banner and agrees with Quotes and orders;
 * - the quote detail shows Subtotal / VAT / Total incl. VAT, and dates in the quote's zone.
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { dealStates, leads, quotes, quoteVersions, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
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
const { approveHeldQuote } = await import("@/lib/agent/quote-approval");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { docStatusByQuote, listOrders, signForm, startPayment } = await import("@/lib/orders/service");
const { simulateFakePayment } = await import("@/lib/payments/events");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { WhatsAppSection } = await import("@/app/app/[account]/settings/whatsapp");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);

describe("Polish-1: wrong or contradicting data", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let acc = "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc));
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
    ]);
    await seedPricing(db, acc, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "SVC-INST", oneTime: 25_000 },
    ], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      maxDiscountBp: 500,
      fields: [
        ...draft.playbook.fields.filter((f) => f.stage === "before_quote"),
        { key: "company_name", label: "Company name", stage: "before_order_form" },
        { key: "company_id", label: "Company ID", stage: "before_order_form" },
        { key: "signatory_name", label: "Signatory name", stage: "before_order_form" },
        { key: "signatory_role", label: "Signatory role", stage: "before_order_form" },
      ],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
  });
  afterAll(async () => t.close());

  const session = async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc);
    // The lead counts as a real lead in the seller's lists (test-lab leads are hidden there).
    await db.update(leads).set({ isTest: false, company: "Shapiro Pizza" }).where(eq(leads.id, c.leadId));
    return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, language: "en" }) };
  };
  const qualify = { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: "Quote on assumption of 1 site", objection: null };
  const quoteInput = { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null };
  const statusOf = async (quoteId: string) => (await db.select({ s: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)))[0].s;

  it("1. the quote card the app sends makes the quote Sent; a held quote becomes Sent once approved and sent", async () => {
    const { ctx } = await session();
    await runTool("update_deal_state", qualify, ctx("u1"));
    const r = await runTool("create_quote", quoteInput, ctx("q1"));
    expect(r.outcome).toBe("ok");
    expect(await statusOf(String(r.result.quote_id))).toBe("sent");
    // The agent's valid-until is the date in the quote's zone (as the buyer's card shows it).
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.idempotencyKey, "tool:q1"));
    expect(r.result.valid_until).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(v.validUntil));

    const held = await runTool("create_quote", { ...quoteInput, discount_percent: 15 }, ctx("q2"));
    const heldId = String(held.result.quote_id);
    expect(await statusOf(heldId)).toBe("awaiting_approval");
    // The turn runner records the call; runTool alone does not.
    await db.insert(toolCalls).values({ accountId: acc, conversationId: ctx("x").conversationId, sequence: 1, name: "create_quote", input: {}, result: held.result, outcome: "ok" });
    const ok = await approveHeldQuote(db, { account, user: me, actingAs: false, role: "seller_admin" }, heldId, null);
    expect(ok.ok).toBe(true);
    expect(await statusOf(heldId)).toBe("sent");

    // Lead card and Quotes and orders show Sent.
    const html = await page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId: ctx("x").leadId }), searchParams: Promise.resolve({}) }));
    expect(html).not.toMatch(/>Draft</);
    expect(html).toContain(">Sent<");
  });

  it("2/5/7. signed and paid: order row, Paid pill, verified company and signer, after-sale next step, paid banner; tabs agree", async () => {
    const { c, ctx } = await session();
    await runTool("update_deal_state", qualify, ctx("u3"));
    const q = await runTool("create_quote", quoteInput, ctx("q3"));
    const quoteId = String(q.result.quote_id);
    const sent = await runTool("send_order_form", { quote: String(q.result.quote).split(" ")[0] }, ctx("o3"));
    expect(sent.outcome).toBe("ok");
    const token = String(sent.result.link).split("/f/")[1];

    // With the buyer: the stepper stays on Order form.
    let html = await page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId: c.leadId }), searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/data-testid="stage-stepper"[^>]*data-stage="order_form"/);

    const fields = { company_name: "Shapiro Pizza Ltd", company_id: "516000111", billing_address: "1 Herzl St, Haifa", delivery_address: "1 Herzl St, Haifa", invoice_email: "eli@pizza.test" };
    expect((await signForm(db, token, { fields, fullName: "Eli Shapiro", role: "Owner", agreed: true }, {})).ok).toBe(true);
    const [deal] = await db.select().from(dealStates).where(and(eq(dealStates.accountId, acc), eq(dealStates.leadId, c.leadId)));
    expect(deal.fields.company_name).toMatchObject({ value: "Shapiro Pizza Ltd", provenance: "verified" });
    expect(deal.fields.company_id).toMatchObject({ value: "516000111", provenance: "verified" });
    expect(deal.fields.signatory_name).toMatchObject({ value: "Eli Shapiro", provenance: "verified" });
    expect(deal.fields.signatory_role).toMatchObject({ value: "Owner", provenance: "verified" });
    // What the chat learned before stays.
    expect(deal.fields.sites).toMatchObject({ value: "1", provenance: "buyer" });
    expect(deal.nextStep).toBeNull();

    // Signed, not paid: still Order form.
    html = await page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId: c.leadId }), searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/data-testid="stage-stepper"[^>]*data-stage="order_form"/);
    expect(html).toContain("is signed. Waiting for the payment.");

    const pay = await startPayment(db, token, { method: "card", recurringConsent: true });
    if (!pay.ok || pay.kind !== "card") throw new Error(JSON.stringify(pay));
    await simulateFakePayment(db, pay.providerRef, "succeeded");

    html = await page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId: c.leadId }), searchParams: Promise.resolve({}) }));
    save("lead-paid", html);
    // Orders block: PD-10001, amount, Paid pill.
    const orderRow = html.match(/<a[^>]*data-order-row[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(orderRow).toContain("PD-10001");
    expect(orderRow).toContain("₪1,770.00 + ₪106.20/month");
    expect(orderRow).toMatch(/sas-pill--success[^>]*>[\s\S]*Paid/);
    // Deal state: filled and verified, no "Not known yet" for the signed fields.
    // As text: the check keeps the last word in its own span (W6).
    for (const value of ["Shapiro Pizza Ltd", "516000111", "Eli Shapiro", "Owner"]) expect(html.replace(/<[^>]+>/g, "")).toContain(value);
    expect(html).toContain('aria-label="From the signed order form, ');
    expect(html).not.toContain("Quote on assumption of 1 site");
    expect(html).toContain("Order PD-10001 is paid. Next: delivery.");
    // Paid banner in the success tone (S1); success-toned timeline with the amount. The order ID in the code font (R5 item 6).
    expect(html).toMatch(/data-stage="after" data-stage-tone="success"/);
    expect(html).toContain('Order <span class="sas-id">PD-10001</span> paid');
    expect(html).not.toContain("After · paid.");
    expect(html).toMatch(/data-tone="success">Order paid</);
    expect(html).toMatch(/data-tone="success">Order form signed</);

    // The Quotes tab row agrees with the Orders tab.
    const docs = await docStatusByQuote(db, acc, [quoteId]);
    expect(docs.get(quoteId)).toEqual({ form: "signed", payment: "paid" });
    expect((await listOrders(db, acc)).find((o) => o.order.quoteId === quoteId)?.order.paymentStatus).toBe("paid");
    const orders = await page(OrdersPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    const qRow = orders.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*quote=${quoteId}(?:(?!</tr>)[\\s\\S])*</tr>`))?.[0] ?? "";
    // Quotes and orders V2: one Where it is pill, the order and its payment on the detail line.
    expect(qRow).toContain(">Ordered<");
    expect(qRow).toMatch(/Order <span class="sas-id sas-id--plain">PD-10001<\/span><\/a> · paid/);
  });

  it("3/7. quote detail: Subtotal, VAT 18%, Total incl. VAT (and monthly); valid until in the quote's zone", async () => {
    const { ctx } = await session();
    await runTool("update_deal_state", qualify, ctx("u4"));
    const q = await runTool("create_quote", quoteInput, ctx("q4"));
    const quoteId = String(q.result.quote_id);
    const html = await page(OrdersPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ quote: quoteId }) }));
    save("quote-detail", html);
    expect(html).not.toContain("+ VAT");
    const rows = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(expect.arrayContaining([
      ["Subtotal", "₪1,500.00"], ["VAT 18%", "₪270.00"], ["Total incl. VAT", "₪1,770.00"],
      ["Subtotal", "₪90.00/month"], ["VAT 18%", "₪16.20/month"], ["Monthly incl. VAT", "₪106.20/month"],
    ]));
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    const local = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Jerusalem" }).format(v.validUntil);
    expect(html).toContain(`valid until ${local}`);
  });

  it("4. Go live and Markets: WhatsApp is neutral Optional for now and out of the count; Live · test leads only", async () => {
    await db.update(sellerAccounts).set({ status: "live", wentLiveAt: new Date("2026-11-18T10:00:00Z"), rollout: "test_only", legalName: "Polar Ltd", companyId: "51-1", supportContact: "s@p.test" }).where(eq(sellerAccounts.id, acc));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    const golive = await page(GoLivePage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    save("go-live", golive);
    expect(golive).toContain("Live · test leads only");
    const wa = golive.match(/<li[^>]*data-check="whatsapp"[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(wa).toContain('data-state="optional"');
    expect(wa).toContain('data-check-icon="optional"');
    expect(wa).toContain("Optional for now");
    expect(wa).not.toContain("Not needed yet");
    expect(golive).toMatch(/of 4 checks/);
    const markets = await page(MarketsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    save("markets", markets);
    // MarketsV2: the readiness strip counts the 4 blocking checks; WhatsApp is muted "WhatsApp number · optional".
    expect(markets).toMatch(/Ready to sell · \d of 4/);
    const mwa = markets.match(/<li[^>]*data-check="whatsapp"[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(mwa).toContain('data-check-icon="optional"');
    expect(mwa).toContain("WhatsApp number · optional");

    // Settings › WhatsApp: the same status (not a green "Twilio connected" with no icon).
    const env = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN };
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "test";
    try {
      const settings = renderToStaticMarkup(await WhatsAppSection({ account, sp: {}, baseUrl: "https://app.test" }));
      save("settings-whatsapp", settings);
      const head = settings.match(/<div class="sas-page-head">[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(head).toContain('data-wa-status="optional"');
      expect(head).toContain("Optional for now");
      expect(settings).not.toContain("Twilio connected");
    } finally {
      process.env.TWILIO_ACCOUNT_SID = env.sid;
      process.env.TWILIO_AUTH_TOKEN = env.token;
      if (env.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      if (env.token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    }
  });
});
