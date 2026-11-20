/**
 * Overview V2 (option A): the O-1 KPI card numbers (overviewCardNumbers and the
 * previous equal period) on a hand-built account, with the same filters as
 * today (test leads never, simulated buyers only when asked, the market
 * switcher by the lead's market); and a render of the page on the demo seed:
 * the five cards, the funnel's "From the step before" column, the blue Live
 * pills and the View options menu. PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { catalogVersions, leadEvents, leads, markets, orderForms, quotes, quoteVersions, sellerAccounts, users, type Market, type SellerAccount, type User } from "@/db/schema";
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
const { getAccountById } = await import("@/lib/accounts/service");
const { overviewCardNumbers, overviewKpis, periodRange, previousRange, PERSON_EVENTS } = await import("@/lib/overview/service");
const { default: OverviewPage } = await import("@/app/app/[account]/page");

const DAY = 86_400_000;
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });

describe("Overview V2: KPI cards, funnel column, View options", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc = "";
  let home: Market, uk: Market;
  let demo: SellerAccount;
  let phone = 0, number = 50_000;
  const range = periodRange(30, NOW);

  const mkLead = async (o: Partial<typeof leads.$inferInsert> = {}) => {
    const [l] = await db.insert(leads).values({
      accountId: acc, fullName: `Lead ${phone}`, phone: `+97254000${String(phone++).padStart(4, "0")}`, language: "en", origin: "manual", ...o,
    }).returning();
    return l.id;
  };
  const mkSigned = async (leadId: string, currency: string, oneTimeTotalMinor: number, signedAt: Date) => {
    const [cv] = await db.select().from(catalogVersions).limit(1);
    const quoteId = randomUUID(), versionId = randomUUID();
    await db.insert(quotes).values({ id: quoteId, accountId: acc, leadId, number: number++, status: "sent" });
    await db.insert(quoteVersions).values({
      id: versionId, accountId: acc, quoteId, version: 1, catalogVersionId: cv.id, currency, pricesIncludeTax: true, taxRateBp: 0,
      oneTimeSubtotalMinor: oneTimeTotalMinor, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
      approvalReasons: [], validUntil: new Date(NOW.getTime() + 7 * DAY), createdByActor: "agent",
    });
    await db.insert(orderForms).values({
      id: randomUUID(), accountId: acc, leadId, quoteId, quoteVersionId: versionId, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
      expiresAt: new Date(NOW.getTime() + 5 * DAY), createdBy: "agent", status: "signed", signedAt, createdAt: signedAt,
    });
  };
  const event = (leadId: string, type: string, createdAt = ago(1)) =>
    db.insert(leadEvents).values({ accountId: acc, leadId, type, actor: type === "handoff.requested" ? "agent" : "human", createdAt });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_ov2", email: "ov2@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const [a] = await db.insert(sellerAccounts).values({
      slug: "ov2", tradeName: "OV2", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCapMinor: 100_000,
    }).returning();
    acc = a.id;
    await db.insert(catalogVersions).values({ id: randomUUID(), accountId: acc, version: 1, status: "draft" });
    [home] = await db.insert(markets).values({ id: randomUUID(), accountId: acc, name: "Israel", isHome: true, countries: ["IL"] }).returning();
    [uk] = await db.insert(markets).values({ id: randomUUID(), accountId: acc, name: "United Kingdom", countries: ["GB"] }).returning();

    // Leads received in the last 30 days.
    const l1 = await mkLead({ marketId: home.id, createdAt: ago(2) }); // signed, agent only
    await mkSigned(l1, "ILS", 300_000, ago(1));
    const l2 = await mkLead({ marketId: uk.id, createdAt: ago(3) }); // signed, handed to a person
    await mkSigned(l2, "GBP", 100_000, ago(1));
    await event(l2, "handoff.requested");
    const l3 = await mkLead({ marketId: null, createdAt: ago(4) }); // taken over (no market: the home market)
    await event(l3, "conversation.taken_over");
    await mkLead({ marketId: home.id, createdAt: ago(5), status: "human_handling" }); // Human handling, no event
    const l5 = await mkLead({ marketId: home.id, createdAt: ago(6) }); // agent only; a later event in the future does not count
    await event(l5, "handoff.requested", new Date(NOW.getTime() + DAY));
    const l6 = await mkLead({ marketId: home.id, createdAt: ago(7) }); // the seller continues after a call
    await event(l6, "callback.after_seller");
    // Never counted: a test lead; counted only with Include simulated: a simulated buyer.
    const test = await mkLead({ isTest: true, createdAt: ago(2) });
    await mkSigned(test, "ILS", 999_900, ago(1));
    await mkLead({ buyerRef: "SIM-0001", phone: "sim:SIM-0001", createdAt: ago(2) });
    // An older lead: signed in the previous 30 days, and again in this period (counts for Average deal, not Lead to signed).
    const old = await mkLead({ marketId: home.id, createdAt: ago(40) });
    await mkSigned(old, "ILS", 200_000, ago(35));
    await mkSigned(old, "ILS", 100_000, ago(10));

    const d = await createDemoAccount(db, admin, { ownerEmail: "owner@ov2.test", now: NOW });
    if (!d.ok) throw new Error("demo seed refused");
    demo = (await getAccountById(db, d.summary.accountId))!;
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.cookies.clear(); holder.access = { account: demo, user: admin, actingAs: false, role: "seller_admin" }; });

  describe("numbers", () => {
    it("previous equal period: the days just before the window", () => {
      const prev = previousRange(range);
      expect(prev.to).toEqual(range.from);
      expect(range.from.getTime() - prev.from.getTime()).toBe(30 * DAY);
      const p7 = previousRange(periodRange(7, NOW));
      expect(p7.to.getTime() - p7.from.getTime()).toBe(7 * DAY);
    });

    it("lead to signed, handled by the agent and average deal; test leads never, simulated buyers only when asked", async () => {
      expect(PERSON_EVENTS).toEqual(["handoff.requested", "handoff.spend_cap", "conversation.taken_over", "callback.after_seller"]);
      const n = await overviewCardNumbers(db, acc, range);
      expect(n).toEqual({
        leadsReceived: 6, leadsSigned: 2, leadsWithoutPerson: 2,
        signedByCurrency: [{ currency: "GBP", count: 1, oneTimeMinor: 100_000 }, { currency: "ILS", count: 2, oneTimeMinor: 400_000 }],
      });
      const withSim = await overviewCardNumbers(db, acc, range, { includeSimulated: true });
      expect(withSim).toMatchObject({ leadsReceived: 7, leadsSigned: 2, leadsWithoutPerson: 3 });
    });

    it("the market switcher filters every new number by the lead's market (no market = the home market)", async () => {
      expect(await overviewCardNumbers(db, acc, range, { market: uk })).toEqual({
        leadsReceived: 1, leadsSigned: 1, leadsWithoutPerson: 0, signedByCurrency: [{ currency: "GBP", count: 1, oneTimeMinor: 100_000 }],
      });
      expect(await overviewCardNumbers(db, acc, range, { market: home })).toEqual({
        leadsReceived: 5, leadsSigned: 1, leadsWithoutPerson: 2, signedByCurrency: [{ currency: "ILS", count: 2, oneTimeMinor: 400_000 }],
      });
    });

    it("deals signed in the previous period, for the comparison", async () => {
      expect((await overviewKpis(db, acc, range)).formsSigned).toBe(3);
      expect((await overviewKpis(db, acc, previousRange(range))).formsSigned).toBe(1);
    });

    it("an empty period: no leads, no signed deals", async () => {
      const empty = await overviewCardNumbers(db, acc, { from: ago(400), to: ago(370) });
      expect(empty).toEqual({ leadsReceived: 0, leadsSigned: 0, leadsWithoutPerson: 0, signedByCurrency: [] });
    });
  });

  describe("render (demo seed)", () => {
    const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await OverviewPage(props(demo.slug, sp)));
    const card = (html: string, id: string) => html.split(`data-kpi="${id}"`)[1].split("data-kpi=")[0].split("</section>")[0];

    it("five cards in order, with the accent line colours and one muted line each", async () => {
      const html = await render();
      const ids = [...html.matchAll(/data-kpi="(\w+)"/g)].map((m) => m[1]);
      expect(ids).toEqual(["revenue", "deals", "conversion", "average", "agent"]);
      expect(html).toContain('class="sas-ov2-kpi sas-ov2-kpi--money" data-kpi="revenue"');
      expect(html).toContain('class="sas-ov2-kpi sas-ov2-kpi--plain" data-kpi="deals"');
      expect(html).toContain('class="sas-ov2-kpi sas-ov2-kpi--agent" data-kpi="agent"');
      for (const id of ids) expect(card(html, id).match(/sas-ov2-kpi__line/g)?.length).toBeGreaterThanOrEqual(1);
      // The numbers match the service.
      const n = await overviewCardNumbers(db, demo.id, periodRange(30, new Date()));
      const conv = card(html, "conversion");
      if (n.leadsReceived) {
        expect(conv).toContain(`>${Math.round((n.leadsSigned / n.leadsReceived) * 100)}%<`);
        expect(conv).toContain(`${n.leadsSigned} of ${n.leadsReceived} leads`);
        expect(card(html, "agent")).toContain(`${n.leadsWithoutPerson} of ${n.leadsReceived} leads without a person`);
      } else {
        expect(conv).toContain("No leads in this period");
      }
      expect(card(html, "deals")).toMatch(/vs previous 30 days|No change vs previous 30 days/);
      // Whole amounts on the cards.
      expect(card(html, "revenue")).not.toMatch(/sas-ov2-kpi__value sas-num">[^<]*\.\d\d</);
      // The old tiles are gone; the step counts stay in the funnel.
      expect(html).not.toContain('class="sas-metric"');
      expect((await render({ period: "7" }))).toMatch(/vs previous 7 days/);
    });

    it("funnel: a From the step before column, blank on New leads, Paid with its % (and waiting when signed > paid)", async () => {
      const html = await render();
      const funnel = html.split('id="funnel-h"')[1].split("</section>")[0];
      expect(funnel).toContain('data-funnel-from-before="">From the step before<');
      const pcts = [...funnel.matchAll(/data-funnel-pct="">([^<]*)</g)].map((m) => m[1]);
      expect(pcts).toHaveLength(5);
      expect(pcts[0]).toBe("");
      for (const p of pcts.slice(1)) expect(p).toMatch(/^(\d+%|—)( · \d+ waiting)?$/);
      // The Paid bar stays green.
      expect(funnel).toContain("background:var(--success)");
    });

    it("header: blue Live pills; Include simulated moves into the View options menu, sim=1 kept", async () => {
      const html = await render();
      const head = html.split("</header>")[0];
      if (head.includes("data-agent-live")) {
        expect(head).toMatch(/class="sas-pill sas-ov2-pill--live" data-agent-live=""/);
        expect(head).not.toContain("sas-pill--success");
      }
      expect(html).toMatch(/class="sas-mcard__pill"><span class="sas-pill sas-pill--success" data-status="market.live"/);
      const menu = head.split('data-view-options=""')[1];
      expect(menu).toContain('aria-label="View options"');
      expect(menu).toContain('role="checkbox" aria-checked="false" data-include-simulated="0"');
      expect(menu).toContain(`href="/app/${demo.slug}?sim=1"`);
      expect(menu).toContain("Test lab buyers are never counted.");
      // The menu is the last of the header actions, after Recent activity.
      expect(head.indexOf("data-open-activity")).toBeLessThan(head.indexOf("data-view-options"));
      const on = await render({ sim: "1" });
      expect(on).toContain('data-include-simulated="1"');
      expect(on).toContain(`href="/app/${demo.slug}"`);
      expect(on).toContain("Including simulated data.");
      expect(card(on, "conversion")).toContain("incl. ");
    });
  });
});
