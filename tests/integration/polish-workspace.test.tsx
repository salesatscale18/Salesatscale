/**
 * Live-review polish, Packages 2 and 5 (lane Polish-2+5): seller pages on a
 * phone and seller workspace polish. Rendered pages on PGlite; the phone
 * layouts themselves are CSS (components/sas/sas.css), so these tests check
 * the markup the CSS relies on and the texts and data the pages show.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { messages, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, path: "/" }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => holder.path,
  useRouter: () => ({ refresh: () => {} }),
}));

const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { listPriceLists } = await import("@/lib/pricing/price-lists");
const { catalogState } = await import("@/lib/catalog/service");
const { SideNavForPath } = await import("@/components/sas/side-nav-client");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: PriceListPage } = await import("@/app/app/[account]/setup/price-lists/[lineageId]/page");
const { default: SourcesPage } = await import("@/app/app/[account]/setup/sources/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ account, ...extra }) as Promise<{ account: string } & Record<string, string>>,
  searchParams: Promise.resolve(sp),
});
const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
/** Every <td> of a stacked table either is the card title (first cell) or names its column. */
function unlabelledCells(html: string, tableClass = "sas-table--stack"): number {
  const tables = html.split(tableClass).slice(1);
  let n = 0;
  for (const tb of tables) {
    const body = tb.split("</table>")[0];
    for (const row of body.split("<tr").slice(2)) {
      const cells = row.match(/<td[^>]*>/g) ?? [];
      n += cells.slice(1).filter((c) => !c.includes("data-label=")).length;
    }
  }
  return n;
}

describe("Polish-2+5: seller workspace", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let acc = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "testuser+clerk_test@salesatscale.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true }).where(eq(sellerAccounts.id, acc));
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
    ]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      fields: [
        ...draft.playbook.fields.filter((f) => f.stage === "before_quote"),
        { key: "company_name", label: "Company name", stage: "before_order_form" },
        { key: "company_id", label: "Company ID", stage: "before_order_form" },
        { key: "billing_address", label: "Billing address", stage: "before_order_form" },
      ],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    const actor = { userId: me.id, actingAs: false };

    const before = await createSimulatedBuyer(db, actor, account, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!before.ok) throw new Error();
    ids.before = before.lead.id;
    const started = await createSimulatedBuyer(db, actor, account, { fullName: "Tamar Golan", company: "Golan Bakery", language: "en", country: "IL" });
    if (!started.ok) throw new Error();
    ids.started = started.lead.id;
    const st = await startSimulatorConversation(db, actor, acc, started.lead.id, new Date("2026-11-17T21:28:00Z"));
    if (!st.ok) throw new Error(st.reason);
    ids.conv = st.conversationId;
    await db.insert(messages).values({ id: randomUUID(), accountId: acc, conversationId: st.conversationId, actor: "buyer", body: "2 fridges, one kitchen", language: "en", createdAt: new Date("2026-11-18T09:05:00Z") });
    const ctx = (callId: string) => ({ db, accountId: acc, conversationId: st.conversationId, leadId: started.lead.id, playbook: draft.playbook, currency: "ILS", callId, language: "en" });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: "quote then order form", objection: null }, ctx("u1"));
    const q = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, ctx("q1"));
    ids.quote = String(q.result.quote_id);
  });
  afterAll(async () => t.close());

  describe("Package 2: seller pages on a phone", () => {
    it("the shell has a phone top bar with a menu button (aria-expanded) and a details drawer holding the nav", () => {
      holder.path = `/app/${account.slug}/leads`;
      const out = renderToStaticMarkup(
        <SideNavForPath mode="seller" basePath={`/app/${account.slug}`} accountName="Polar Demo" user={{ name: "D", initials: "D" }} counts={{ overview: { value: 3, tone: "human" } }} />,
      );
      expect(out).toContain('class="sas-shell__nav"');
      expect(out).toMatch(/<details class="sas-drawer"><summary class="sas-topbar__menu" aria-expanded="false" aria-controls="sas-drawer-panel">/);
      expect(out).toContain('id="sas-drawer-panel"');
      // The nav sits in both: the side column (wide) and the drawer (phone), with the same active item.
      expect(out.match(/aria-current="page"/g)).toHaveLength(2);
      expect(out).toContain(">Menu<");
      // CSS: below 768px the side column hides and the top bar shows.
      expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.sas-shell \{[^}]*"banners" "topbar" "main"/);
    });

    it("tables become stacked cards: every cell after the first names its column", async () => {
      const leadsHtml = await page(LeadsPage(props(account.slug)));
      expect(leadsHtml).toContain("sas-table sas-table--stack");
      expect(leadsHtml).toContain('data-label="Status"');
      expect(unlabelledCells(leadsHtml)).toBe(0);
      const quotesHtml = await page(OrdersPage(props(account.slug)));
      expect(quotesHtml).toContain("sas-table--stack");
      expect(unlabelledCells(quotesHtml)).toBe(0);
      const catalogHtml = await page(CatalogPage(props(account.slug)));
      expect(unlabelledCells(catalogHtml)).toBe(0);
      const [list] = await listPriceLists(db, acc);
      const plHtml = await page(PriceListPage(props(account.slug, {}, { lineageId: list.lineageId }) as never));
      expect(plHtml).toContain('data-label="One-time"');
      expect(unlabelledCells(plHtml)).toBe(0);
      const srcHtml = await page(SourcesPage(props(account.slug)));
      expect(srcHtml).not.toContain("sas-table sas-table--stack\" style"); // no sources yet: empty state, no table
    });

    it("catalog item and price entry open as a full-height sheet with Save pinned", async () => {
      const cat = await catalogState(db, acc);
      const html = await page(CatalogPage(props(account.slug, { item: cat.items[0].id })));
      expect(html).toMatch(/<aside class="[^"]*sas-sheet"/);
      expect(html).toContain('class="sas-sheet__save"');
      const [list] = await listPriceLists(db, acc);
      const pl = await page(PriceListPage(props(account.slug, { sku: "GW-10" }, { lineageId: list.lineageId }) as never));
      expect(pl).toContain("sas-sheet sas-sheet--stack");
      expect(pl).toMatch(/class="sas-sheet__save"/);
      expect(css).toMatch(/\.sas-sheet \.sas-sheet__save \{ position: sticky; bottom: 0/);
    });

    it("lead page: Chat · Deal · Timeline tabs with a compact deal summary on top", async () => {
      const html = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.started }) as never));
      expect(html).toContain('id="lt-chat"');
      expect(html).toMatch(/<label for="lt-chat">Chat<\/label><label for="lt-deal">Deal<\/label><label for="lt-timeline">Timeline<\/label>/);
      expect(html).toContain('data-tab="chat"');
      expect(html).toContain('data-tab="deal"');
      expect(html).toContain('data-tab="timeline"');
      expect(html).toMatch(/data-testid="lead-summary"[\s\S]*3 deal fields not known yet/);
    });

    it("settings sections are a chip strip that scrolls the current one into view", async () => {
      const html = await page(SettingsPage(props(account.slug, { section: "hours" })));
      expect(html).toMatch(/class="sas-subnav"/);
      expect(css).toMatch(/\.sas-subnav \{ flex: 1 1 100%; max-width: none; flex-direction: row;[^}]*overflow-x: auto/);
    });
  });

  describe("Package 5: seller workspace polish", () => {
    it("lead page: Take over in the header, one-line simulator, sentence next step, grouped unknowns, no second Market panel", async () => {
      const html = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.started }) as never));
      const head = html.split('class="sas-lead__head"')[1].split("</header>")[0];
      expect(head).toContain('data-testid="header-take-over"');
      // Only one Take over button on the page.
      expect(html.match(/>Take over chat</g)).toHaveLength(1);
      expect(html).toContain("data-sim-compact");
      expect(html).toMatch(/Simulated buyer<\/h2>.*Open buyer chat.*Copy link.*Reset link/s);
      expect(html).not.toContain("makes the agent send its opening message");
      expect(html).toContain("Quote, then order form.");
      expect(html).toMatch(/data-testid="unknown-group"[\s\S]*Order form details: 3 not known yet/);
      expect(html).not.toContain('id="lm-h"');
      expect(html).toContain('data-testid="lead-market"');
      // People by name or You, never the email; times in the account's zone, zone on hover; day dividers.
      expect(html).not.toContain("testuser+clerk_test@");
      expect(html).toContain("added by You, ");
      expect(html).toMatch(/title="17 Nov 2026, 23:28 GMT\+2">23:28( ·|<)/);
      expect(html).toContain('aria-label="Messages from Tue, 17 Nov 2026"');
      expect(html).toContain('aria-label="Messages from Wed, 18 Nov 2026"');
      expect(html).not.toContain(" UTC</span>");
    });

    it("lead page before start: Start is offered with its help, and the empty chat says to press it", async () => {
      const html = await page(LeadCardPage(props(account.slug, {}, { leadId: ids.before }) as never));
      expect(html).toContain(">Start conversation<");
      expect(html).toContain("makes the agent send its opening message");
      expect(html).toContain("Press Start conversation to have the agent send its opening message.");
      expect(html).not.toContain("data-sim-compact");
      expect(html).not.toContain('data-testid="header-take-over"');
    });

    it("conversations: plain market, neutral Open lead card icon, selected row in primary-soft", async () => {
      const sel = await page(ConversationsPage(props(account.slug, { c: ids.conv })));
      expect(sel).toContain("lucide-arrow-up-right");
      expect(sel).toContain('data-market="">Israel<');
      expect(sel).not.toContain("testuser+clerk_test@");
      expect(css).toContain('.sas-app a.sas-inbox__row[aria-current="page"] { background: var(--primary-soft);');
    });

    it("quotes: Status column, chat name first, no zero discount, Sent pill inline", async () => {
      const list = await page(OrdersPage(props(account.slug)));
      expect(list).toMatch(/<th scope="col">Status<\/th><th scope="col">Order form<\/th>/);
      const detail = await page(OrdersPage(props(account.slug, { quote: ids.quote })));
      expect(detail).toMatch(/1 × Kitchen hub<div class="sas-small">Site gateway <span class="sas-num">GW-10<\/span>/);
      expect(detail).not.toMatch(/>Discount</);
      expect(detail).toContain('data-testid="detail-status"');
    });

    it("overview: greeting without an email; Needs you marked to come first on a phone; tabs and segments use primary-soft", async () => {
      const html = await page(OverviewPage(props(account.slug)));
      expect(html).toMatch(/<h1 class="sas-title">Good (morning|afternoon|evening)<\/h1>/);
      expect(html).toContain("sas-ov__needs");
      expect(html).toContain('data-funnel-track=""');
      expect(css).toContain('.sas-app a.sas-view[aria-current="page"] { background: var(--primary-soft); color: var(--primary);');
      expect(css).toContain('.sas-app a.sas-tab[aria-current="page"] { color: var(--primary);');
    });

    it("leads: Add lead first with the rest under More; filters behind a Filters button; market as plain text", async () => {
      const html = await page(LeadsPage(props(account.slug, { source: "Simulated buyer" })));
      expect(html).toContain('class="sas-more"');
      expect(html).toMatch(/for="lf-open"[^>]*>.*Filters · 1/);
      expect(html).not.toMatch(/class="sas-chip" data-market/);
    });

    it("Package 7.2: one step bar everywhere: same states, 'Price lists', no Follow-ups step, on sub-pages and Test lab too", async () => {
      const bar = (html: string) => {
        const nav = html.split('<ol class="sas-steps">')[1]?.split("</ol>")[0] ?? "";
        return [...nav.matchAll(/<a class="([^"]+)" href="[^"]*\/setup\/([a-z-]+)"/g)].map((m) => `${m[2]}:${m[1].includes("--done") ? "done" : "open"}`);
      };
      const [list] = await listPriceLists(db, acc);
      const pages = await Promise.all([
        page(CatalogPage(props(account.slug))),
        page(GoLivePage(props(account.slug))),
        page(TestLabPage(props(account.slug))),
        page(PriceListPage(props(account.slug, {}, { lineageId: list.lineageId }) as never)),
      ]);
      const states = pages.map(bar);
      // Go live used to show numbers for steps the other pages showed as done.
      for (const s of states) expect(s).toEqual(states[0]);
      expect(states[0]).toHaveLength(8);
      expect(states[0].join(",")).not.toContain("follow-ups");
      expect(states[0]).toContain("catalog:done");
      expect(pages[0]).toMatch(/\/setup\/price-lists"[^>]*><span class="sas-steps__dot">[^<]*(<svg[\s\S]*?<\/svg>)?<\/span>Price lists</);
      // Sub-page marks its step; Test lab is no step.
      expect(pages[3]).toMatch(/href="[^"]*\/setup\/price-lists" aria-current="step"/);
      expect(pages[2]).not.toContain('aria-current="step"');
      // Follow-ups is out of the nav (its placeholder route stays).
      holder.path = `/app/${account.slug}`;
      const nav = renderToStaticMarkup(<SideNavForPath mode="seller" basePath={`/app/${account.slug}`} accountName="P" user={{ name: "D", initials: "D" }} />);
      expect(nav).not.toContain("/setup/follow-ups");
    });

    it("opt-out icon follows the danger button colour", () => {
      expect(css).toContain(".sas-lead__consent > .sas-ico {");
      expect(css).not.toContain(".sas-lead__consent .sas-ico {");
    });
  });
});
