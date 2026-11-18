/** Live-review polish (lane Polish-3): the buyer's order form, payment, paid page and signed document on PGlite. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { dealStates, leads, sellerAccounts, signatures, users, type SellerAccount, type User } from "@/db/schema";
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
const { buyerTime } = await import("@/app/f/[token]/time");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createOrderForm, snapshotOf } = await import("@/lib/orders/service");
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
const company = { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St, Tel Aviv", invoice_email: "rina@kitchen.test", full_name: "Rina Cohen", signatory_role: "Owner" };

describe("buyer pages after the live review", () => {
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
  const newForm = async (phone: string, opts: { simulated?: boolean; deal?: boolean } = {}) => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen Ltd", email: "rina@kitchen.test", phone, language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const l = await upsertLead(db, acc.id, { userId: me.id, actingAs: false }, p.value, "manual");
    if (!l.ok) throw new Error();
    // A simulated buyer (test chat): the seller plays the buyer's request.
    if (opts.simulated) await db.update(leads).set({ buyerRef: `SIM-${phone.slice(-4)}` }).where(eq(leads.id, l.lead.id));
    if (opts.deal) {
      await db.insert(dealStates).values({ accountId: acc.id, leadId: l.lead.id, fields: {
        company_name: { value: "rina's kitchen ltd", provenance: "inferred", updatedAt: "" },
      } });
    }
    const q = await createQuote(db, acc.id, human(), l.lead.id, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const f = await createOrderForm(db, acc.id, human(), q.quote.id);
    if (!f.ok) throw new Error(f.reason);
    return { leadId: l.lead.id, quoteId: q.quote.id, number: q.quote.number, ...f };
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
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, legalName: "Polar Demo Ltd" }).where(eq(sellerAccounts.id, acc.id));
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    // Chat names are stored lower-case on purpose (they go inside sentences).
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "SNS-200 wireless sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "GW-10 gateway", plainName: "kitchen hub", unit: "site" },
    ]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים." });
  });
  afterAll(async () => t.close());

  it("names start with a capital, the monthly line names the service, no 'v1', and step 1 has no side summary", async () => {
    const f = await newForm("0525550701");
    const html = await page(f.token);
    expect(html).toContain("<bdi>2 × Wireless fridge sensor</bdi>");
    expect(html).toContain("<bdi>1 × Kitchen hub</bdi>");
    expect(html).toContain('<span data-line-name=""><bdi>Kitchen hub</bdi> · monthly service</span>');
    expect(html).not.toContain("wireless fridge sensor");
    expect(html).toContain(`Order form · Q-${f.number}</span>`);
    expect(html).not.toContain(" v1");
    expect(html).not.toContain('class="b-summary"');
    expect(html).toContain('class="b-layout b-layout--solo"');
    // Amounts in the page font with tabular figures (buyer.css), Hebrew per month after the amount.
    const he = await page(f.token, { lang: "he" });
    expect(he).toContain("₪90.00 לחודש");
    expect(he).not.toContain("/חודש");
    expect(he).toContain("מה בהזמנה");
    expect(he).toContain('<span data-line-name=""><bdi>Kitchen hub</bdi> · שירות חודשי</span>');
  });

  it("step 2: summary with 'Monthly incl. VAT', placeholders on empty fields, the error banner and inline errors on Continue", async () => {
    const f = await newForm("0525550702");
    await post(f.token, 1, { intent: "continue" });
    let html = await page(f.token, { step: "2" });
    expect(html).toContain('class="b-summary"');
    expect(html).toContain('data-summary-monthly=""><span>Monthly incl. VAT</span>');
    expect(tag(html, "company_id")).toContain('placeholder="9 digits"');
    expect(tag(html, "billing_address")).toContain('placeholder="Street, number, city"');
    expect(tag(html, "signatory_role")).toContain('placeholder="For example, Owner"');
    // Continue with the required fields empty: back to step 2 with the banner and an error under each field.
    expect(await post(f.token, 2, { company_name: "", company_id: "", billing_address: "", invoice_email: "", full_name: "", signatory_role: "", intent: "continue" }))
      .toBe(`/f/${f.token}?lang=en&step=2&check=1`);
    html = await page(f.token, { step: "2", check: "1" });
    expect(html).toMatch(/data-error-summary="6"/);
    expect(html).toContain("6 fields need your attention before you continue.");
    for (const k of ["company_name", "company_id", "billing_address", "invoice_email", "full_name", "signatory_role"]) {
      expect(tag(html, k)).toContain(`aria-describedby="e-${k}"`);
      expect(html).toContain(`id="e-${k}"`);
    }
  });

  it("source tags: a simulated buyer's lead values are 'From your request'; a chat value equal to the lead's is 'From your chat'", async () => {
    const sim = await newForm("0525550703", { simulated: true, deal: true });
    expect(snapshotOf(sim.form).prefillSource).toEqual({ company_name: "chat", invoice_email: "request", signatory_name: "request" });
    const real = await newForm("0525550704");
    expect(snapshotOf(real.form).prefillSource).toEqual({});
    await post(sim.token, 1, { intent: "continue" });
    const html = await page(sim.token, { step: "2" });
    expect(html).toContain('data-source="chat"');
    expect(html).toContain('data-source="request"');
  });

  it("step 3: Back and Sign in one row, one test notice with the flask icon, the address in ink", async () => {
    const f = await newForm("0525550705");
    await post(f.token, 2, { ...company, intent: "continue" });
    const html = await page(f.token, { step: "3" });
    expect(html).not.toContain("b-cta--sign");
    expect(html).toMatch(/<div class="b-cta"><button[^>]*value="sign"[^>]*>Sign and pay ₪[^<]+<\/button><button type="submit" value="goto:2" class="b-btn b-btn--2"/);
    expect(html).not.toContain('class="b-strip"');
    expect(html.match(/data-test-notice=""/g)).toHaveLength(1);
    expect(html).toContain("lucide-flask-conical");
    expect(html).toContain('<span class="b-deliv__same" data-delivery-same="">');
  });

  it("pay, paid and document: one zone-named signing time, a pen on the signed banner, one Paid row, success hero, signed document order", async () => {
    const f = await signed("0525550706");
    const [sig] = await db.select().from(signatures).where(eq(signatures.orderFormId, f.form.id));
    const local = buyerTime(sig.signedAt, "Asia/Jerusalem", "en");
    expect(local).toMatch(/^\d{2}:\d{2} Israel Time$/);
    let html = await page(f.token);
    expect(html).toContain('data-signed-banner=""');
    expect(html).toContain("lucide-pen-line");
    expect(html).toContain(`Signed by Rina Cohen · ${local}`);
    expect(html).toContain(">View signed form</a>");
    // The selected payment method is primary-soft, not solid ink (buyer.css), and is marked current.
    expect(html).toMatch(/<nav class="b-tabs"[^>]*><a [^>]*aria-current="true">Card<\/a>/);
    expect(await redirectOf(payCardAction(fd({ token: f.token, lang: "en", outcome: "succeeded", recurring: "on" })))).toBe(`/f/${f.token}?lang=en`);
    html = await page(f.token);
    expect(html).toContain('class="b-center b-paid"');
    expect(html).toContain("lucide-circle-check");
    expect(html).toMatch(new RegExp(`Order PD-\\d+ \\(quote Q-${f.number}\\) is confirmed\\.`));
    expect(html).toContain("Paid today · Card");
    expect(html).not.toContain("Due today");
    expect(html.match(/Paid today/g)).toHaveLength(1);

    const d = await doc(f.token);
    expect(d).toContain('data-doc-seller=""');
    expect(d).toContain("<bdi>Polar Demo</bdi>");
    expect(d).toContain(`Signed by Rina Cohen, Owner, on `);
    expect(d).toContain(` at ${local}</b>`);
    expect(d).toMatch(/recorded <bdi data-doc-utc="">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/bdi>/);
    expect(d).toMatch(/Document fingerprint \(SHA-256\): <span class="b-mono" data-doc-hash="">[0-9a-f]{64}<\/span>/);
    expect(d).toContain("<bdi>2 × Wireless fridge sensor</bdi>");
    // The buyer's details in the form's field order.
    const order = [...d.matchAll(/data-doc-field="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"].filter((k) => order.includes(k)));
    expect(order.slice(0, 2)).toEqual(["company_name", "company_id"]);
  });
});
