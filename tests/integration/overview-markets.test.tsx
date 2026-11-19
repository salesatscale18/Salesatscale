/**
 * W1: Overview as a home page with the shared market selection. On the demo
 * seed (Israel home market + UK) plus a third market (Germany and Austria):
 * the selection (URL, cookie per account), Overview filtered by market, paid
 * revenue per currency, the market cards (three markets, one market) and the
 * Recent activity side panel. Rendered pages on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { and, eq, notInArray } from "drizzle-orm";
import { catalogVersions, leadEvents, leads, markets, orderForms, orders, quotes, quoteVersions, users, type Market, type SellerAccount, type User } from "@/db/schema";
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
  headers: async () => new Headers(),
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
const { marketCookieName, marketSelection } = await import("@/lib/markets/selection");
const { needsYou, needsYouByMarket, openLeadsByMarket, overviewKpis, recentActivity } = await import("@/lib/overview/service");
const { getAccountById } = await import("@/lib/accounts/service");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { GET: switchMarket } = await import("@/app/app/[account]/market/route");
const { NextRequest } = await import("next/server");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}) => ({
  params: Promise.resolve({ account }),
  searchParams: Promise.resolve(sp),
});
const NOW = new Date();
const range = { from: new Date(NOW.getTime() - 7 * 86_400_000), to: new Date(NOW.getTime() + 60_000) };

describe("W1: Overview home page and the market selection", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let other: SellerAccount;
  let il: Market, uk: Market, dach: Market;
  let ukLead = "", homeLead = "";

  const as = (a: SellerAccount) => { holder.access = { account: a, user: admin, actingAs: false, role: "seller_admin" }; };
  let seq = 90_000;
  const mkPaidOrder = async (accountId: string, leadId: string, currency: string, amountDueMinor: number, recurringMinor = 0) => {
    const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, accountId)).limit(1);
    const quoteId = randomUUID(), versionId = randomUUID(), formId = randomUUID();
    const number = seq++;
    await db.insert(quotes).values({ id: quoteId, accountId, leadId, number, status: "sent" });
    await db.insert(quoteVersions).values({
      id: versionId, accountId, quoteId, version: 1, catalogVersionId: cv.id, currency, pricesIncludeTax: true, taxRateBp: 0,
      oneTimeSubtotalMinor: amountDueMinor, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: amountDueMinor,
      recurringSubtotalMinor: recurringMinor, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: recurringMinor,
      approvalReasons: [], validUntil: new Date(NOW.getTime() + 7 * 86_400_000), createdByActor: "agent",
    });
    await db.insert(orderForms).values({
      id: formId, accountId, leadId, quoteId, quoteVersionId: versionId, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
      expiresAt: new Date(NOW.getTime() + 5 * 86_400_000), createdBy: "agent", status: "signed", signedAt: new Date(NOW.getTime() - 7_200_000),
    });
    await db.insert(orders).values({
      id: randomUUID(), accountId, leadId, quoteId, orderFormId: formId, number, currency, amountDueMinor, recurringMinor,
      paymentStatus: "paid", paidAt: new Date(NOW.getTime() - 3_600_000),
    });
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_w1", email: "w1@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner2@platform.test", now: NOW });
    if (!a.ok || !b.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    other = (await getAccountById(db, b.summary.accountId))!;
    const created = await createMarket(db, { userId: admin.id, actingAs: false }, account.id, { name: "Germany and Austria", countries: ["DE", "AT"], phonePrefixes: ["+49", "+43"] });
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    const all = await listMarkets(db, account.id);
    [il, uk, dach] = [all.find((m) => m.isHome)!, all.find((m) => m.countries.includes("GB"))!, all.find((m) => m.id === created.market.id)!];
    // One UK lead and one home lead without a market id (older rows), each handed to a person, each with a paid order.
    const [u] = await db.insert(leads).values({ accountId: account.id, fullName: "Oliver Brown", phone: "+447700900123", language: "en", origin: "manual", marketId: uk.id, status: "human_handling", lastActivityAt: NOW }).returning();
    const [h] = await db.insert(leads).values({ accountId: account.id, fullName: "Noa Levi", phone: "+972505559999", language: "en", origin: "manual", marketId: null, status: "human_handling", lastActivityAt: NOW }).returning();
    ukLead = u.id;
    homeLead = h.id;
    await mkPaidOrder(account.id, ukLead, "GBP", 120_000, 1_500);
    await mkPaidOrder(account.id, homeLead, "ILS", 350_000);
    await db.insert(leadEvents).values([
      { accountId: account.id, leadId: ukLead, type: "lead.created", actor: "system", createdAt: NOW },
      { accountId: account.id, leadId: homeLead, type: "lead.created", actor: "system", createdAt: new Date(NOW.getTime() - 1000) },
    ]);
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.cookies.clear(); as(account); });

  describe("selection", () => {
    it("the demo seed has Israel (home) and the UK; the test adds a third market", () => {
      expect([il.name, uk.name, dach.name]).toEqual(["Israel", "United Kingdom", "Germany and Austria"]);
    });

    it("URL wins over the cookie; an invalid id falls back to all; the cookie is per account", async () => {
      holder.cookies.set(marketCookieName(account.id), uk.id);
      expect((await marketSelection(db, account.id, {})).selected?.id).toBe(uk.id);
      expect((await marketSelection(db, account.id, { market: dach.id })).selected?.id).toBe(dach.id);
      expect((await marketSelection(db, account.id, { market: "all" })).selected).toBeNull();
      expect((await marketSelection(db, account.id, { market: randomUUID() })).selected).toBeNull();
      // Another account's market id is not valid here, and this account's cookie does not apply there.
      expect((await marketSelection(db, account.id, { market: (await listMarkets(db, other.id))[1].id })).selected).toBeNull();
      const there = await marketSelection(db, other.id, {});
      expect(there.selected).toBeNull();
      expect(there.showSwitcher).toBe(true);
      holder.cookies.set(marketCookieName(other.id), uk.id);
      expect((await marketSelection(db, other.id, {})).selected).toBeNull();
    });

    it("the switcher's route stores the cookie for this account and returns with ?market=", async () => {
      const req = new NextRequest(`http://localhost/app/${account.slug}/market?market=${uk.id}&next=${encodeURIComponent(`/app/${account.slug}/leads?q=x`)}`);
      const res = await switchMarket(req, { params: Promise.resolve({ account: account.slug }) });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`http://localhost/app/${account.slug}/leads?q=x&market=${uk.id}`);
      const cookie = res.cookies.get(marketCookieName(account.id));
      expect(cookie).toMatchObject({ value: uk.id, httpOnly: true, path: "/" });
      // Another account's market is never stored.
      const bad = await switchMarket(new NextRequest(`http://localhost/app/${account.slug}/market?market=${(await listMarkets(db, other.id))[1].id}&next=https://evil.test`), { params: Promise.resolve({ account: account.slug }) });
      expect(bad.headers.get("location")).toBe(`http://localhost/app/${account.slug}?market=all`);
      expect(bad.cookies.get(marketCookieName(account.id))?.value).toBe("all");
    });
  });

  describe("numbers", () => {
    it("Overview numbers filter by the lead's market; leads without a market count for the home market", async () => {
      const ukK = await overviewKpis(db, account.id, range, { market: uk });
      expect(ukK.paidByCurrency).toEqual([{ currency: "GBP", oneTimeMinor: 120_000, recurringMinor: 1_500 }]);
      const homeK = await overviewKpis(db, account.id, range, { market: il });
      expect(homeK.paidByCurrency.find((r) => r.currency === "ILS")?.oneTimeMinor).toBeGreaterThanOrEqual(350_000);
      expect(homeK.paidByCurrency.some((r) => r.currency === "GBP")).toBe(false);
      const dachK = await overviewKpis(db, account.id, range, { market: dach });
      expect(dachK).toMatchObject({ newLeads: 0, paidOrders: 0, paidByCurrency: [] });
      const allK = await overviewKpis(db, account.id, range);
      expect(allK.newLeads).toBe(ukK.newLeads + homeK.newLeads + dachK.newLeads);
      const recent = await recentActivity(db, account.id, 50, { market: uk });
      expect(recent.length).toBeGreaterThan(0);
      const ukLeadIds = new Set((await db.select({ id: leads.id }).from(leads).where(and(eq(leads.accountId, account.id), eq(leads.marketId, uk.id)))).map((r) => r.id));
      expect(recent.every((r) => ukLeadIds.has(r.lead.id))).toBe(true);
    });

    it("paid revenue is one line per currency with all markets, never added up", async () => {
      const allK = await overviewKpis(db, account.id, range);
      expect(allK.paidByCurrency.map((r) => r.currency)).toEqual(["GBP", "ILS"]);
      const html = await page(OverviewPage(props(account.slug, { period: "7" })));
      const tile = html.split("Paid revenue")[1].split('class="sas-metric"')[0];
      expect(tile).toContain('data-currencies="2"');
      expect(tile).toContain('data-currency="GBP">£1,200.00');
      expect(tile).toMatch(/data-currency="ILS">₪[\d,]+\.\d\d/);
      expect(tile).toContain("+ £15.00/month recurring");
      // One market selected: a single amount, as before.
      const ukHtml = await page(OverviewPage(props(account.slug, { period: "7", market: uk.id })));
      const ukTile = ukHtml.split("Paid revenue")[1].split('class="sas-metric"')[0];
      expect(ukTile).not.toContain("data-currencies");
      expect(ukTile).toContain("£1,200.00");
    });

    it("open leads and Need you per market", async () => {
      const open = await openLeadsByMarket(db, account.id, il.id);
      const count = async (where: ReturnType<typeof and>) => (await db.select({ id: leads.id }).from(leads).where(where)).length;
      const openWhere = (m: ReturnType<typeof eq> | undefined) => and(eq(leads.accountId, account.id), eq(leads.isTest, false), notInArray(leads.status, ["won", "lost", "opted_out"]), m);
      expect(open.get(uk.id)).toBe(await count(openWhere(eq(leads.marketId, uk.id))));
      expect(open.get(il.id)).toBeGreaterThanOrEqual(1);
      expect(open.get(dach.id)).toBeUndefined();
      const items = await needsYou(db, account.id, NOW);
      expect(items.find((i) => i.leadId === homeLead)?.marketId).toBeNull();
      const by = needsYouByMarket(items, il.id);
      expect(by.get(uk.id)).toBe(items.filter((i) => i.marketId === uk.id).length);
      expect([...by.values()].reduce((a, b) => a + b, 0)).toBe(items.length);
    });
  });

  describe("page", () => {
    it("filtered by market: switcher with the choice, Needs you and its count only for that market", async () => {
      const all = await page(OverviewPage(props(account.slug)));
      expect(all).toContain("Oliver Brown");
      expect(all).toContain("Noa Levi");
      holder.cookies.set(marketCookieName(account.id), uk.id);
      const html = await page(OverviewPage(props(account.slug)));
      expect(html).toContain('data-market-switcher=""');
      expect(html).toMatch(new RegExp(`<option value="${uk.id}" selected="">United Kingdom · Setting up</option>`));
      expect(html).toContain('<option value="all">All markets</option>');
      expect(html).toContain(`action="/app/${account.slug}/market"`);
      expect(html).toContain('<input type="hidden" name="next" value="/app/' + account.slug + '"/>');
      const needs = html.split('id="needs-h"')[1].split("</section>")[0];
      expect(needs).toContain("Oliver Brown");
      expect(needs).not.toContain("Noa Levi");
      // The URL wins over the stored UK choice.
      const home = await page(OverviewPage(props(account.slug, { market: il.id })));
      const homeNeeds = home.split('id="needs-h"')[1].split("</section>")[0];
      expect(homeNeeds).toContain("Noa Levi");
      expect(homeNeeds).not.toContain("Oliver Brown");
      // Period links keep the market from the URL.
      expect(home).toContain(`href="/app/${account.slug}?period=7&amp;market=${il.id}"`);
    });

    it("Needs you shows two items, the rest under Show N more", async () => {
      const html = await page(OverviewPage(props(account.slug)));
      const needs = html.split('id="needs-h"')[1].split("</section>")[0];
      const total = (needs.match(/class="sas-list__row"/g) ?? []).length;
      expect(total).toBeGreaterThan(2);
      const shown = needs.split('data-needs-more=""')[0];
      expect((shown.match(/class="sas-list__row"/g) ?? []).length).toBe(2);
      expect(needs).toContain(`Show ${total - 2} more`);
    });

    it("market cards: three markets plus Add market, outlines by status, links that open the market", async () => {
      const html = await page(OverviewPage(props(account.slug, { period: "7" })));
      const section = html.split('aria-labelledby="markets-h"')[1].split("</section>")[0];
      expect(section).toContain(">Your markets</h2>");
      expect(section).toContain(`href="/app/${account.slug}/markets">Manage markets</a>`);
      const cards = [...section.matchAll(/data-market-card="([^"]+)"/g)].map((m) => m[1]);
      expect(cards).toEqual([il.id, uk.id, dach.id]);
      expect(section).toContain('aria-label="Germany and Austria: open this market"');
      expect(section).toContain(`href="/app/${account.slug}/market?market=${uk.id}&amp;next=%2Fapp%2F${account.slug}%3Fperiod%3D7"`);
      expect((section.match(/data-outline=""/g) ?? []).length).toBe(3);
      expect(section).toContain('data-market-add=""');
      expect(section).toContain(`href="/app/${account.slug}/markets?add=1"`);
      // Live markets get the primary look, the others the neutral one; the status pill sits on the panel.
      const card = (id: string) => section.split(`data-market-card="${id}"`)[0].split("<a ").pop()!;
      const liveIl = il.status === "live";
      expect(card(il.id)).toContain(liveIl ? "sas-mcard sas-mcard--live" : 'class="sas-mcard"');
      expect(card(dach.id)).toContain('class="sas-mcard"');
      expect(section).toContain('data-status="market.setting_up"');
      const open = await openLeadsByMarket(db, account.id, il.id);
      expect(section).toContain(`data-open-leads="${open.get(uk.id) ?? 0}"`);
    });

    it("one market: one card plus Add market, no switcher; a market without countries shows a globe", async () => {
      const [home] = await db.select().from(markets).where(and(eq(markets.accountId, other.id), eq(markets.isHome, true)));
      const others = (await listMarkets(db, other.id)).filter((m) => !m.isHome);
      await db.delete(markets).where(and(eq(markets.accountId, other.id), notInArray(markets.id, [home.id])));
      await db.update(markets).set({ countries: [] }).where(eq(markets.id, home.id));
      as(other);
      const html = await page(OverviewPage(props(other.slug)));
      expect(others.length).toBeGreaterThan(0);
      expect(html).not.toContain("data-market-switcher");
      const section = html.split('aria-labelledby="markets-h"')[1].split("</section>")[0];
      expect((section.match(/data-market-card=/g) ?? []).length).toBe(1);
      expect(section).toContain('data-outline="none"');
      expect(section).toContain('data-market-add=""');
    });

    it("Recent activity leaves the page and opens in the wide side panel, filtered by market", async () => {
      const closed = await page(OverviewPage(props(account.slug)));
      expect(closed).not.toContain('id="activity-panel"');
      expect(closed).toMatch(new RegExp(`href="/app/${account.slug}\\?panel=activity" data-open-activity=""`));
      const html = await page(OverviewPage(props(account.slug, { panel: "activity", market: uk.id })));
      const panel = html.split('id="activity-panel"')[1];
      expect(html).toContain('class="sas-sp sas-sp--wide"');
      expect(panel).toContain(">Recent activity</h2>");
      expect(panel).toContain(`href="/app/${account.slug}/leads">All leads</a>`);
      expect(panel).toContain(`href="/app/${account.slug}/leads/${ukLead}">Oliver Brown</a>`);
      expect(panel).not.toContain("Noa Levi");
      expect(html).toMatch(new RegExp(`<a class="sas-sp__close"[^>]*href="/app/${account.slug}\\?market=${uk.id}"|href="/app/${account.slug}\\?market=${uk.id}"[^>]*class="sas-sp__close"`));
    });
  });
});
