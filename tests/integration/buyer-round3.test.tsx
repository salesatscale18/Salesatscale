/** Round-3 review, lane R3-2 (buyer pages): A3, A4 and B6 on PGlite. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { leads, orderForms, sellerAccounts, users, type OrderSnapshot, type SellerAccount, type User } from "@/db/schema";
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
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "198.51.100.7", "user-agent": "test" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));

const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { default: SignedDocumentPage } = await import("@/app/f/[token]/document/page");
const { stepAction, payCardAction } = await import("@/app/f/[token]/actions");
const { buyerDate, buyerTime } = await import("@/app/f/[token]/time");
const { QuoteCard } = await import("@/components/sas/quote-card");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createOrderForm } = await import("@/lib/orders/service");
const { createQuote } = await import("@/lib/quotes/service");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");

const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
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
const tag = (html: string, name: string) => [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]).find((x) => x.includes(`name="${name}"`)) ?? "";
const labelOf = (html: string, name: string) => html.match(new RegExp(`<label class="b-lbl" for="f-${name}">.*?</label>`))?.[0] ?? "";
/** Hebrew short month names ("בנוב׳", "בדצמ׳"). */
const HE_SHORT_MONTH = /ב(ינו|פבר|אפר|אוג|ספט|אוק|נוב|דצמ)׳/;
const company = { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "1 Test St, Tel Aviv", invoice_email: "rina@kitchen.test", full_name: "Rina Cohen", signatory_role: "Owner" };
const css = readFileSync("app/f/[token]/buyer.css", "utf8");

describe("buyer pages, round-3 review", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const human = () => ({ kind: "human" as const, userId: me.id, actingAs: false });
  const page = async (token: string, sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));
  const doc = async (token: string, sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await SignedDocumentPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));
  const post = (token: string, step: number, v: Record<string, string>, lang = "en") => redirectOf(stepAction(fd({ token, lang, step: String(step), ...v })));
  const newForm = async (phone: string, opts: { simulated?: boolean } = {}) => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen Ltd", email: "rina@kitchen.test", phone, language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const l = await upsertLead(db, acc.id, { userId: me.id, actingAs: false }, p.value, "manual");
    if (!l.ok) throw new Error();
    if (opts.simulated) await db.update(leads).set({ buyerRef: `SIM-${phone.slice(-4)}` }).where(eq(leads.id, l.lead.id));
    const q = await createQuote(db, acc.id, human(), l.lead.id, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const f = await createOrderForm(db, acc.id, human(), q.quote.id);
    if (!f.ok) throw new Error(f.reason);
    return { leadId: l.lead.id, number: q.quote.number, ...f };
  };
  /** Rewrites the frozen snapshot (to stand for a form made under an older rule). */
  const patchSnapshot = async (formId: string, change: (s: OrderSnapshot) => OrderSnapshot) => {
    const [row] = await db.select({ snapshot: orderForms.snapshot }).from(orderForms).where(eq(orderForms.id, formId));
    await db.update(orderForms).set({ snapshot: change(row.snapshot) }).where(eq(orderForms.id, formId));
  };
  const signed = async (phone: string) => {
    const f = await newForm(phone);
    await post(f.token, 2, { ...company, intent: "continue" });
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    return f;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, legalName: "Polar Demo Ltd", supportContact: "support@polar.test" }).where(eq(sellerAccounts.id, acc.id));
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "SNS-200 wireless sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "GW-10 gateway", plainName: "kitchen hub", unit: "site" },
    ]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    // The privacy notice is saved first, so the account's own order puts it before the sales terms.
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "privacy", title: "Privacy notice", language: "en", body: "Privacy." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "privacy", title: "הודעת פרטיות", language: "he", body: "פרטיות." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים." });
  });
  afterAll(async () => t.close());

  it("A3: free-text inputs take their direction from the text (Hebrew step 2 keeps '1 Test St, Tel Aviv' in order); digits stay left-to-right", async () => {
    const f = await newForm("0525560701");
    await post(f.token, 2, { ...company, intent: "continue" }, "he");
    const he = await page(f.token, { step: "2", lang: "he" });
    for (const k of ["company_name", "billing_address", "invoice_email", "full_name", "signatory_role"]) {
      expect(tag(he, k)).toContain('class="b-inp b-inp--free"');
      expect(tag(he, k)).not.toContain("dir=");
    }
    expect(tag(he, "billing_address")).toContain('value="1 Test St, Tel Aviv"');
    expect(tag(he, "company_id")).toContain('dir="ltr"');
    const step3 = await page(f.token, { step: "3", lang: "he" });
    expect(tag(step3, "delivery_address")).toContain("b-inp--free");
    // The rule: the paragraph direction comes from the text; empty fields and placeholders stay at the start.
    expect(css).toMatch(/\.b-inp--free \{ unicode-bidi: plaintext; text-align: start; \}/);
  });

  it("A4: one tag rule in both languages, also on a form frozen before 'From your request'; saving keeps tags, changing a value drops it", async () => {
    const f = await newForm("0525560702", { simulated: true });
    // A form made before 18 Nov: the snapshot froze no tags for the simulated buyer's request values.
    await patchSnapshot(f.form.id, (s) => ({ ...s, prefillSource: {} }));
    await post(f.token, 1, { intent: "continue" });
    for (const lang of ["en", "he"]) {
      const html = await page(f.token, { step: "2", lang });
      for (const k of ["company_name", "invoice_email", "full_name"]) expect(labelOf(html, k)).toContain('data-source="request"');
      expect(html).toContain(lang === "he" ? "מהפנייה שלך" : "From your request");
    }
    // The buyer saves step 2 in Hebrew with the same values and changes the email: the other tags stay, in both languages.
    await post(f.token, 2, { ...company, invoice_email: "orders@kitchen.test", intent: "goto:1" }, "he");
    for (const lang of ["en", "he"]) {
      const html = await page(f.token, { step: "2", lang });
      expect(labelOf(html, "company_name")).toContain('data-source="request"');
      expect(labelOf(html, "full_name")).toContain('data-source="request"');
      expect(labelOf(html, "invoice_email")).not.toContain("data-source");
    }
    // A seller's own lead (not simulated, not a website request) has no tags, old snapshot or new.
    const real = await newForm("0525560703");
    await post(real.token, 1, { intent: "continue" });
    expect(await page(real.token, { step: "2", lang: "he" })).not.toContain("data-source");
  });

  it("B6: one label for the monthly amount on the form, summary, paid page and document, in both languages", async () => {
    const f = await signed("0525560704");
    const fresh = await newForm("0525560705");
    await post(fresh.token, 1, { intent: "continue" });
    for (const [lang, label] of [["en", "Monthly incl. VAT"], ["he", "חודשי כולל מע״מ"]] as const) {
      expect(await page(fresh.token, { step: "1", lang })).toContain(`data-recurring-total=""><span>${label}</span>`);
      expect(await page(fresh.token, { step: "2", lang })).toContain(`data-summary-monthly=""><span>${label}</span>`);
      expect(await doc(f.token, { lang })).toContain(`data-recurring-total=""><span>${label}</span>`);
    }
    expect(await redirectOf(payCardAction(fd({ token: f.token, lang: "en", outcome: "succeeded", recurring: "on" })))).toBe(`/f/${f.token}?lang=en`);
    const paid = await page(f.token);
    expect(paid).toContain('data-recurring-total=""><span>Monthly incl. VAT</span>');
    expect(paid).not.toContain("Monthly total");
    expect(await page(f.token, { lang: "he" })).not.toContain("סה״כ חודשי");
  });

  it("B6: full month names in Hebrew on the buyer pages; time zones in sentence case", async () => {
    const at = new Date("2026-11-25T10:00:00Z");
    expect(buyerDate(at, "Asia/Jerusalem", "he")).toBe("25 בנובמבר 2026");
    expect(buyerDate(at, "Asia/Jerusalem", "en")).toBe("25 Nov 2026");
    expect(buyerTime(at, "Asia/Jerusalem", "en")).toBe("12:00 Israel time");
    expect(buyerTime(at, "Asia/Jerusalem", "he")).toBe("12:00 שעון ישראל");
    const f = await newForm("0525560706");
    for (const step of ["1", "2", "3"]) {
      if (step === "3") await post(f.token, 2, { ...company, intent: "continue" }, "he");
      const html = await page(f.token, { step, lang: "he" });
      expect(html).not.toMatch(HE_SHORT_MONTH);
    }
    const step2 = await page(f.token, { step: "2", lang: "he" });
    expect(step2).toMatch(/בתוקף עד \d{1,2} ב[א-ת]+ \d{4}/);
    expect(await page(f.token, { step: "2" })).not.toContain("Israel Time");
  });

  it("B6: legal texts in one order (sales terms first) on step 3 and the signed document, in both languages", async () => {
    const f = await newForm("0525560707");
    // The account's order (as frozen) puts the privacy notice first.
    await patchSnapshot(f.form.id, (s) => ({ ...s, legal: [...s.legal].sort((a) => (a.key === "privacy" ? -1 : 1)) }));
    await post(f.token, 2, { ...company, intent: "continue" });
    const step3 = await page(f.token, { step: "3" });
    expect(step3.indexOf("Sales terms")).toBeGreaterThan(-1);
    expect(step3.indexOf("Sales terms")).toBeLessThan(step3.indexOf("Privacy notice"));
    const he3 = await page(f.token, { step: "3", lang: "he" });
    // In Hebrew the titles come from the Hebrew version of each section.
    expect(he3.indexOf("תנאי מכירה")).toBeGreaterThan(-1);
    expect(he3.indexOf("תנאי מכירה")).toBeLessThan(he3.indexOf("הודעת פרטיות"));
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    for (const lang of ["en", "he"]) {
      const d = await doc(f.token, { lang });
      const terms = d.slice(d.indexOf("b-terms"));
      expect(terms.indexOf("Sales terms")).toBeLessThan(terms.indexOf("Privacy notice"));
      // The record line too.
      const record = d.match(/(IP address|כתובת IP)[^<]*/)?.[0] ?? "";
      expect(record.indexOf("Sales terms")).toBeLessThan(record.indexOf("Privacy notice"));
    }
  });

  it("B6: the signed document names versions one way per language (v1 / גרסה 1) and IDs have no extra spacing", async () => {
    const f = await signed("0525560708");
    const en = await doc(f.token);
    expect(en).toMatch(new RegExp(`<span data-doc-ids=""><bdi class="b-id">Q-${f.number}</bdi> v1 · <bdi class="b-id">PD-\\d+</bdi></span>`));
    expect(en).not.toContain("גרסה");
    expect(en).toContain("\u2068Sales terms\u2069 v1");
    const he = await doc(f.token, { lang: "he" });
    expect(he).toContain(`<bdi class="b-id">Q-${f.number}</bdi> גרסה 1 · `);
    expect(he).toContain("\u2068Sales terms\u2069 גרסה 1");
    expect(he).not.toMatch(/ v1\b/);
    expect(he).not.toMatch(HE_SHORT_MONTH);
    expect(css).toMatch(/\.b-id \{ font-variant-numeric: normal; letter-spacing: 0;/);
    // The quote card's header ref: plain figures, not the tabular amounts.
    const card = renderToStaticMarkup(createElement(QuoteCard, { card: {
      messageId: "m", quoteId: "q", leadId: "l", state: "sent", lang: "en", dir: "ltr", seller: "Polar Demo", initials: "PD", brand: "#0f6b5a",
      label: "Quote Q-1003", title: "Your quote", ref: "Q-1003", sub: null, headline: null, headlineName: null, lines: [], fold: null, more: null, rows: [],
      total: { label: "Total", amount: "₪1.00" }, afterTotal: null, monthly: null, delivery: null, deliveryDate: null, firstCharge: null, validUntil: null,
      status: null, summary: null, sellerOnly: null, approval: null,
    } }));
    expect(card).toContain('<span class="sas-qc__ref">Q-1003</span>');
    expect(readFileSync("components/sas/quote-card.css", "utf8")).toMatch(/\.sas-qc__ref \{ font-variant-numeric: normal; letter-spacing: 0;/);
  });

  it("B6: the test banner only on the payment and paid pages (step 3 keeps its notice); English pay page renders", async () => {
    const f = await newForm("0525560709");
    expect(await page(f.token, { step: "1" })).not.toContain("data-test-strip");
    await post(f.token, 1, { intent: "continue" });
    expect(await page(f.token, { step: "2" })).not.toContain("data-test-strip");
    await post(f.token, 2, { ...company, intent: "continue" });
    const step3 = await page(f.token, { step: "3" });
    expect(step3).not.toContain("data-test-strip");
    expect(step3).toContain('data-test-notice=""');
    expect(await post(f.token, 3, { delivery_same: "on", delivery_when: "asap", agreed: "on", intent: "sign" })).toBe(`/f/${f.token}?lang=en`);
    // The English payment page.
    const pay = await page(f.token);
    expect(pay).toContain('<div class="b-strip" role="note" data-test-strip="">Test payment. No real card is charged.</div>');
    expect(pay).toContain('data-signed-banner=""');
    expect(pay).toMatch(/Signed by Rina Cohen · \d{2}:\d{2} Israel time/);
    expect(pay).toMatch(/<span>Due today<\/span><span class="b-num"[^>]*>₪\d[\d,]*\.\d{2}<\/span>/);
    expect(pay).toContain("Then monthly, from activation");
    expect(pay).toMatch(/<nav class="b-tabs"[^>]*><a [^>]*aria-current="true">Card<\/a>/);
    expect(pay).toContain('value="succeeded"');
    expect(pay).toContain(">View signed form</a>");
    expect(pay).toContain('data-support=""');
    expect(await doc(f.token)).not.toContain("b-strip");
    expect(await redirectOf(payCardAction(fd({ token: f.token, lang: "en", outcome: "succeeded", recurring: "on" })))).toBe(`/f/${f.token}?lang=en`);
    const paid = await page(f.token);
    expect(paid).toContain("data-test-strip");
    expect(paid).toContain('class="b-center b-paid"');
  });

  it("B6 desktop: step 1 centres its column; 'Questions?' sits in the form column", async () => {
    const f = await newForm("0525560710");
    const html = await page(f.token, { step: "1" });
    expect(html).toMatch(/<div class="b-layout b-layout--solo"><div class="b-col"><form [^]*<\/form><div class="b-help b-noprint" data-support="">/);
    expect(css).toMatch(/\.b-layout--solo \{ grid-template-columns: minmax\(0, 560px\); justify-content: center; \}/);
    expect(css).toMatch(/\.b-layout \.b-help \{ align-items: flex-start; text-align: start; padding-inline: 0; \}/);
  });
});
