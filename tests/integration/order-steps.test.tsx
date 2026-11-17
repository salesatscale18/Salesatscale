/** P11 lane G: the buyer order form in three steps on PGlite (pages, step action, signing, seller view). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { dealStates, leadEvents, markets, orderForms, orders, sellerAccounts, signatures, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { deliveryChoices } from "@/lib/delivery/choice";
import { frozenPlan } from "@/lib/delivery/plan";
import { createTestDb, type TestDb } from "../helpers/db";
import { republishPricing, seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "198.51.100.7", "user-agent": "test" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));

const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { default: SignedDocumentPage } = await import("@/app/f/[token]/document/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { stepAction } = await import("@/app/f/[token]/actions");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createOrderForm, loadForm, signForm, snapshotOf } = await import("@/lib/orders/service");
const { createQuote, createQuoteVersion } = await import("@/lib/quotes/service");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");
const { ensureChatLink } = await import("@/lib/simulator/service");

const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
/** Runs a server action and returns the URL it redirected to. */
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  return null;
};
/** The whole <input> tag for a field name (and value, for radios). */
const tag = (html: string, name: string, value?: string) =>
  [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]).find((x) => x.includes(`name="${name}"`) && (value === undefined || x.includes(`value="${value}"`))) ?? "";
const company = { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St, Tel Aviv", invoice_email: "rina@kitchen.test", full_name: "Rina Cohen", signatory_role: "Owner" };

describe("order form in three steps", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const human = () => ({ kind: "human" as const, userId: me.id, actingAs: false });
  const page = async (token: string, sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));
  const post = (token: string, step: number, v: Record<string, string>, lang = "en") => redirectOf(stepAction(fd({ token, lang, step: String(step), ...v })));
  const newForm = async (phone: string, origin: "webhook" | "manual" = "webhook") => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's", email: "rina@kitchen.test", phone, language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const l = await upsertLead(db, acc.id, { userId: me.id, actingAs: false }, p.value, origin);
    if (!l.ok) throw new Error();
    // What the buyer said in the chat.
    await db.insert(dealStates).values({ accountId: acc.id, leadId: l.lead.id, fields: {
      company_name: { value: "Rina's Kitchen Ltd", provenance: "buyer", updatedAt: "" },
      billing_address: { value: "8 Dizengoff St, Tel Aviv", provenance: "buyer", updatedAt: "" },
      job_title: { value: "Owner", provenance: "buyer", updatedAt: "" },
    } });
    const q = await createQuote(db, acc.id, human(), l.lead.id, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const f = await createOrderForm(db, acc.id, human(), q.quote.id);
    if (!f.ok) throw new Error(f.reason);
    return { leadId: l.lead.id, quoteId: q.quote.id, ...f };
  };
  const draftOf = async (formId: string) => (await db.select({ d: orderForms.draft }).from(orderForms).where(eq(orderForms.id, formId)))[0].d;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc.id));
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "SNS-200 wireless sensor", plainName: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "GW-10 gateway", plainName: "Kitchen hub", unit: "site" },
    ]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים." });
  });
  afterAll(async () => t.close());

  it("freezes plain names and where each prefilled value came from", async () => {
    const f = await newForm("0525550601");
    const s = snapshotOf(f.form);
    expect(s.lines.map((l) => l.plainName)).toEqual(expect.arrayContaining(["Wireless fridge sensor", "Kitchen hub"]));
    expect(s.prefillSource).toMatchObject({ company_name: "chat", billing_address: "chat", signatory_role: "chat", invoice_email: "request", signatory_name: "request" });
  });

  it("step 1: greeting, plain names with price and SKU underneath, monthly block, delivery estimate, chat link only with a web chat", async () => {
    const f = await newForm("0525550602");
    let html = await page(f.token);
    expect(html).toContain('data-order-step="1"');
    expect(html).toContain("Step 1 of 3");
    expect(html).toContain("Hi Rina, here is your order");
    expect(html).toContain("2 × Wireless fridge sensor");
    expect(html).toMatch(/₪590\.00 per device<\/bdi> · <bdi>SNS-200<\/bdi>/);
    expect(html).toContain("VAT 18%");
    expect(html).toContain("data-recurring-block");
    expect(html).toContain("You can choose a later date in step 3.");
    expect(html).toContain("Estimated delivery: ");
    expect(html).not.toContain("data-change-chat");
    expect(html).toContain("Something wrong? Reply to us in the chat");
    expect(html).not.toContain('name="full_name"');
    await ensureChatLink(db, { userId: me.id, actingAs: false }, acc.id, f.leadId);
    html = await page(f.token);
    expect(html).toMatch(/href="\/chat\/[^"]+" data-change-chat="">Something wrong\? Ask for a change in the chat/);
  });

  it("navigation: continue saves the step; step 3 needs step 2; errors per field with a summary; back keeps the input; resume at the same step", async () => {
    const f = await newForm("0525550603");
    // A direct link to step 3 with step 2 incomplete shows step 2.
    expect(await page(f.token, { step: "3" })).toContain('data-order-step="2"');
    expect(await post(f.token, 1, { intent: "continue" })).toBe(`/f/${f.token}?lang=en&step=2`);
    expect(await draftOf(f.form.id)).toMatchObject({ step: 2 });
    // Prefilled with source tags.
    let html = await page(f.token, { step: "2" });
    expect(html).toMatch(/Company name<span class="b-from" data-source="chat">.*From your chat<\/span>/);
    expect(html).toMatch(/Email for the invoice<span class="b-from" data-source="request">From your request<\/span>/);
    expect(tag(html, "company_id")).toContain('value=""');
    expect(tag(html, "invoice_email")).toContain('dir="ltr"');
    // Continue with the company ID missing and a bad email: back to step 2 with the errors.
    const bad = { ...company, company_id: "", invoice_email: "rina@" };
    expect(await post(f.token, 2, { ...bad, intent: "continue" })).toBe(`/f/${f.token}?lang=en&step=2&check=1`);
    html = await page(f.token, { step: "2", check: "1" });
    expect(html).toContain("2 fields need your attention before you continue.");
    expect(html).toContain("Enter the company ID");
    expect(html).toContain("Enter a valid email, like name@company.com");
    expect(tag(html, "company_id")).toContain('aria-invalid="true"');
    expect(html).toContain('value="rina@"');
    expect(await page(f.token, { step: "3" })).toContain('data-order-step="2"');
    // A changed value loses its source tag.
    await post(f.token, 2, { ...company, company_name: "Rina Kitchens", intent: "continue" });
    html = await page(f.token, { step: "2" });
    expect(html).not.toMatch(/Company name<span class="b-from"/);
    expect(html).toContain('value="Rina Kitchens"');
    // Step 3, then back by the progress bar: what was typed on step 3 is kept.
    expect(await post(f.token, 3, { delivery_address: "Port 4, Haifa", delivery_when: "asap", intent: "goto:1" })).toBe(`/f/${f.token}?lang=en&step=1`);
    html = await page(f.token, { step: "3" });
    expect(html).toContain('value="Port 4, Haifa"');
    expect(html).toContain("<bdi>Rina Kitchens</bdi>");
    // No step in the link: resume where the buyer left off (step 1 after going back).
    expect(await page(f.token)).toContain('data-order-step="1"');
    await post(f.token, 1, { intent: "continue" });
    expect(await page(f.token)).toContain('data-order-step="2"');
    // Nothing is signed before step 3 completes.
    expect(await db.select().from(signatures).where(eq(signatures.orderFormId, f.form.id))).toHaveLength(0);
    expect((await loadForm(db, f.token))?.state).toBe("open");
  });

  it("step 3: delivery dates from the plan (business days from the earliest estimate), terms with versions, signing as, test notice", async () => {
    const f = await newForm("0525550604");
    await post(f.token, 2, { ...company, intent: "continue" });
    const html = await page(f.token, { step: "3" });
    const c = deliveryChoices(frozenPlan((f.form.snapshot as { delivery?: unknown }).delivery)!, new Date());
    expect(html).toContain('data-order-step="3"');
    expect(html).toContain(`data-delivery-choice="${c.first}/${c.dates[c.dates.length - 1]}"`);
    const offered = [...html.matchAll(/name="delivery_date" value="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
    expect(offered).toEqual(c.dates);
    // Weekends of the market (Friday, Saturday) are never offered.
    expect(offered.every((d) => ![5, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);
    expect(tag(html, "delivery_when", "asap")).toContain('checked=""');
    expect(tag(html, "delivery_when", "date")).not.toContain("checked");
    expect(html).toContain("a preference; we confirm the exact day by message");
    expect(tag(html, "delivery_same")).toContain('checked=""');
    expect(html).toContain("<bdi>Sales terms</bdi>");
    expect(html).toContain("v1");
    expect(html).toMatch(/Signing as <\/span><b><bdi>Rina Cohen, Owner<\/bdi><\/b><span>, for <\/span><b><bdi>Rina&#x27;s Kitchen Ltd<\/bdi><\/b>/);
    expect(html).toContain("Test mode.");
    expect(html).toContain("Sign and pay ₪");
    expect(tag(html, "agreed")).not.toContain("checked");
  });

  it("holidays of the market are not offered", async () => {
    const [home] = await db.select().from(markets).where(and(eq(markets.accountId, acc.id), eq(markets.isHome, true)));
    const probe = await newForm("0525550605");
    const c0 = deliveryChoices(frozenPlan((probe.form.snapshot as { delivery?: unknown }).delivery)!, new Date());
    const holiday = c0.dates[1];
    await db.update(markets).set({ overrides: { ...(home.overrides ?? {}), holidays: [holiday] } }).where(eq(markets.id, home.id));
    try {
      const f = await newForm("0525550606");
      await post(f.token, 2, { ...company, intent: "continue" });
      const html = await page(f.token, { step: "3" });
      expect(html).not.toContain(`name="delivery_date" value="${holiday}"`);
      expect(html).toContain(`<span class="b-cal__off`);
      expect(await post(f.token, 3, { delivery_when: "date", delivery_date: holiday, agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en&step=3&check=1`);
      expect(await page(f.token, { step: "3", check: "1" })).toContain("Choose one of the dates shown");
    } finally {
      await db.update(markets).set({ overrides: home.overrides }).where(eq(markets.id, home.id));
    }
  });

  it("signing: errors keep the form open; a valid sign freezes the preferred date on the order, the record and the seller's order detail", async () => {
    const f = await newForm("0525550607");
    await post(f.token, 2, { ...company, intent: "continue" });
    const c = deliveryChoices(frozenPlan((f.form.snapshot as { delivery?: unknown }).delivery)!, new Date());
    const saturday = c.weeks.flat().find((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === 6)!.date;
    // A weekend date and no agreement: nothing is signed.
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "date", delivery_date: saturday, intent: "sign" })).toBe(`/f/${f.token}?lang=en&step=3&check=1`);
    let html = await page(f.token, { step: "3", check: "1" });
    expect(html).toContain("2 fields need your attention before you continue.");
    expect(html).toContain("Please confirm you agree to the terms.");
    expect(tag(html, "agreed")).toContain('aria-invalid="true"');
    expect(tag(html, "agreed")).not.toContain("checked");
    // "On a date I choose" without a date.
    await post(f.token, 3, { delivery_same: "on", delivery_when: "date", agreed: "on", intent: "sign" });
    expect(await page(f.token, { step: "3", check: "1" })).toContain("Choose a date, or choose As soon as possible");
    expect((await loadForm(db, f.token))?.state).toBe("open");
    // A valid date: signed, then payment.
    const date = c.dates[3];
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "date", delivery_date: date, agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    const view = await loadForm(db, f.token);
    if (view?.state !== "signed") throw new Error("not signed");
    expect(view.order).toMatchObject({ deliveryPreference: "date", preferredDeliveryDate: date });
    const [sig] = await db.select().from(signatures).where(eq(signatures.orderFormId, f.form.id));
    expect(sig.buyerFields).toMatchObject({ company_name: "Rina's Kitchen Ltd", delivery_address: "8 Dizengoff St, Tel Aviv" });
    expect(sig.legalVersions).toEqual([{ key: "sales_terms", version: 1 }]);
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, f.leadId), eq(leadEvents.type, "order_form.signed")));
    expect(ev.data).toMatchObject({ deliveryPreference: "date", preferredDeliveryDate: date });
    html = await page(f.token);
    expect(html).toContain("Preferred delivery date: ");
    expect(html).toContain(`data-delivery-pref="${date}"`);
    const doc = renderToStaticMarkup(await SignedDocumentPage({ params: Promise.resolve({ token: f.token }), searchParams: Promise.resolve({}) }));
    expect(doc).toContain(`data-delivery-pref="${date}"`);
    const seller = renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ tab: "orders", quote: f.quoteId }) }));
    expect(seller).toContain(`data-detail-delivery-pref="${date}"`);
    expect(seller).toContain("Buyer&#x27;s preferred delivery date: ");
    expect(seller).toContain("(a preference, not a promise)");
  });

  it("as soon as possible is the default and is recorded; forms without a lead time record no preference", async () => {
    const f = await newForm("0525550608");
    await post(f.token, 2, { ...company, intent: "continue" });
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    const [o] = await db.select().from(orders).where(eq(orders.orderFormId, f.form.id));
    expect(o).toMatchObject({ deliveryPreference: "asap", preferredDeliveryDate: null });
    const seller = renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ tab: "orders", quote: f.quoteId }) }));
    expect(seller).toContain("Buyer&#x27;s delivery preference: as soon as possible");

    await db.update(sellerAccounts).set({ deliveryLeadTime: null }).where(eq(sellerAccounts.id, acc.id));
    try {
      const g = await newForm("0525550609");
      await post(g.token, 2, { ...company, intent: "continue" });
      const html = await page(g.token, { step: "3" });
      expect(html).not.toContain("data-delivery-choice");
      expect(html).toContain('name="delivery_address"');
      const r = await signForm(db, g.token, { fields: { ...company, delivery_address: "x" }, fullName: "Rina Cohen", role: "Owner", agreed: true, delivery: { kind: "date", date: "2026-12-02" } }, {});
      expect(r.ok).toBe(true);
      const [og] = await db.select().from(orders).where(eq(orders.orderFormId, g.form.id));
      expect(og).toMatchObject({ deliveryPreference: null, preferredDeliveryDate: null });
    } finally {
      await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc.id));
    }
  });

  it("a company error found at signing goes back to step 2", async () => {
    const f = await newForm("0525550610");
    await post(f.token, 2, { ...company, intent: "continue" });
    // The draft is changed behind the step guard (e.g. an older tab): signing still validates everything.
    await db.update(orderForms).set({ draft: { step: 3, fields: { company_name: "Rina's Kitchen Ltd" }, fullName: "Rina Cohen", role: "Owner" } }).where(eq(orderForms.id, f.form.id));
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en&step=2&check=1`);
    expect((await loadForm(db, f.token))?.state).toBe("open");
  });

  it("a new quote version restarts at step 1 with the company details kept; the old link shows 'updated'", async () => {
    const f = await newForm("0525550611");
    await post(f.token, 2, { ...company, company_id: "599999999", intent: "continue" });
    const v = await createQuoteVersion(db, acc.id, human(), f.quoteId, { lines: [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10", qty: 1 }], discountBp: 0, changeNote: "3 sensors" });
    if (!v.ok) throw new Error(v.reason);
    const g = await createOrderForm(db, acc.id, human(), f.quoteId);
    if (!g.ok) throw new Error(g.reason);
    expect(await page(f.token)).toContain("The offer was updated");
    expect(await draftOf(g.form.id)).toMatchObject({ step: 1, fields: { company_id: "599999999" }, fullName: "Rina Cohen" });
    expect(await page(g.token)).toContain('data-order-step="1"');
    expect(await page(g.token, { step: "2" })).toContain('value="599999999"');
  });

  it("price changed and paused states win over any step; a replaced form takes no draft", async () => {
    const f = await newForm("0525550612");
    const [home] = await db.select().from(markets).where(and(eq(markets.accountId, acc.id), eq(markets.isHome, true)));
    await republishPricing(db, acc.id, home.priceListLineageId!, [{ sku: "SNS-200", oneTime: 61_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }]);
    expect(await page(f.token, { step: "2" })).toContain("The price has changed");
    // Signing from a stale step 3 is refused and lands on the price-change screen.
    await db.update(orderForms).set({ draft: { step: 3, fields: { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St", invoice_email: "rina@kitchen.test" }, fullName: "Rina Cohen", role: "Owner" } }).where(eq(orderForms.id, f.form.id));
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    expect((await loadForm(db, f.token))?.state).toBe("open");
  });

  it("renders in Hebrew right to left: step names, labels, source tags and left-to-right email and company ID", async () => {
    const f = await newForm("0525550613");
    const he = await page(f.token, { step: "2", lang: "he" });
    expect(he).toContain('dir="rtl"');
    expect(he).toContain("שלב 2 מתוך 3");
    expect(he).toContain("החברה שלך");
    expect(he).toContain("מהצ׳אט");
    expect(he).toContain("מהפנייה שלך");
    expect(he).toContain("מי חותם/ת");
    expect(tag(he, "company_id")).toMatch(/inputMode="numeric".*dir="ltr"/);
    // The language switch submits the step form (UX sign-off G1): back to English on the same step.
    expect(he).toContain('form="b-step-form" value="lang:en" lang="en" data-lang-switch="en" name="intent">EN</button>');
    const he1 = await page(f.token, { lang: "he" });
    expect(he1).toContain("ההזמנה שלך");
    expect(he1).toContain("המשך");
    expect(he1).toContain("מע&quot;מ 18%");
  });

  it("the step action refuses a signed form and never writes its draft", async () => {
    const f = await newForm("0525550614");
    await post(f.token, 2, { ...company, intent: "continue" });
    await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" });
    const before = await draftOf(f.form.id);
    expect(await post(f.token, 2, { ...company, company_name: "Changed", intent: "continue" })).toBe(`/f/${f.token}?lang=en`);
    expect(await draftOf(f.form.id)).toEqual(before);
    expect(await post("not-a-token", 2, { intent: "continue" })).toBe("/f/not-a-token?lang=en");
  });

  it("language switch (UX sign-off G1): a submit button of the step form that saves the step unchecked and reloads it in the other language", async () => {
    const f = await newForm("0525550615");
    await post(f.token, 1, { intent: "continue" });
    let html = await page(f.token, { step: "2" });
    // EN / HE are submit buttons of the step form; the hidden default button (Enter) comes first in tree order.
    expect(html).toContain('<form id="b-step-form"');
    expect(html).toMatch(/<button type="submit" form="b-step-form" value="continue" class="b-sr" tabindex="-1" aria-hidden="true" name="intent"><\/button><nav class="b-lang"[^>]*><button type="submit" form="b-step-form" value="lang:en" lang="en" aria-current="true" data-lang-switch="en" name="intent">EN<\/button><button type="submit" form="b-step-form" value="lang:he" lang="he" data-lang-switch="he" name="intent">/);
    expect(html).not.toMatch(/<a href="\/f\/[^"]+\?lang=he/);
    // Half-typed and invalid: saved as typed, no check, same step in Hebrew.
    expect(await post(f.token, 2, { company_name: "Rina Kitchens", company_id: "", invoice_email: "rina@", intent: "lang:he" })).toBe(`/f/${f.token}?lang=he&step=2`);
    expect(await draftOf(f.form.id)).toMatchObject({ step: 2, fields: { company_name: "Rina Kitchens", invoice_email: "rina@" } });
    html = await page(f.token, { lang: "he", step: "2" });
    expect(html).toContain('data-order-step="2"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('value="Rina Kitchens"');
    expect(html).not.toContain('aria-invalid="true"');
    // Step 3 switches back, keeping the delivery choice and the address.
    await post(f.token, 2, { ...company, intent: "continue" });
    expect(await post(f.token, 3, { delivery_address: "Port 4, Haifa", delivery_when: "asap", intent: "lang:en" }, "he")).toBe(`/f/${f.token}?lang=en&step=3`);
    html = await page(f.token, { step: "3" });
    expect(html).toContain('value="Port 4, Haifa"');
    expect(html).toMatch(/value="sign" class="b-sr"/);
    // Unknown languages fall back to English; a signed form's page keeps plain links.
    expect(await post(f.token, 3, { intent: "lang:xx" })).toBe(`/f/${f.token}?lang=en&step=3`);
    await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" });
    html = await page(f.token);
    expect(html).not.toContain("data-lang-switch");
    expect(html).toMatch(/<a href="\/f\/[^"]+\?lang=he" lang="he">/);
  });

  it("step 3 says how to get a later delivery date (UX sign-off G2), in English and Hebrew", async () => {
    const f = await newForm("0525550616");
    await post(f.token, 2, { ...company, intent: "continue" });
    const en = await page(f.token, { step: "3" });
    expect(en).toContain('<span class="b-mut b-calnote" data-later-date="">Need a later date? Write to us in the chat.</span>');
    expect(en.indexOf("data-later-date")).toBeGreaterThan(en.indexOf("data-delivery-choice"));
    expect(await page(f.token, { step: "3", lang: "he" })).toContain("צריכים תאריך מאוחר יותר? כתבו לנו בצ׳אט.");
  });
});
