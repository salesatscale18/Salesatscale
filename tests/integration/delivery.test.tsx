/** Delivery ETA (wave 3, lane D): settings, market override, snapshot freeze, buyer pages, orders, quote editor and agent tools on PGlite. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { auditLog, markets, orderForms, sellerAccounts, users, type OrderSnapshot, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { estimateDelivery, formatDeliveryBuyer, formatDeliveryShort } from "@/lib/delivery/eta";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// W2: Quotes and orders reads the market switcher's stored choice (a cookie) for accounts with several markets.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));

const { saveCompanyAction } = await import("@/app/app/[account]/setup/company/actions");
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");
const { default: OrderFormSetupPage } = await import("@/app/app/[account]/setup/order-form/page");
const { overrideSettingAction, resetSettingAction } = await import("@/app/app/[account]/markets/actions");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { default: SignedDocumentPage } = await import("@/app/f/[token]/document/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: QuoteEditorPage } = await import("@/app/app/[account]/leads/[leadId]/quote/page");
const { createMarket } = await import("@/lib/markets/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createOrderForm, signForm } = await import("@/lib/orders/service");
const { createQuote } = await import("@/lib/quotes/service");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");
const { ensureDraftVersion, startTestConversation } = await import("@/lib/agent/service");
const { runTool } = await import("@/lib/agent/tools");
const { stableSystemPrompt } = await import("@/lib/agent/prompt");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const sign = { fields: { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St", delivery_address: "Tel Aviv", invoice_email: "rina@kitchen.test" }, fullName: "Rina Cohen", role: "Owner", agreed: true };
const company = (extra: Record<string, string>) => form({ slug: "polar", tradeName: "Polar", brandColor: "#0f6b5a", ...extra });

describe("delivery ETA", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let homeId = "";
  const human = () => ({ kind: "human" as const, userId: me.id, actingAs: false });
  const refresh = async () => {
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
  };
  const newLead = async (phone: string) => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen", phone, language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const l = await upsertLead(db, acc.id, { userId: me.id, actingAs: false }, p.value, "manual");
    if (!l.ok) throw new Error();
    return l.lead.id;
  };
  const newForm = async (phone: string) => {
    const leadId = await newLead(phone);
    const q = await createQuote(db, acc.id, human(), leadId, { lines: [{ sku: "KIT-1", qty: 1 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const f = await createOrderForm(db, acc.id, human(), q.quote.id);
    if (!f.ok) throw new Error(f.reason);
    return { leadId, quoteId: q.quote.id, ...f };
  };
  const buyer = async (token: string, sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await refresh();
    await seedCatalog(db, acc.id, [{ sku: "KIT-1", name: "Starter kit", unit: "device" }]);
    await seedPricing(db, acc.id, [{ sku: "KIT-1", oneTime: 100_000 }], { userId: me.id });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים." });
    [{ id: homeId }] = await db.select({ id: markets.id }).from(markets).where(and(eq(markets.accountId, acc.id), eq(markets.isHome, true)));
  });
  afterAll(async () => t.close());

  it("with no lead time nothing is shown: no snapshot plan, no buyer row, the agent says not set", async () => {
    const f = await newForm("0525550301");
    expect((f.form.snapshot as OrderSnapshot & { delivery?: unknown }).delivery).toBeNull();
    const html = await buyer(f.token);
    expect(html).not.toContain("Estimated delivery");
    expect(html).not.toContain("data-delivery");
    const setupEmpty = renderToStaticMarkup(await OrderFormSetupPage(props(acc.slug)));
    expect(setupEmpty).toContain("data-delivery-preview-empty");
    expect(setupEmpty).toContain("No delivery estimate shown — set a lead time in Company › Delivery");

    const c = (await startTestConversation(db, acc.id, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = { db, accountId: acc.id, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId: "d0" };
    const fit = await runTool("check_fit", { lines: [{ sku: "KIT-1", qty: 1 }], sites: null }, ctx);
    expect((fit.result as { delivery: string }).delivery).toMatch(/^not set: if asked, say you'll confirm the delivery time with the team/);
  });

  it("Setup › Company saves the lead time, refuses a bad range, and empty clears it", async () => {
    const bad = await run(saveCompanyAction(company({ minDays: "10", maxDays: "5", businessDays: "on" })));
    expect(bad).toEqual({ redirect: `/app/polar/setup/company?error=${encodeURIComponent("The first number can't be more than the second.")}` });
    const frac = await run(saveCompanyAction(company({ minDays: "1.5", maxDays: "5" })));
    expect((frac as { redirect: string }).redirect).toContain(encodeURIComponent("Enter whole numbers of days."));
    const big = await run(saveCompanyAction(company({ minDays: "1", maxDays: "400" })));
    expect((big as { redirect: string }).redirect).toContain("error=");
    await refresh();
    expect(acc.deliveryLeadTime).toBeNull();

    expect(await run(saveCompanyAction(company({ minDays: "5", maxDays: "10", businessDays: "on" })))).toEqual({ redirect: "/app/polar/setup/company?saved=1" });
    await refresh();
    expect(acc.deliveryLeadTime).toEqual({ minDays: 5, maxDays: 10, businessDays: true });
    const setup = renderToStaticMarkup(await OrderFormSetupPage(props(acc.slug)));
    expect(setup).toContain("data-delivery-preview");
    expect(setup).not.toContain("data-delivery-preview-empty");
    expect(setup).toMatch(/Estimated delivery: .*2\d{3}/);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc.id), eq(auditLog.action, "delivery_lead_time.saved")));
    expect(audits).toHaveLength(1);
    // Saving again unchanged writes no new audit entry.
    await run(saveCompanyAction(company({ minDays: "5", maxDays: "10", businessDays: "on" })));
    expect(await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc.id), eq(auditLog.action, "delivery_lead_time.saved")))).toHaveLength(1);

    const html = renderToStaticMarkup(await CompanyPage(props(acc.slug)));
    expect(html).toContain("data-delivery-section");
    expect(html).toMatch(/name="minDays"[^>]*value="5"/);
    expect(html).toMatch(/name="maxDays"[^>]*value="10"/);
    expect(html).toContain("Count business days only (skips weekends and holidays)");
    expect(html).toContain("Leave empty if you don&#x27;t want to show delivery times.");
    expect(html).toContain("Weekends and your holiday list are skipped.");
    expect(html).toContain("5–10 business days after signing");

    // Empty clears it; then set it back for the rest of the suite.
    await run(saveCompanyAction(company({ minDays: "", maxDays: "" })));
    await refresh();
    expect(acc.deliveryLeadTime).toBeNull();
    await run(saveCompanyAction(company({ minDays: "5", maxDays: "10", businessDays: "on" })));
    await refresh();
  });

  it("a market overrides the lead time and resets to the account default", async () => {
    const uk = await createMarket(db, { userId: me.id, actingAs: false }, acc.id, { name: "UK", countries: ["GB"], phonePrefixes: ["+44"] });
    if (!uk.ok) throw new Error();
    const id = uk.market.id;
    let html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: id })));
    expect(html).toMatch(/data-setting="leadTime"[^]*Lead time[^]*5–10 business days[^]*data-source="account"[^]*Change for this market/);

    const refused = await run(overrideSettingAction(form({ slug: acc.slug, marketId: id, key: "leadTime", minDays: "", maxDays: "" })));
    expect((refused as { redirect: string }).redirect).toContain("override=leadTime");
    const [still] = await db.select().from(markets).where(eq(markets.id, id));
    expect(still.overrides.leadTime).toBeUndefined();

    await run(overrideSettingAction(form({ slug: acc.slug, marketId: id, key: "leadTime", minDays: "2", maxDays: "3" })));
    const [m] = await db.select().from(markets).where(eq(markets.id, id));
    expect(m.overrides.leadTime).toEqual({ minDays: 2, maxDays: 3, businessDays: false });
    html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: id })));
    expect(html).toMatch(/data-setting="leadTime"[^]*2–3 days[^]*data-source="market"[^]*Reset/);
    // The override form shows the market's weekend.
    html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: id, override: "leadTime" })));
    expect(html).toContain("Weekend here: Saturday, Sunday.");

    await run(resetSettingAction(form({ slug: acc.slug, marketId: id, key: "leadTime" })));
    const [back] = await db.select().from(markets).where(eq(markets.id, id));
    expect(back.overrides.leadTime).toBeUndefined();
  });

  it("the quote editor shows the estimate if signed today", async () => {
    const leadId = await newLead("0525550302");
    const html = renderToStaticMarkup(await QuoteEditorPage({ params: Promise.resolve({ account: acc.slug, leadId }), searchParams: Promise.resolve({}) }));
    const eta = estimateDelivery({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, from: new Date(), timezone: "Asia/Jerusalem", weekend: [5, 6] });
    expect(html).toContain(`Estimated delivery if signed today: ${formatDeliveryShort(eta)}`);
    expect(html).toContain("5–10 business days after signing");
  });

  let token = "";
  it("freezes the plan into the snapshot (IL: Fri/Sat weekend) and shows it before signing, EN and HE", async () => {
    await db.update(markets).set({ overrides: { holidays: ["2020-01-01", "2099-01-01"] } }).where(eq(markets.id, homeId));
    const f = await newForm("0525550303");
    token = f.token;
    const snap = f.form.snapshot as OrderSnapshot & { delivery?: unknown };
    expect(snap.delivery).toEqual({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, timezone: "Asia/Jerusalem", holidays: ["2099-01-01"], weekend: [5, 6] });
    // Changing the account afterwards does not change an existing form.
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 30, maxDays: 40, businessDays: false } }).where(eq(sellerAccounts.id, acc.id));

    const eta = estimateDelivery({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, from: new Date(), timezone: "Asia/Jerusalem", weekend: [5, 6], holidays: ["2099-01-01"] });
    const en = await buyer(token);
    expect(en).toContain(`Estimated delivery: ${formatDeliveryBuyer(eta)}`);
    expect(en).toContain("5–10 business days from signing");
    expect(en).toContain(`data-delivery="${eta.earliest}/${eta.latest}"`);
    const he = await buyer(token, { lang: "he" });
    expect(he).toContain(`מועד אספקה משוער: ${formatDeliveryBuyer(eta, "he")}`);
    expect(he).toContain("\u20665–10\u2069 ימי עסקים ממועד החתימה");
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc.id));
  });

  it("after signing: dates count from the signing date, on the pay page, the document and the Orders list", async () => {
    const signed = await signForm(db, token, sign, {});
    expect(signed.ok).toBe(true);
    const [row] = await db.select().from(orderForms).where(eq(orderForms.tokenHash, (await import("@/lib/orders/token")).hashToken(token)));
    const eta = estimateDelivery({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, from: row.signedAt!, timezone: "Asia/Jerusalem", weekend: [5, 6] });
    const pay = await buyer(token);
    expect(pay).toContain(`Estimated delivery: ${formatDeliveryBuyer(eta)}`);
    expect(pay).toMatch(/5–10 business days from signing on \d{1,2} [A-Z][a-z]{2} \d{4}/);
    const doc = renderToStaticMarkup(await SignedDocumentPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ lang: "he" }) }));
    expect(doc).toContain(`מועד אספקה משוער: ${formatDeliveryBuyer(eta, "he")}`);
    expect(doc).toContain("\u20665–10\u2069 ימי עסקים ממועד החתימה, שנחתם ב־");

    const orders = renderToStaticMarkup(await OrdersPage(props(acc.slug, { tab: "orders" })));
    expect(orders).toContain("Est. delivery");
    expect(orders).toContain(`>${formatDeliveryShort(eta)}</td>`);
  });

  it("older snapshots without a delivery plan still render, with no row and an empty Orders cell", async () => {
    const f = await newForm("0525550304");
    const old = { ...(f.form.snapshot as OrderSnapshot & { delivery?: unknown }) };
    delete old.delivery;
    await db.update(orderForms).set({ snapshot: old as OrderSnapshot }).where(eq(orderForms.id, f.form.id));
    const open = await buyer(f.token);
    expect(open).toContain("Starter kit");
    expect(open).not.toContain("Estimated delivery");
    expect((await signForm(db, f.token, sign, {})).ok).toBe(true);
    expect(await buyer(f.token)).not.toContain("Estimated delivery");
    const orders = renderToStaticMarkup(await OrdersPage(props(acc.slug, { tab: "orders" })));
    expect(orders).toMatch(/data-order-delivery="[^"]+"><\/td>/);
  });

  it("the agent gets the estimate in check_fit and create_quote, and has one stable delivery rule", async () => {
    const c = (await startTestConversation(db, acc.id, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, memo: {} });
    const eta = estimateDelivery({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, from: new Date(), timezone: "Asia/Jerusalem", weekend: [5, 6], holidays: ["2099-01-01"] });
    const expected = `estimate ${eta.text} (5–10 business days after signing, if signed today)`;
    const fit = await runTool("check_fit", { lines: [{ sku: "KIT-1", qty: 1 }], sites: null }, ctx("f1"));
    expect(fit.result).toMatchObject({ delivery: expected });
    for (const f of draft.playbook.fields.filter((x) => x.stage === "before_quote")) {
      await runTool("update_deal_state", { updates: [{ key: f.key, value: "2", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u-${f.key}`));
    }
    const q = await runTool("create_quote", { lines: [{ sku: "KIT-1", qty: 1 }], discount_percent: 0, sites: null, remove_auto_added: null }, ctx("q1"));
    expect(q.result).toMatchObject({ ok: true, delivery: expected });

    const prompt = stableSystemPrompt(draft.playbook, { tradeName: "Polar", currency: "ILS", languages: ["en"] });
    expect(prompt).toContain("never promise an exact date");
    expect(prompt).toContain('hand off with reason "delivery deadline"');
    expect(prompt).toContain("look the question up with lookup_knowledge and, when nothing is found, send it to the team with ask_team");
  });
});
