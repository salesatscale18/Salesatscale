/**
 * Lane W5: UX follow-ups after the workspace-and-markets release, on PGlite.
 * - Overview: "Set up your account" comes above "Your markets" while the
 *   account is not live, and does not show once it is live.
 * - Market switcher: the compact class (as wide as the choice, at most 200px)
 *   and the no-JS Apply button.
 * - Catalog: Kind and unit fold into a second line under the item name; no
 *   Kind or Charged column; "Sold in" is a narrow column; Status stays.
 * - Lead page Orders card: "Open pay page" and "Copy link" are ghost buttons,
 *   like "Signed form"; the Orders page panel keeps them secondary.
 * - Spend cap: a buyer message that starts a conversation at the AI spend cap
 *   writes one lead event (handoff.spend_cap, with the conversation id) and
 *   the thread shows "Handed to a person: AI limit reached" whether or not the
 *   agent's steps are shown, on WhatsApp and on the buyer simulator.
 *
 * With W5_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq, inArray } from "drizzle-orm";
import { consentRecords, conversations, leadEvents, leads, markets, orders, sellerAccounts, users, type Market, type SellerAccount, type User } from "@/db/schema";
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
  headers: async () => new Headers({ host: "app.example.com" }),
  cookies: async () => ({ get: (name: string) => (holder.cookies.has(name) ? { name, value: holder.cookies.get(name)! } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { getAccountById, createAccount } = await import("@/lib/accounts/service");
const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createMarket, listMarkets } = await import("@/lib/markets/service");
const { MarketSwitcher } = await import("@/components/sas/market-switcher");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { addConnection } = await import("@/lib/channels/connections");
const { receiveInbound } = await import("@/lib/channels/whatsapp");
const { createSimulatedBuyer, receiveSimulatorInbound, resolveChatToken } = await import("@/lib/simulator/service");
const { SPEND_CAP_HANDOFF_EVENT } = await import("@/lib/agent/thread-markers");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const OUT = process.env.W5_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
}
const headers = (html: string) => [...(html.split("<thead>")[1] ?? "").split("</thead>")[0].matchAll(/<th[^>]*>(?:<a[^>]*>)?([^<]*)/g)].map((m) => m[1].trim());
const MARKER = /data-thread-marker="spend_cap"[\s\S]*?Handed to a person: AI limit reached/;

describe("W5: UX follow-ups (demo account)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let all: Market[];
  const as = (a: SellerAccount) => { holder.access = { account: a, user: admin, actingAs: false, role: "seller_admin" }; };
  const slug = () => ({ account: account.slug });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_w5", email: "w5@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: new Date() });
    if (!a.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    all = await listMarkets(db, account.id);
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.cookies.clear(); as(account); });

  describe("Overview: Set up your account", () => {
    it("not live: one slim setup card first, before the KPI row and Your markets", async () => {
      as({ ...account, status: "setting_up" });
      const html = await page(OverviewPage, slug());
      save("overview-setup", html);
      const kpis = html.indexOf('aria-label="Key numbers"') >= 0 ? html.indexOf('aria-label="Key numbers"') : html.indexOf("sas-metrics");
      const setup = html.indexOf('id="setup-h"');
      const marketsAt = html.indexOf("Your markets");
      expect(setup).toBeGreaterThan(0);
      expect(marketsAt).toBeGreaterThan(0);
      expect(setup).toBeLessThan(marketsAt);
      expect(setup).toBeLessThan(kpis);
      expect(html).toContain(">Finish setting up your agent</h2>");
      // One "Continue" link to the first open step instead of the full list of steps.
      expect(html).toMatch(/data-setup-next="[a-z-]+"/);
      expect(html).not.toMatch(/<ol class="sas-list">[\s\S]*?aria-current="step"/);
    });
    it("live: no setup row; Your markets still shows", async () => {
      as({ ...account, status: "live" });
      const html = await page(OverviewPage, slug());
      expect(html).not.toContain('id="setup-h"');
      expect(html).toContain("Your markets");
    });
  });

  describe("Market switcher", () => {
    it("compact class, the chosen market selected, full option labels, and an Apply button without JS", () => {
      const uk = all.find((m) => m.countries.includes("GB"))!;
      const html = renderToStaticMarkup(MarketSwitcher({ slug: "polar", selection: { markets: all, selected: uk, showSwitcher: true }, returnTo: "/app/polar/leads" }));
      expect(html).toMatch(/<form class="sas-mswitch sas-mswitch--compact" data-market-switcher="" action="\/app\/polar\/market" method="get">/);
      expect(html).toContain('<input type="hidden" name="next" value="/app/polar/leads"/>');
      expect(html).toMatch(new RegExp(`<option value="${uk.id}" title="United Kingdom · [A-Z][a-z ]+" selected="">United Kingdom</option>`));
      expect(html).toContain('<label class="sas-mswitch__field" for="market-switcher">');
      expect(html).toMatch(/<noscript><button type="submit" class="sas-btn sas-btn--secondary sas-btn--sm">Apply<\/button><\/noscript>/);
    });
    it("the stylesheet sizes it to the choice and caps it at 200px (fallback for browsers without field-sizing)", () => {
      const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
      const rule = css.match(/\.sas-mswitch--compact \.sas-mswitch__select \{([^}]*)\}/)?.[1] ?? "";
      expect(rule).toContain("field-sizing: content");
      expect(rule).toContain("max-width: 200px");
    });
  });

  describe("Catalog columns", () => {
    it("two markets: Item (with kind · unit under the name), Code, Price, Sold in (narrow), Rules, Status", async () => {
      const html = await page(CatalogPage, slug());
      save("catalog-2", html);
      expect(headers(html)).toEqual(["Item", "Code", "Price", "Sold in", "Rules", "Status", ""]);
      expect(html).toContain('<th scope="col" class="sas-catalog__soldin">Sold in</th>');
      expect(html).toMatch(/<td class="sas-catalog__soldin" data-label="Sold in"><span data-sold-in=/);
      expect(html).not.toContain('data-label="Kind"');
      expect(html).not.toContain('data-label="Charged"');
      // The second line: "Product · per device" (or Service), under the name.
      expect(html).toMatch(/<\/strong><\/a><span class="sas-small" style="display:block" data-item-kind="(product|service)">(Product|Service) · per [a-z ]+<\/span>/);
      expect(html).toMatch(/data-label="Status"><span class="sas-pill/);
    });
    it("four markets: the same columns; Sold in shortens to two names +N", async () => {
      const home = all.find((m) => m.isHome)!;
      for (const [name, c, p] of [["Germany", "DE", "+49"], ["France", "FR", "+33"]] as const) {
        const r = await createMarket(db, { userId: admin.id, actingAs: false }, account.id, { name, countries: [c], phonePrefixes: [p] });
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
        await db.update(markets).set({ priceListLineageId: home.priceListLineageId }).where(eq(markets.id, r.market.id));
      }
      const uk = all.find((m) => m.countries.includes("GB"))!;
      await db.update(markets).set({ priceListLineageId: home.priceListLineageId }).where(eq(markets.id, uk.id));
      try {
        const html = await page(CatalogPage, slug());
        save("catalog-4", html);
        expect(headers(html)).toEqual(["Item", "Code", "Price", "Sold in", "Rules", "Status", ""]);
        expect(html).toMatch(/data-sold-in="4" title="[^"]+">[^<,]+, [^<,]+ \+2</);
      } finally {
        await db.update(markets).set({ priceListLineageId: uk.priceListLineageId }).where(eq(markets.id, uk.id));
      }
    });
  });

  describe("Signed form links", () => {
    it("lead page Orders card: Open pay page and Copy link are ghost, like Signed form; the Orders page panel keeps secondary", async () => {
      const open = await db.select().from(orders).where(and(eq(orders.accountId, account.id), inArray(orders.paymentStatus, ["not_started", "bank_transfer_expected", "failed"])));
      expect(open.length).toBeGreaterThan(0);
      const order = open[0];
      const lead = await page(LeadCardPage, { account: account.slug, leadId: order.leadId });
      save("lead-orders", lead);
      const card = lead.split('data-testid="orders-card"')[1]?.split("</section>")[0] ?? "";
      const links = card.split("data-signed-form-links")[1] ?? "";
      expect(links).toMatch(/<a class="sas-btn sas-btn--ghost sas-btn--sm" href="[^"]+\/document"/);
      expect(links).toMatch(/<a class="sas-btn sas-btn--ghost sas-btn--sm" href="[^"]+" target="_blank" rel="noreferrer" data-pay-link="">/);
      expect(links).toMatch(/<button type="button" class="sas-btn sas-btn--ghost sas-btn--sm" aria-live="polite">[\s\S]*?Copy link/);
      expect(links).not.toContain("sas-btn--secondary");

      const panel = await page(OrdersPage, slug(), { quote: order.quoteId });
      const panelLinks = panel.split("data-signed-form-links")[1] ?? "";
      expect(panelLinks).toMatch(/<a class="sas-btn sas-btn--secondary sas-btn--sm" href="[^"]+" target="_blank" rel="noreferrer" data-pay-link="">/);
      expect(panelLinks).toMatch(/<button type="button" class="sas-btn sas-btn--secondary sas-btn--sm" aria-live="polite">[\s\S]*?Copy link/);
    });
  });
});

describe("W5: spend-cap hand-off marker", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  const SENDER = "+14155238801";
  const actor = () => ({ userId: me.id, actingAs: false });
  const sid = () => `SM${randomBytes(16).toString("hex")}`;
  const capEvents = (leadId: string) => db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, SPEND_CAP_HANDOFF_EVENT)));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-w5", email: "cap@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Capped", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "cap@x.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const id = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, id);
    await publishDraftVersion(db, actor(), id);
    const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
    // A zero cap: the account is at its monthly AI spend cap.
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY, monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, id));
    await addConnection(db, actor(), { id, market: "IL" }, { senderNumber: SENDER, displayName: "Capped", messagingServiceSid: "", marketId: null });
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.cookies.clear(); holder.access = { account, user: me, actingAs: false, role: "seller_admin" }; });

  const expectMarkerBothWays = async (leadId: string, conversationId: string, name: string) => {
    // The lead page (steps off by default and on) and the Conversations pane.
    for (const steps of ["0", "1"]) {
      const lead = await page(LeadCardPage, { account: account.slug, leadId }, { steps });
      if (steps === "0") save(`${name}-lead`, lead);
      expect(lead).toContain(`data-agent-steps="${steps === "1" ? "on" : "off"}"`);
      expect(lead.match(/data-thread-marker="spend_cap"/g)?.length).toBe(1);
      expect(lead).toMatch(MARKER);
      const inbox = await page(ConversationsPage, { account: account.slug }, { c: conversationId, steps });
      expect(inbox).toMatch(MARKER);
    }
    // The lead's timeline names it too.
    const lead = await page(LeadCardPage, { account: account.slug, leadId }, { timeline: "open" });
    expect(lead.split('data-testid="timeline-fold"')[1]).toContain("Handed to a person: AI limit reached");
  };

  it("WhatsApp: the first message at the cap starts a person-held conversation and writes the event once", async () => {
    const [lead] = await db.insert(leads).values({ accountId: account.id, fullName: "Rina Cohen", phone: "+972501119001", language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: account.id, leadId: lead.id, wording: "I agree", source: "Form", capturedAt: new Date() });
    const params = (Body: string) => ({ From: "whatsapp:+972501119001", To: `whatsapp:${SENDER}`, MessageSid: sid(), Body, NumMedia: "0" });
    const first = await receiveInbound(db, params("hi"));
    expect(first.kind).toBe("stored");
    if (first.kind !== "stored") throw new Error();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, first.conversationId));
    expect(conv.status).toBe("human");
    // A second message goes to the same conversation: no second event.
    expect(await receiveInbound(db, params("anyone there?"))).toMatchObject({ kind: "stored", conversationId: conv.id });
    const events = await capEvents(lead.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: account.id, actor: "system", data: { conversationId: conv.id, reason: "spend_cap" } });
    const view = await conversationView(db, account.id, conv);
    expect(view.markers?.filter((m) => m.kind === "spend_cap")).toHaveLength(1);
    await expectMarkerBothWays(lead.id, conv.id, "cap-whatsapp");
  });

  it("buyer simulator: the same event and marker (shared inbound path), once", async () => {
    const buyer = await createSimulatedBuyer(db, actor(), account, { fullName: "Avi Levi", company: "Burger Lab", language: "en", country: "IL" });
    if (!buyer.ok) throw new Error(JSON.stringify(buyer.errors));
    const ctx = (await resolveChatToken(db, buyer.token))!;
    const first = await receiveSimulatorInbound(db, ctx, "hello", randomUUID());
    expect(first.kind).toBe("stored");
    if (first.kind !== "stored") throw new Error();
    expect((await receiveSimulatorInbound(db, ctx, "hello again", randomUUID())).kind).toBe("stored");
    const events = await capEvents(buyer.lead.id);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ conversationId: first.conversationId, reason: "spend_cap" });
    await expectMarkerBothWays(buyer.lead.id, first.conversationId, "cap-sim");
  });

  it("under the cap: a new conversation starts on the agent and no event is written", async () => {
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 1_000_000 }).where(eq(sellerAccounts.id, account.id));
    try {
      const [lead] = await db.insert(leads).values({ accountId: account.id, fullName: "Noa Levi", phone: "+972501119002", language: "en", origin: "manual" }).returning();
      await db.insert(consentRecords).values({ accountId: account.id, leadId: lead.id, wording: "I agree", source: "Form", capturedAt: new Date() });
      const r = await receiveInbound(db, { From: "whatsapp:+972501119002", To: `whatsapp:${SENDER}`, MessageSid: sid(), Body: "hi", NumMedia: "0" });
      if (r.kind !== "stored") throw new Error(r.kind);
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
      expect(conv.status).toBe("open");
      expect(await capEvents(lead.id)).toHaveLength(0);
    } finally {
      await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, account.id));
    }
  });
});
