/**
 * The seller's quote editor (app/app/[account]/leads/[leadId]/quote): the live
 * preview prices from the market's live price list exactly as saving does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { orderForms, quoteLines, quoteVersions, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { previewQuoteAction, saveQuoteAction } = await import("@/app/app/[account]/leads/[leadId]/quote/actions");
const { default: QuoteEditorPage } = await import("@/app/app/[account]/leads/[leadId]/quote/page");
const { renderToStaticMarkup } = await import("react-dom/server");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const idle = { status: "idle" as const };
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};

describe("quote editor: preview and save from the market's price list", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: SellerAccount, accB: SellerAccount;
  let leadA = "", leadB = "";
  const as = (account: SellerAccount) => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; };
  const page = async (account: SellerAccount, leadId: string) =>
    renderToStaticMarkup(await QuoteEditorPage({ params: Promise.resolve({ account: account.slug, leadId }), searchParams: Promise.resolve({}) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      const account = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
      const l = parseLead({ fullName: "Rina Cohen", phone: "0521234567", consent: "yes", consentSource: "form" }, "IL", { language: "he", now: new Date() });
      if (!l.ok) throw new Error();
      const r = await upsertLead(db, account.id, { userId: admin.id, actingAs: false }, l.value, "manual", { now: new Date() });
      if (!r.ok) throw new Error();
      return { account, lead: r.lead.id };
    };
    ({ account: accA, lead: leadA } = await mk("Alpha"));
    ({ account: accB, lead: leadB } = await mk("Beta"));
    await seedCatalog(db, accA.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
      { sku: "KIT-1", name: "Starter kit", unit: "kit" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" },
      { sku: "EXPORT-ONLY", name: "Export kit", unit: "item" },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
    ]);
  });
  afterAll(async () => t.close());

  it("no_price_list: preview, save and page say so and link to price lists", async () => {
    as(accA);
    const f = { slug: accA.slug, leadId: leadA, "qty:GW-10": "1" };
    const pv = await previewQuoteAction(form(f));
    expect(pv).toEqual({
      status: "errors",
      messages: ["This lead's market has no live price list yet. Publish a price list and assign it to the market."],
      link: { href: `/app/${accA.slug}/setup/price-lists`, label: "Open price lists" },
    });
    expect(await run(saveQuoteAction(idle, form({ ...f, idem: "np-1" })))).toEqual({ status: "error", messages: (pv as { messages: string[] }).messages, link: (pv as { link: unknown }).link });
    const html = await page(accA, leadA);
    expect(html).toContain(`href="/app/${accA.slug}/setup/price-lists"`);
    expect(html).not.toContain('id="qe-add"');
  });

  it("the picker shows live price list prices; items not in the list are disabled", async () => {
    await seedPricing(db, accA.id, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000 },
      { sku: "KIT-1", oneTime: 100_000, recurring: 50_000, period: "year" },
      { sku: "SVC-INST", oneTime: 25_000 },
    ], { userId: admin.id, currency: "EUR", name: "Europe EUR" });
    as(accA);
    const html = await page(accA, leadA);
    expect(html).toContain('id="qe-add"');
    expect(html).toContain("Europe EUR v1");
    expect(html).toContain("Site gateway · GW-10 · €660.00</option>");
    expect(html).toContain("Starter kit · KIT-1 · €1,000.00 + €500.00/year</option>");
    expect(html).toMatch(/<option value="EXPORT-ONLY" disabled="">Export kit · EXPORT-ONLY · Not sold in this market<\/option>/);
    expect(html).not.toContain("₪");
  });

  it("the preview matches the saved quote, per charge, with the auto-added fee", async () => {
    as(accA);
    const f = { slug: accA.slug, leadId: leadA, "qty:GW-10": "2", "qty:SNS-200": "4", "qty:KIT-1": "1", sites: "2", discount: "5" };
    const pv = await previewQuoteAction(form(f));
    if (pv.status !== "ok") throw new Error(JSON.stringify(pv));
    expect(pv.currency).toBe("EUR");
    expect(pv.recurringPeriod).toBe("year");
    expect(pv.lines.map((l) => [l.sku, l.charge, l.period, l.qty, l.unitPriceMinor, l.autoAdded])).toEqual([
      ["GW-10", "one_time", null, 2, 66_000, false],
      ["SNS-200", "one_time", null, 4, 59_000, false],
      ["KIT-1", "one_time", null, 1, 100_000, false],
      ["KIT-1", "recurring", "year", 1, 50_000, false],
      ["SVC-INST", "one_time", null, 2, 25_000, true],
    ]);
    expect(pv.fitProblems).toEqual([]);

    const saved = await run(saveQuoteAction(idle, form({ ...f, idem: "match-1" })));
    const quoteId = /quote=([0-9a-f-]{36})/.exec((saved as { redirect: string }).redirect)![1];
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    expect(v.currency).toBe("EUR");
    expect({ subtotal: v.oneTimeSubtotalMinor, discount: v.oneTimeDiscountMinor, tax: v.oneTimeTaxMinor, total: v.oneTimeTotalMinor }).toEqual(pv.oneTime);
    expect({ subtotal: v.recurringSubtotalMinor, discount: v.recurringDiscountMinor, tax: v.recurringTaxMinor, total: v.recurringTotalMinor }).toEqual(pv.recurring);
    expect(v.recurringPeriod).toBe(pv.recurringPeriod);
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, v.id)).orderBy(quoteLines.sortOrder);
    expect(lines.map((l) => [l.sku, l.chargeType, l.period, l.qty, l.unitPriceMinor, l.lineTotalMinor]))
      .toEqual(pv.lines.map((l) => [l.sku, l.charge, l.period, l.qty, l.unitPriceMinor, l.lineTotalMinor]));
    // A new version opens with the server-computed preview, per charge, in the list's currency.
    const html = renderToStaticMarkup(await QuoteEditorPage({ params: Promise.resolve({ account: accA.slug, leadId: leadA }), searchParams: Promise.resolve({ from: quoteId }) }));
    expect(html).toContain("Due on signing");
    expect(html).toContain("Yearly");
    expect(html).toContain("€500.00/year");
    // The per-site fee is left to its rule (read-only, marked) and the site count comes back.
    expect(html).toContain("Added automatically");
    expect(html).not.toContain('id="q-SVC-INST"');
    expect(html).toMatch(/id="q-sites"[^>]*value="2"/);
  });

  it("an auto-added fee shows in the preview with no quantity picked for it", async () => {
    as(accA);
    const pv = await previewQuoteAction(form({ slug: accA.slug, leadId: leadA, "qty:GW-10": "3", sites: "3" }));
    if (pv.status !== "ok") throw new Error(JSON.stringify(pv));
    expect(pv.lines.filter((l) => l.autoAdded)).toEqual([
      expect.objectContaining({ sku: "SVC-INST", name: "Installation", qty: 3, charge: "one_time", unitPriceMinor: 25_000, lineTotalMinor: 75_000 }),
    ]);
    expect(pv.oneTime.subtotal).toBe(3 * 66_000 + 75_000);
  });

  it("not_sold: preview and save refuse an item missing from the market's price list", async () => {
    as(accA);
    const f = { slug: accA.slug, leadId: leadA, "qty:EXPORT-ONLY": "1" };
    const msg = "EXPORT-ONLY is not sold in this lead's market. Remove it, or add it to the market's price list.";
    expect(await previewQuoteAction(form(f))).toEqual({ status: "errors", messages: [msg] });
    expect(await run(saveQuoteAction(idle, form({ ...f, idem: "ns-1" })))).toEqual({ status: "error", messages: [msg] });
  });

  it("keeps fit problems and approval reasons in the preview", async () => {
    as(accA);
    const pv = await previewQuoteAction(form({ slug: accA.slug, leadId: leadA, "qty:SNS-200": "2", discount: "50" }));
    if (pv.status !== "ok") throw new Error(JSON.stringify(pv));
    expect(pv.fitProblems.length).toBe(1);
    expect(pv.fitProblems[0].fix).toMatchObject({ sku: "GW-10", name: "Site gateway" });
    expect(pv.approval.join(" ")).toMatch(/Discount 50\.0% is above/);
  });

  it("page header: Cancel goes back to the lead card; the search box is there", async () => {
    as(accA);
    const html = await page(accA, leadA);
    expect(html).toContain(`<a class="sas-btn sas-btn--ghost" href="/app/${accA.slug}/leads/${leadA}">Cancel</a>`);
    expect(html).toContain('id="qe-search"');
    expect(html).toContain("Wireless fridge sensor · SNS-200 · €590.00</option>");
  });

  it("Create and send goes on to the order form; Save as draft stops at the quote (created, not sent)", async () => {
    as(accA);
    const f = { slug: accA.slug, leadId: leadA, "qty:GW-10": "1", sites: "1" };
    const quoteOf = (r: unknown) => /quote=([0-9a-f-]{36})/.exec((r as { redirect: string }).redirect)![1];
    const formsOf = async (quoteId: string) => db.select().from(orderForms).where(eq(orderForms.quoteId, quoteId));

    const draft = await run(saveQuoteAction(idle, form({ ...f, intent: "draft", idem: "draft-1" })));
    expect((draft as { redirect: string }).redirect).toMatch(/\/orders\?quote=[0-9a-f-]{36}$/);
    expect(await formsOf(quoteOf(draft))).toEqual([]);

    // No legal text in the buyer's language yet: the quote is saved and the reason shows on the order page.
    const noLegal = await run(saveQuoteAction(idle, form({ ...f, intent: "send", idem: "send-1" })));
    expect((noLegal as { redirect: string }).redirect).toMatch(/\/orders\?quote=[0-9a-f-]{36}&send=no_legal$/);
    expect(await formsOf(quoteOf(noLegal))).toEqual([]);

    await saveLegalSection(db, accA.id, admin.id, { sectionKey: "sales_terms", title: "Sales terms", language: "he", body: "Terms" });
    const sent = await run(saveQuoteAction(idle, form({ ...f, intent: "send", idem: "send-2" })));
    expect((sent as { redirect: string }).redirect).toMatch(/&sent=1$/);
    expect(await formsOf(quoteOf(sent))).toHaveLength(1);
    // A repeated submit reuses the quote and does not send a second link.
    const again = await run(saveQuoteAction(idle, form({ ...f, intent: "send", idem: "send-2" })));
    expect(quoteOf(again)).toBe(quoteOf(sent));
    expect((again as { redirect: string }).redirect).not.toContain("sent=1");
    expect(await formsOf(quoteOf(sent))).toHaveLength(1);
  });

  it("account isolation: another account can not preview, quote or open this lead", async () => {
    await seedCatalog(db, accB.id, [{ sku: "GW-10", name: "Gateway B" }]);
    await seedPricing(db, accB.id, [{ sku: "GW-10", oneTime: 1_000 }], { userId: admin.id });
    as(accB);
    const f = { slug: accB.slug, leadId: leadA, "qty:GW-10": "1" };
    expect(await previewQuoteAction(form(f))).toEqual({ status: "errors", messages: ["This lead no longer exists."] });
    expect(await run(saveQuoteAction(idle, form({ ...f, idem: "iso-1" })))).toEqual({ status: "error", messages: ["This lead no longer exists."] });
    await expect(page(accB, leadA)).rejects.toThrow("NEXT_NOT_FOUND");
    // A quote of account A can not be versioned or previewed from account B.
    as(accA);
    const saved = await run(saveQuoteAction(idle, form({ slug: accA.slug, leadId: leadA, "qty:GW-10": "1", idem: "iso-a" })));
    const quoteA = /quote=([0-9a-f-]{36})/.exec((saved as { redirect: string }).redirect)![1];
    as(accB);
    expect(await previewQuoteAction(form({ ...f, leadId: leadB, fromQuote: quoteA }))).toEqual({ status: "errors", messages: ["This quote no longer exists."] });
    // B's own lead prices from B's own list.
    const own = await previewQuoteAction(form({ ...f, leadId: leadB }));
    expect(own).toMatchObject({ status: "ok", currency: "ILS", oneTime: { subtotal: 1_000 } });
  });
});
