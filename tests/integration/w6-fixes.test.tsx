/**
 * Lane W6: fixes after the workspace and markets review, on the demo seed.
 * - Lead page Quotes and Orders cards: one two-line layout (ID + status, then
 *   amounts + date), order links on a third line (Ronit: one-time + monthly).
 * - A verified value keeps its check on the line of its last word.
 * - Overview filtered to one market: Paid revenue in that market's currency
 *   (£0.00 for the UK with nothing paid), the selected card marked
 *   (aria-current, class) with a link that clears back to All markets.
 * - Recent activity and the lead timeline: "Chat taken over" is the person icon.
 * On PGlite, no model.
 *
 * With W6_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { leads, users, type Market, type SellerAccount, type User } from "@/db/schema";
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
const { STATE_LEADS } = await import("@/lib/demo/states");
const { listMarkets } = await import("@/lib/markets/service");
const { marketCurrency } = await import("@/lib/overview/service");
const { getAccountById } = await import("@/lib/accounts/service");
const { leadEventIcon } = await import("@/lib/leads/event-icons");
const { verifiedTail } = await import("@/app/app/[account]/leads/[leadId]/deal-pane");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.W6_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const section = (html: string, testid: string) => html.split(`data-testid="${testid}"`)[1]?.split("</section>")[0] ?? "";
/** The timeline item whose title is `title`. */
const tlItem = (html: string, title: string) => html.split('<li class="sas-tl__item">').find((x) => x.includes(`<span class="sas-tl__title">${title}</span>`)) ?? "";

describe("W6: workspace and markets review fixes", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let il: Market, uk: Market;
  const leadOf = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, account.id), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
  const lead = async (leadId: string, sp: Record<string, string> = {}) =>
    page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId }), searchParams: Promise.resolve(sp) }));
  const overview = (sp: Record<string, string> = {}) => page(OverviewPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve(sp) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: new Date() });
    if (!a.ok) throw new Error("refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    const all = await listMarkets(db, account.id);
    [il, uk] = [all.find((m) => m.isHome)!, all.find((m) => !m.isHome)!];
  }, 120_000);
  beforeEach(() => {
    holder.cookies.clear();
    holder.access = { account, user: admin, actingAs: false, role: "seller_admin" };
  });
  afterAll(async () => t.close());

  describe("lead page Quotes and Orders cards", () => {
    it("both cards use two lines per row: ID and status, then amounts (one line) and date; order links on a third line", async () => {
      const ronit = await leadOf(STATE_LEADS.bankTransfer.n);
      const html = await lead(ronit.id);
      save("lead-ronit", html);
      for (const id of ["quotes-card", "orders-card"]) {
        const card = section(html, id);
        const row = card.match(/<a class="sas-list__row sas-lead-doc__row"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
        const lines = row.split('<span class="sas-lead-doc__line">').slice(1);
        expect(lines).toHaveLength(2);
        // Line 1: the ID (code font) first, the status pill at the end.
        expect(lines[0]).toMatch(/^<span class="sas-id">[^<]+<\/span><span class="sas-pill[^"]*"/);
        // Line 2: the amounts (one-time + monthly) in one nowrap span, then the date.
        expect(lines[1]).toMatch(/^<span class="sas-num sas-lead-doc__amount">₪[\d,.]+ \+ ₪[\d,.]+\/month<\/span><span class="sas-small sas-lead-doc__date" title="[^"]+">\d{1,2} \w{3}<\/span>/);
      }
      const orders = section(html, "orders-card");
      // Line 3: the three order actions together, after the row link.
      const links = orders.split("</a>").slice(1).join("</a>");
      // Leads V2: a transfer to confirm (or a failed payment) adds its direct action first on that line.
      expect(orders).toMatch(/<\/a><div class="sas-lead-doc__links">(<a [^>]*data-order-action="[a-z_]+">[\s\S]*?<\/a>)?<div style="[^"]*" data-signed-form-links="">/);
      for (const label of ["Signed form", "Open pay page", "Copy link"]) expect(links).toContain(label);
      // No leftover single-row classes.
      expect(orders).not.toContain("sas-list__main");
    });

    it("the CSS keeps the amounts on one line and lets the cards grow; the W6 block is balanced", () => {
      const block = css.slice(css.indexOf("W (lane W6)"));
      expect(block).toMatch(/\.sas-lead-doc__amount \{[^}]*white-space: nowrap/);
      expect(block).toMatch(/\.sas-app \.sas-lead-doc a\.sas-lead-doc__row \{ flex-direction: column;/);
      expect(block).toMatch(/minmax\(min-content, 1fr\)/);
      expect(block.split("{").length).toBe(block.split("}").length);
    });
  });

  describe("verified check on a wrapped value", () => {
    it("splits the value so the check stays with the end of the last word", () => {
      expect(verifiedTail("Shapiro Pizza Ltd")).toEqual({ head: "Shapiro Pizza ", tail: "Ltd" });
      expect(verifiedTail("Bakery")).toEqual({ head: "", tail: "Bakery" });
      // A long email: only its short end goes with the check, so the rest can still wrap.
      expect(verifiedTail("ronit@bakery-demo.example")).toEqual({ head: "ronit@bakery-demo", tail: ".example" });
      expect(verifiedTail("abcdefghijklmnopqrstuvwxyz")).toEqual({ head: "abcdefghijklmnopqrst", tail: "uvwxyz" });
      expect(verifiedTail("רחוב הדמו 5, רמת גן")).toEqual({ head: "רחוב הדמו 5, רמת ", tail: "גן" });
    });

    it("Ronit's invoice email renders the check inline inside a nowrap tail, and the CSS makes it inline", async () => {
      const ronit = await leadOf(STATE_LEADS.bankTransfer.n);
      const html = await lead(ronit.id);
      const pane = html.split('data-testid="deal-pane"')[1];
      expect(pane).toMatch(/<span class="sas-verified-value">ronit@bakery-demo<span class="sas-verified-tail">\.example<span class="sas-verified" role="img" aria-label="From the signed order form, [^"]+"/);
      const block = css.slice(css.indexOf("W (lane W6)"));
      expect(block).toMatch(/\.sas-verified-value \{ display: inline;/);
      expect(block).toMatch(/\.sas-verified-tail \{ white-space: nowrap; \}/);
    });
  });

  describe("Overview filtered to one market", () => {
    it("Paid revenue shows the market's currency: £0 for the UK with nothing paid, ₪ for Israel", async () => {
      expect(await marketCurrency(db, account.id, uk, account.currency)).toBe("GBP");
      expect(await marketCurrency(db, account.id, { priceListLineageId: null }, "ILS")).toBe("ILS");
      const ukHtml = await overview({ market: uk.id });
      save("overview-uk", ukHtml);
      const ukTile = ukHtml.split('data-kpi="revenue"')[1].split('data-kpi="deals"')[0];
      // OV2: whole amounts on the cards.
      expect(ukTile).toContain('sas-ov2-kpi__value sas-num">£0<');
      expect(ukTile).not.toContain("₪");
      const ilTile = (await overview({ market: il.id })).split('data-kpi="revenue"')[1].split('data-kpi="deals"')[0];
      expect(ilTile).toContain("₪");
      expect(ilTile).not.toContain("£");
    });

    it("the selected card is marked (class + aria-current) and its link clears back to All markets; the others stay as they are", async () => {
      const html = await overview({ market: uk.id });
      const cards = html.split('aria-labelledby="markets-h"')[1].split("</section>")[0];
      const card = (id: string) => cards.split(`data-market-card="${id}"`)[0].split("<a ").pop()!;
      const sel = card(uk.id);
      expect(sel).toContain('class="sas-mcard sas-mcard--selected"');
      expect(sel).toContain('aria-current="true"');
      expect(sel).toContain('aria-label="United Kingdom: shown now. Show all markets"');
      const href = new URL(sel.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&"), "http://x");
      expect(href.pathname).toBe(`/app/${account.slug}/market`);
      expect(href.searchParams.get("market")).toBe("all");
      const other = card(il.id);
      expect(other).not.toContain("sas-mcard--selected");
      expect(other).not.toContain("aria-current");
      expect(new URL(other.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&"), "http://x").searchParams.get("market")).toBe(il.id);
      // All markets: no card is marked.
      const all = await overview({ market: "all" });
      expect(all).not.toContain("sas-mcard--selected");
      // The CSS: a 2px primary border; the card width stays 264px.
      expect(css).toMatch(/\.sas-app a\.sas-mcard--selected, \.sas-app a\.sas-mcard--selected:hover \{ border: 2px solid var\(--primary\); \}/);
      expect(css).toMatch(/\.sas-mcards__list > li \{ width: 264px;/);
    });
  });

  describe("activity icons", () => {
    it("one map for both places: Chat taken over is the person icon, handed back the agent's", () => {
      expect(leadEventIcon("conversation.taken_over")).toBe("user");
      expect(leadEventIcon("conversation.handed_back")).toBe("sparkles");
      expect(leadEventIcon("conversation.started", { simulator: true })).toBe("flask-conical");
      expect(leadEventIcon("conversation.started")).toBe("send");
      expect(leadEventIcon("something.new")).toBe("cog");
    });

    it("Recent activity and the lead timeline show Chat taken over with the person icon, not the gear", async () => {
      const html = await overview({ panel: "activity" });
      save("overview-activity", html);
      const item = tlItem(html, "Chat taken over");
      expect(item).toMatch(/lucide lucide-user sas-ico/);
      expect(item).not.toContain("lucide-cog");
      const noam = await leadOf(STATE_LEADS.handBack.n);
      const leadHtml = await lead(noam.id, { timeline: "open" });
      const leadItem = tlItem(leadHtml, "Chat taken over");
      expect(leadItem).toMatch(/lucide lucide-user sas-ico/);
    });
  });
});
