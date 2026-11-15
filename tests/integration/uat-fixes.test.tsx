/** Regression tests for the UAT round 2 findings (Lane F): actions and rendered screens on PGlite. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { consentRecords, leads, markets, messages, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { republishPricing, seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, revalidated: [] as string[] }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { holder.revalidated.push(p); } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));

const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");
const { default: PriceListsPage } = await import("@/app/app/[account]/setup/price-lists/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { savePlaybookAction } = await import("@/app/app/[account]/setup/playbook/actions");
const { addLeadAction, takeOverAction, handBackAction } = await import("@/app/app/[account]/leads/actions");
const { sendTestMessageAction, startChatAction } = await import("@/app/app/[account]/setup/test-lab/actions");
const { GET: templateGet } = await import("@/app/leads-template.csv/route");
const { createPriceList } = await import("@/lib/pricing/price-lists");
const { createMarket, getMarketView, setMarketPriceList } = await import("@/lib/markets/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { acceptNewPrice, createOrderForm } = await import("@/lib/orders/service");
const { createQuote } = await import("@/lib/quotes/service");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");
const { startTestConversation } = await import("@/lib/agent/service");

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

describe("UAT round 2 fixes", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const as = () => { holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" }; };
  const refresh = async () => { [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id)); as(); };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "a-very-long-seller-email-address@polar-monitoring.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ legalName: "Polar Ltd", companyId: "51-555012-3", supportContact: "support@polar.test · 03 555 0142" }).where(eq(sellerAccounts.id, acc.id));
    await refresh();
    await seedCatalog(db, acc.id, [{ sku: "KIT-1", name: "Starter kit", unit: "device" }]);
  });
  afterAll(async () => t.close());

  it("1. Company page ticks the Company step when it is done (was always empty)", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props(acc.slug)));
    expect(html).toMatch(/class="sas-steps__step sas-steps__step--done" href="\/app\/[^"]+\/setup\/company"/);
  });

  it("2. Copy and adjust defaults to the source list's currency, VAT setting and rate", async () => {
    const actor = { userId: me.id, actingAs: false };
    const excl = await createPriceList(db, actor, acc.id, { name: "Israel net", currency: "ILS", pricesIncludeTax: false, taxRateBp: 1700 });
    const eur = await createPriceList(db, actor, acc.id, { name: "Europe", currency: "EUR", pricesIncludeTax: true, taxRateBp: 1900 });
    if (!excl.ok || !eur.ok) throw new Error();
    const html = renderToStaticMarkup(await PriceListsPage(props(acc.slug, { copy: excl.list.lineageId })));
    const box = html.match(/<input type="checkbox" name="pricesIncludeTax"[^>]*>/)![0];
    expect(box).not.toContain("checked");
    expect(html).toMatch(/id="pl-copy-tax"[^>]*value="17"/);
    expect(html).toMatch(/<option value="ILS" selected="">ILS<\/option>/);
    const html2 = renderToStaticMarkup(await PriceListsPage(props(acc.slug, { copy: eur.list.lineageId })));
    expect(html2.match(/<input type="checkbox" name="pricesIncludeTax"[^>]*>/)![0]).toContain("checked");
    expect(html2).toMatch(/<option value="EUR" selected="">EUR<\/option>/);
    expect(html2).toMatch(/id="pl-copy-tax"[^>]*value="19"/);
  });

  it("3. A refused playbook save returns what was typed, so the form keeps it", async () => {
    const r = await savePlaybookAction({ status: "idle" }, form({ slug: acc.slug, agentName: "", goal: "Sell sensors fast", tone: "Warm", maxDiscount: "12", offerMeetingWhen: "", handOffWhen: "" }));
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.errors.agentName).toBeTruthy();
    expect(r.values).toMatchObject({ agentName: "", goal: "Sell sensors fast", tone: "Warm", maxDiscount: "12" });
  });

  describe("4–5. Add lead", () => {
    const add = (v: Record<string, string>) => run(addLeadAction({ status: "idle" }, form({ slug: acc.slug, fullName: "Shira Golan", company: "Golan Bakery", phone: "0525550193", ...v })));

    it("an unticked consent box with a source is refused (was saved as consented)", async () => {
      const r = await add({ consentSource: "Expo sheet" });
      expect(r).toMatchObject({ status: "error", formError: "consent_required" });
      expect(await db.select().from(leads).where(eq(leads.accountId, acc.id))).toHaveLength(0);
    });

    it("a manual add of an existing phone shows the duplicate and changes nothing", async () => {
      const first = await add({ consent: "yes", consentSource: "Expo sheet" });
      expect((first as { redirect: string }).redirect).toMatch(/\/leads\/[0-9a-f-]{36}$/);
      const [lead] = await db.select().from(leads).where(eq(leads.accountId, acc.id));
      const again = await add({ fullName: "Someone Else", company: "Other Co", phone: "+972 52-555-0193", consent: "yes", consentSource: "Phone call" });
      expect(again).toMatchObject({ status: "error", formError: "duplicate", duplicateId: lead.id });
      const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
      expect(after).toMatchObject({ fullName: "Shira Golan", company: "Golan Bakery" });
      expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id))).toHaveLength(1);
    });

    it("the webhook and CSV still fill only empty fields of an existing lead", async () => {
      const p = parseLead({ fullName: "Other Name", company: "Other Co", email: "shira@golan.test", phone: "0525550193" }, "IL", { language: "en", now: new Date() });
      if (!p.ok) throw new Error();
      const r = await upsertLead(db, acc.id, { userId: null, actingAs: false }, p.value, "webhook");
      expect(r).toMatchObject({ ok: true, created: false, lead: { fullName: "Shira Golan", email: "shira@golan.test" } });
    });
  });

  it("6. The CSV template download is built from CSV_TEMPLATE_HEADER (has country)", async () => {
    const res = templateGet();
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("full_name,phone,language,business,email,source_id,consent_source,consent_text,consent_at,country");
  });

  it("8. Test lab: sending, taking over and handing back refresh the lab chat", async () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key-not-used";
    holder.revalidated = [];
    const started = await run(startChatAction(form({ slug: acc.slug, language: "en" })));
    const conversationId = /c=([0-9a-f-]{36})/.exec((started as { redirect: string }).redirect)![1];
    const lab = `/app/${acc.slug}/setup/test-lab`;
    holder.revalidated = [];
    await run(takeOverAction(form({ slug: acc.slug, conversationId, from: "lab" })));
    expect(holder.revalidated).toContain(lab);
    holder.revalidated = [];
    // A person handles the chat, so no model call is made.
    const sent = await run(sendTestMessageAction(form({ slug: acc.slug, conversationId, text: "Hello" })));
    expect((sent as { redirect: string }).redirect).toBe(`${lab}?c=${conversationId}#end`);
    expect(holder.revalidated).toContain(lab);
    expect(await db.select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(1);
    holder.revalidated = [];
    await run(handBackAction(form({ slug: acc.slug, conversationId, from: "lab" })));
    expect(holder.revalidated).toContain(lab);
  });

  describe("markets", () => {
    it("a new DE+AT market starts in Europe/Berlin; its currency comes from its (draft) EUR price list", async () => {
      const actor = { userId: me.id, actingAs: false };
      const r = await createMarket(db, actor, acc.id, { name: "Europe", countries: ["DE", "AT"], phonePrefixes: ["+49", "+43"] });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      expect(r.market.overrides).toMatchObject({ timezone: "Europe/Berlin" });
      const eur = await createPriceList(db, actor, acc.id, { name: "EU 2026", currency: "EUR", pricesIncludeTax: true, taxRateBp: 1900 });
      if (!eur.ok) throw new Error();
      await setMarketPriceList(db, actor, acc.id, r.market.id, eur.list.lineageId);
      const view = (await getMarketView(db, acc.id, r.market.id))!;
      expect(view.settings.timezone).toEqual({ value: "Europe/Berlin", source: "market" });
      expect(view.settings.currency).toEqual({ value: "EUR", source: "market" });
      // A market in the account's own country keeps the account time zone.
      const il = await createMarket(db, actor, acc.id, { name: "North", countries: ["IL"], phonePrefixes: [] });
      expect(il.ok && il.market.overrides).toEqual({});
      // Shown on the page: EUR from the list, and legal texts one line per language with <bdi> titles.
      await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
      await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים" });
      const html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: r.market.id })));
      expect(html).toContain("EUR");
      expect(html).toContain("Available once WhatsApp is connected.");
      expect(html).toMatch(/data-legal-lang="en"[^]*?<bdi>Sales terms<\/bdi>/);
      expect(html).toMatch(/data-legal-lang="he"[^]*?<bdi>תנאי מכירה<\/bdi>/);
      // Pill and Override/Reset share one group on every setting row.
      expect(html).toMatch(/data-row-end=""><span class="sas-pill" data-source="account">[^<]+<\/span><a [^>]*>Override<\/a>/);
    });
  });

  describe("7 and price change: buyer page", () => {
    let token = "";
    let leadId = "";
    beforeAll(async () => {
      await seedPricing(db, acc.id, [{ sku: "KIT-1", oneTime: 100_000 }], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id });
      const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen", phone: "0525550200", language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
      if (!p.ok) throw new Error();
      const l = await upsertLead(db, acc.id, { userId: me.id, actingAs: false }, p.value, "manual");
      if (!l.ok) throw new Error();
      leadId = l.lead.id;
      const q = await createQuote(db, acc.id, { kind: "human", userId: me.id, actingAs: false }, leadId, { lines: [{ sku: "KIT-1", qty: 1 }], discountBp: 0 });
      if (!q.ok) throw new Error(q.reason);
      const f = await createOrderForm(db, acc.id, { kind: "human", userId: me.id, actingAs: false }, q.quote.id);
      if (!f.ok) throw new Error(f.reason);
      token = f.token;
    });
    const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));

    it("shows the seller's support contact while reviewing and signing (was only after payment)", async () => {
      const html = await page();
      expect(html).toContain('name="full_name"');
      expect(html).toMatch(/data-support=""[^]*support@polar\.test · 03 555 0142/);
    });

    it("in Hebrew, legal titles come from the Hebrew version", async () => {
      const html = await page({ lang: "he" });
      expect(html).toContain("<bdi>תנאי מכירה</bdi>");
      expect(html).not.toContain("<bdi>Sales terms</bdi>");
      expect(await page({ lang: "en" })).toContain("<bdi>Sales terms</bdi>");
    });

    it("the price-change screen shows before VAT / VAT / Due today, so the total adds up", async () => {
      const [home] = await db.select().from(markets).where(and(eq(markets.accountId, acc.id), eq(markets.isHome, true)));
      await republishPricing(db, acc.id, home.priceListLineageId!, [{ sku: "KIT-1", oneTime: 154_000 }]);
      const html = await page();
      expect(html).toContain("The price has changed");
      expect(html.match(/data-vat-row=""/g)).toHaveLength(2);
      expect(html).toContain("One-time before VAT");
      expect(html).toMatch(/VAT<\/span><span class="b-num b-old">₪180\.00<\/span><span class="b-num">₪277\.20<\/span>/);
      expect(html).toContain("₪1,817.20");
      expect(html).toMatch(/data-support=""/);
    });

    it("the offer-updated screen also shows the support contact next to the new link", async () => {
      const r = await acceptNewPrice(db, token);
      if (!r.ok) throw new Error(r.reason);
      const html = await page();
      expect(html).toContain("The offer was updated");
      expect(html).toContain(`/f/${r.token}`);
      expect(html).toMatch(/data-support=""[^]*support@polar\.test · 03 555 0142/);
    });
  });
});
