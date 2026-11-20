/**
 * W2: markets across the workspace. On the demo seed (Israel home market + UK)
 * plus a third market (Germany and Austria): the market switcher filters Leads,
 * Quotes and orders and Conversations (URL parameter and stored cookie), the
 * sortable Market columns, the Catalog "Sold in" column, Markets in the menu,
 * and one-market accounts without switcher or columns. Rendered pages on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { and, eq, notInArray } from "drizzle-orm";
import { catalogVersions, conversations, leads, markets, orderForms, orders, quotes, quoteVersions, users, type Market, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, cookies: new Map<string, string>() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (holder.cookies.has(name) ? { name, value: holder.cookies.get(name)! } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { createMarket, listMarkets } = await import("@/lib/markets/service");
const { marketCookieName } = await import("@/lib/markets/selection");
const { getAccountById } = await import("@/lib/accounts/service");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}) => ({
  params: Promise.resolve({ account }),
  searchParams: Promise.resolve(sp),
});
const NOW = new Date();
/** The counts of a tab bar (`aria-label` of its nav), in order. */
const counts = (html: string, label: string) =>
  [...html.split(`aria-label="${label}"`)[1].split("</nav>")[0].matchAll(/class="sas-num">(\d+)</g)].map((m) => Number(m[1]));

describe("W2: markets across the workspace", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let single: SellerAccount;
  let il: Market, uk: Market, dach: Market;

  const as = (a: SellerAccount) => { holder.access = { account: a, user: admin, actingAs: false, role: "seller_admin" }; };
  let seq = 95_000;
  /** A sent quote and a paid order for a lead, both in `marketId` (null = the home market). */
  const mkDeal = async (leadId: string, marketId: string | null, currency: string, amountDueMinor: number) => {
    const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, account.id)).limit(1);
    const quoteId = randomUUID(), versionId = randomUUID(), formId = randomUUID();
    const number = seq++;
    await db.insert(quotes).values({ id: quoteId, accountId: account.id, leadId, number, status: "sent", marketId });
    await db.insert(quoteVersions).values({
      id: versionId, accountId: account.id, quoteId, version: 1, catalogVersionId: cv.id, currency, pricesIncludeTax: true, taxRateBp: 0, marketId,
      oneTimeSubtotalMinor: amountDueMinor, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: amountDueMinor,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
      approvalReasons: [], validUntil: new Date(NOW.getTime() + 7 * 86_400_000), createdByActor: "agent",
    });
    await db.insert(orderForms).values({
      id: formId, accountId: account.id, leadId, quoteId, quoteVersionId: versionId, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
      expiresAt: new Date(NOW.getTime() + 5 * 86_400_000), createdBy: "agent", status: "signed", signedAt: new Date(NOW.getTime() - 7_200_000),
    });
    await db.insert(orders).values({
      id: randomUUID(), accountId: account.id, leadId, quoteId, orderFormId: formId, number, currency, amountDueMinor, recurringMinor: 0,
      paymentStatus: "paid", paidAt: new Date(NOW.getTime() - 3_600_000), marketId,
    });
    return number;
  };
  let ukQuote = 0, homeQuote = 0;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_w2", email: "w2@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner2@platform.test", now: NOW });
    if (!a.ok || !b.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    single = (await getAccountById(db, b.summary.accountId))!;
    // The second account keeps only its home market.
    const [home2] = await db.select().from(markets).where(and(eq(markets.accountId, single.id), eq(markets.isHome, true)));
    await db.delete(markets).where(and(eq(markets.accountId, single.id), notInArray(markets.id, [home2.id])));

    const created = await createMarket(db, { userId: admin.id, actingAs: false }, account.id, { name: "Germany and Austria", countries: ["DE", "AT"], phonePrefixes: ["+49", "+43"] });
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    const all = await listMarkets(db, account.id);
    [il, uk, dach] = [all.find((m) => m.isHome)!, all.find((m) => m.countries.includes("GB"))!, all.find((m) => m.id === created.market.id)!];
    // A UK lead, a DACH lead and a home lead without a market id (older rows).
    const [u] = await db.insert(leads).values({ accountId: account.id, fullName: "Oliver Brown", phone: "+447700900123", language: "en", origin: "manual", marketId: uk.id, status: "agent_handling", lastActivityAt: NOW }).returning();
    await db.insert(leads).values({ accountId: account.id, fullName: "Hans Weber", phone: "+4915112345678", language: "en", origin: "manual", marketId: dach.id, status: "new", lastActivityAt: NOW });
    const [h] = await db.insert(leads).values({ accountId: account.id, fullName: "Noa Null", phone: "+972505559999", language: "en", origin: "manual", marketId: null, status: "new", lastActivityAt: NOW }).returning();
    ukQuote = await mkDeal(u.id, uk.id, "GBP", 120_000);
    homeQuote = await mkDeal(h.id, null, "ILS", 350_000);
    // A chat with the UK lead (on the demo's agent version).
    const [demoConv] = await db.select().from(conversations).where(eq(conversations.accountId, account.id)).limit(1);
    await db.insert(conversations).values({ accountId: account.id, leadId: u.id, channel: "whatsapp", agentVersionId: demoConv.agentVersionId, language: "en" });
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.cookies.clear(); as(account); });

  describe("Leads", () => {
    it("all markets: the switcher, every lead and a sortable Market column", async () => {
      const html = await page(LeadsPage(props(account.slug, { view: "all" })));
      expect(html).toContain("data-market-switcher");
      expect(html).toContain(`action="/app/${account.slug}/market"`);
      for (const n of ["Oliver Brown", "Hans Weber", "Noa Null", "Noa Demo"]) expect(html).toContain(n);
      expect(html).toContain('data-sort-col="market"');
      // Phone cards: the market is a labelled row; a lead without a market shows the home market.
      expect(html).toMatch(/<td class="sas-lrow__market" data-label="Market"><span data-market="home">Israel<\/span><\/td>/);
      expect(html).toContain(`data-market="${uk.id}">United Kingdom</span>`);
    });

    it("the URL parameter filters the list and the view counts; it wins over the cookie", async () => {
      holder.cookies.set(marketCookieName(account.id), il.id);
      const html = await page(LeadsPage(props(account.slug, { view: "all", market: uk.id })));
      expect(html).toContain("Oliver Brown");
      expect(html).not.toContain("Noa Null");
      expect(html).not.toContain("Hans Weber");
      // Leads V2 views: Needs you 0, Agent working 1, With your team 0, Won 0, Closed 0, All 1.
      expect(counts(html, "Views")).toEqual([0, 1, 0, 0, 0, 1]);
      // Links on the page keep the market from the URL; the switcher shows it chosen.
      expect(html).toContain(`?view=with_team&amp;market=${uk.id}`);
      expect(html).toMatch(new RegExp(`<option value="${uk.id}" title="United Kingdom · Setting up" selected="">United Kingdom</option>`));
    });

    it("the stored cookie filters when the URL has no market; the home market keeps leads without a market id", async () => {
      holder.cookies.set(marketCookieName(account.id), il.id);
      const html = await page(LeadsPage(props(account.slug, { view: "all" })));
      expect(html).toContain("Noa Null");
      expect(html).toContain("Noa Demo");
      expect(html).not.toContain("Oliver Brown");
      expect(html).not.toContain("Hans Weber");
    });

    it("keeps every other filter with a market chosen (search)", async () => {
      const html = await page(LeadsPage(props(account.slug, { view: "all", market: il.id, q: "Oliver" })));
      expect(html).toContain("No leads match these filters");
      const ok = await page(LeadsPage(props(account.slug, { view: "all", market: uk.id, q: "Oliver" })));
      expect(ok).toContain("Oliver Brown");
      // The market goes with the filters as the More filters Market select (the switcher's choice).
      expect(ok).toContain(`<option value="${uk.id}" selected="">Market: United Kingdom</option>`);
    });

    it("a market with no leads says so, without the first-lead empty state", async () => {
      await db.update(leads).set({ marketId: uk.id }).where(and(eq(leads.accountId, account.id), eq(leads.fullName, "Hans Weber")));
      try {
        const html = await page(LeadsPage(props(account.slug, { view: "all", market: dach.id })));
        expect(html).toContain("No leads in Germany and Austria yet");
        expect(html).toContain("data-market-switcher");
      } finally {
        await db.update(leads).set({ marketId: dach.id }).where(and(eq(leads.accountId, account.id), eq(leads.fullName, "Hans Weber")));
      }
    });

    it("sorts by market name; a lead without a market sorts as the home market", async () => {
      const asc = await page(LeadsPage(props(account.slug, { view: "all", sort: "market", dir: "asc" })));
      // Germany and Austria < Israel (incl. no market id) < United Kingdom.
      expect(asc.indexOf("Hans Weber")).toBeLessThan(asc.indexOf("Noa Null"));
      expect(asc.indexOf("Noa Null")).toBeLessThan(asc.indexOf("Oliver Brown"));
      const desc = await page(LeadsPage(props(account.slug, { view: "all", sort: "market", dir: "desc" })));
      expect(desc.indexOf("Oliver Brown")).toBeLessThan(desc.indexOf("Noa Null"));
      expect(desc.indexOf("Noa Null")).toBeLessThan(desc.indexOf("Hans Weber"));
    });
  });

  describe("Quotes and orders", () => {
    it("all markets: switcher, every quote, a sortable Market column with each currency kept", async () => {
      const html = await page(OrdersPage(props(account.slug)));
      expect(html).toContain("data-market-switcher");
      expect(html).toContain(`>Q-${ukQuote}<`);
      expect(html).toContain(`>Q-${homeQuote}<`);
      expect(html).toContain('data-sort-col="market"');
      expect(html).toContain(`data-market="${uk.id}">United Kingdom</span>`);
      expect(html).toContain('data-market="home">Israel</span>');
      expect(html).toContain("£1,200.00");
      expect(html).toContain("₪3,500.00");
    });

    it("the URL parameter filters quotes, orders and the tab counts", async () => {
      const all = counts(await page(OrdersPage(props(account.slug))), "Document type");
      const html = await page(OrdersPage(props(account.slug, { market: uk.id })));
      expect(html).toContain(`>Q-${ukQuote}<`);
      expect(html).not.toContain(`>Q-${homeQuote}<`);
      const ukCounts = counts(html, "Document type");
      expect(ukCounts.slice(0, 2)).toEqual([1, 1]);
      expect(all[0]).toBeGreaterThan(1);
      expect(html).toContain(`?tab=orders&amp;market=${uk.id}`);
      const ord = await page(OrdersPage(props(account.slug, { market: uk.id, tab: "orders" })));
      expect(ord).toContain("£1,200.00");
      expect(ord).not.toContain("₪3,500.00");
      expect(ord).toContain('data-sort-col="market"');
    });

    it("the cookie filters when the URL has no market (home includes quotes without a market id)", async () => {
      holder.cookies.set(marketCookieName(account.id), il.id);
      const html = await page(OrdersPage(props(account.slug)));
      expect(html).toContain(`>Q-${homeQuote}<`);
      expect(html).not.toContain(`>Q-${ukQuote}<`);
      holder.cookies.set(marketCookieName(account.id), dach.id);
      expect(await page(OrdersPage(props(account.slug)))).toContain("No quotes in Germany and Austria yet");
    });

    it("sorts quotes by market", async () => {
      const asc = await page(OrdersPage(props(account.slug, { sort: "market", dir: "asc" })));
      expect(asc.indexOf(`>Q-${homeQuote}<`)).toBeLessThan(asc.indexOf(`>Q-${ukQuote}<`));
      const desc = await page(OrdersPage(props(account.slug, { sort: "market", dir: "desc" })));
      expect(desc.indexOf(`>Q-${ukQuote}<`)).toBeLessThan(desc.indexOf(`>Q-${homeQuote}<`));
      const ordDesc = await page(OrdersPage(props(account.slug, { tab: "orders", sort: "market", dir: "desc" })));
      expect(ordDesc.indexOf("£1,200.00")).toBeLessThan(ordDesc.indexOf("₪3,500.00"));
    });
  });

  describe("Conversations", () => {
    it("the switcher in the header filters the list and the filter counts (URL and cookie)", async () => {
      const all = await page(ConversationsPage(props(account.slug)));
      expect(all).toContain("data-market-switcher");
      expect(all).toContain("Oliver Brown");
      expect(all).toContain("Lior Demo");
      const allCounts = counts(all, "Filter conversations");
      const html = await page(ConversationsPage(props(account.slug, { market: uk.id })));
      expect(html).toContain("Oliver Brown");
      expect(html).not.toContain("Lior Demo");
      expect(counts(html, "Filter conversations")[0]).toBe(1);
      expect(allCounts[0]).toBeGreaterThan(1);
      holder.cookies.set(marketCookieName(account.id), il.id);
      const home = await page(ConversationsPage(props(account.slug)));
      expect(home).toContain("Lior Demo");
      expect(home).not.toContain("Oliver Brown");
      holder.cookies.set(marketCookieName(account.id), dach.id);
      expect(await page(ConversationsPage(props(account.slug)))).toContain("No conversations in Germany and Austria yet");
    });
  });

  describe("one market", () => {
    it("no switcher and no Market or Sold in columns", async () => {
      as(single);
      const leadsHtml = await page(LeadsPage(props(single.slug, { view: "all", market: "anything" })));
      expect(leadsHtml).not.toContain("data-market-switcher");
      expect(leadsHtml).not.toContain('data-sort-col="market"');
      expect(leadsHtml).not.toContain('data-label="Market"');
      expect(leadsHtml).toContain("Noa Demo");
      const ordersHtml = await page(OrdersPage(props(single.slug)));
      expect(ordersHtml).not.toContain("data-market-switcher");
      expect(ordersHtml).not.toContain('data-sort-col="market"');
      const conv = await page(ConversationsPage(props(single.slug)));
      expect(conv).not.toContain("data-market-switcher");
      const catalog = await page(CatalogPage(props(single.slug)));
      expect(catalog).not.toContain("Sold in");
      expect(catalog).not.toContain("data-sold-in");
    });
  });

  describe("Catalog: Sold in", () => {
    const cell = (html: string, sku: string) => html.split(sku)[1].split("</tr>")[0].match(/data-sold-in="[^"]*"(?: title="[^"]*")?>[^<]*</)?.[0];
    it("0, 1, 2 and more than 2 markets", async () => {
      // The demo: Israel's live list prices GW-10 and others; the UK list has no live version; PRB-30 is in no list.
      let html = await page(CatalogPage(props(account.slug)));
      expect(html).toContain('<th scope="col" class="sas-catalog__soldin">Sold in</th>');
      expect(cell(html, "PRB-30")).toBe('data-sold-in="none">Not sold yet<');
      expect(cell(html, "GW-10")).toBe('data-sold-in="1">Israel<');
      // DACH sells from Israel's list: two markets.
      await db.update(markets).set({ priceListLineageId: il.priceListLineageId }).where(eq(markets.id, dach.id));
      html = await page(CatalogPage(props(account.slug)));
      expect(cell(html, "GW-10")).toBe('data-sold-in="2">Israel, Germany and Austria<');
      // And the UK too, plus a fourth market: "Israel, … +2".
      await db.update(markets).set({ priceListLineageId: il.priceListLineageId }).where(eq(markets.id, uk.id));
      const fr = await createMarket(db, { userId: admin.id, actingAs: false }, account.id, { name: "France", countries: ["FR"], phonePrefixes: ["+33"] });
      if (!fr.ok) throw new Error("market");
      await db.update(markets).set({ priceListLineageId: il.priceListLineageId }).where(eq(markets.id, fr.market.id));
      html = await page(CatalogPage(props(account.slug)));
      const four = cell(html, "GW-10")!;
      // Two names and "+2"; all four on hover.
      expect(four).toMatch(/^data-sold-in="4" title="Israel, [^"]+">Israel, [^<,]+ \+2<$/);
      expect(cell(html, "PRB-30")).toBe('data-sold-in="none">Not sold yet<');
      await db.delete(markets).where(eq(markets.id, fr.market.id));
      await db.update(markets).set({ priceListLineageId: uk.priceListLineageId }).where(eq(markets.id, uk.id));
      await db.update(markets).set({ priceListLineageId: dach.priceListLineageId }).where(eq(markets.id, dach.id));
    });
  });

  describe("Markets in the menu", () => {
    it("Settings no longer links Markets; the Markets page has no Settings breadcrumb", async () => {
      const settings = await page(SettingsPage(props(account.slug)));
      expect(settings).not.toContain(`href="/app/${account.slug}/markets"`);
      const m = await page(MarketsPage(props(account.slug)));
      expect(m).toContain(">Markets</h1>");
      expect(m).not.toContain(`href="/app/${account.slug}/settings">Settings</a> / Markets`);
    });
  });
});
