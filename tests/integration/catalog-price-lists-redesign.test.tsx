/**
 * Setup redesign (lane R3-4): the Catalog list page with its item sheet and
 * rule panel, the Price lists table and one price list's detail page, on
 * PGlite: filters, sorting, prices from a chosen list, rule chips, the sheet's
 * tabs, the rule edit, rename and delete with their rules.
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { catalogVersions, leads, quoteVersions, quotes, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
}));

const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: PriceListsPage } = await import("@/app/app/[account]/setup/price-lists/page");
const { default: PriceListPage } = await import("@/app/app/[account]/setup/price-lists/[lineageId]/page");
const catalogActions = await import("@/app/app/[account]/setup/catalog/actions");
const plActions = await import("@/app/app/[account]/setup/price-lists/actions");
const { catalogState } = await import("@/lib/catalog/service");
const { createPriceList, listPriceLists, priceListVersions, setEntry } = await import("@/lib/pricing/price-lists");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const form = (v: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) for (const one of Array.isArray(val) ? val : [val]) f.append(k, one);
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
/** Rendered rows of the first stacked table, as their text. */
const tableRows = (html: string) => (html.split("<tbody>")[1] ?? "").split("</tbody>")[0].split(/<tr[^>]*>/).slice(1).map(text);

describe("Setup redesign: Catalog and Price lists", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc: SellerAccount, other: SellerAccount;
  let israel = "", uk = "";
  const as = (account: SellerAccount) => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; };
  const cat = (sp: Record<string, string> = {}) => render(CatalogPage, { account: acc.slug }, sp);
  const lists = (sp: Record<string, string> = {}) => render(PriceListsPage, { account: acc.slug }, sp);
  const detail = (lineageId: string, sp: Record<string, string> = {}) => render(PriceListPage, { account: acc.slug, lineageId }, sp);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device", plainName: "wireless fridge sensor" },
      { sku: "GW-10", name: "Site gateway", unit: "site", plainName: "kitchen hub" },
      { sku: "CRP-40", name: "Cold room probe", unit: "device" },
      { sku: "INST-1", name: "Installation", unit: "site", kind: "service" },
      { sku: "SVC-REM", name: "Remote setup", unit: "site", kind: "service", active: false },
    ], [
      { kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
    ]);
    await seedCatalog(db, other.id, [{ sku: "OTH-1", name: "Other item" }], [{ kind: "advice", text: "Other advice" }]);
    israel = (await seedPricing(db, acc.id, [
      { sku: "SNS-200", oneTime: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "INST-1", oneTime: 25_000 },
      { sku: "SVC-REM", oneTime: 0 },
    ], { name: "Israel prices", pricesIncludeTax: false, taxRateBp: 1800, userId: admin.id })).lineageId;
    const created = await createPriceList(db, { userId: admin.id, actingAs: false }, acc.id, { name: "UK prices", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2000 });
    if (!created.ok) throw new Error(created.error);
    uk = created.list.lineageId;
    await setEntry(db, { userId: admin.id, actingAs: false }, acc.id, uk, { sku: "SNS-200", oneTimeCharged: true, oneTimeMinor: 12_900, recurringCharged: false, recurringMinor: null });
    // A draft price change in the Israel list: v2 draft with CRP-40 charged but not priced yet.
    await setEntry(db, { userId: admin.id, actingAs: false }, acc.id, israel, { sku: "CRP-40", oneTimeCharged: true, oneTimeMinor: null, recurringCharged: false, recurringMinor: null });
    as(acc);
  });
  afterAll(async () => { await t.close(); });

  describe("Catalog", () => {
    it("items table: columns, prices from the home market's list, Not priced, rule chips, chat name, footer", async () => {
      const html = await cat();
      save("catalog", html);
      const tx = text(html);
      expect(html).toMatch(/<option value="[0-9a-f-]{36}" selected="">Prices from: Israel prices<\/option>/);
      for (const h of ["Item", "Code", "Kind", "Charged", "Price", "Rules", "Status"]) expect(html).toMatch(new RegExp(`<th[^>]*>(<a[^>]*>)?${h}`));
      const rows = tableRows(html);
      expect(rows).toHaveLength(5);
      // Sorted by name by default (aria-sort on Item).
      expect(html).toMatch(/<th scope="col" aria-sort="ascending" class="sas-th-sort"><a[^>]*>Item/);
      expect(rows[0]).toMatch(/^Cold room probeCRP-40Productper devicePrice missing—Price missing/);
      const gw = rows.find((r) => r.startsWith("Site gateway"))!;
      expect(gw).toContain("In chat: Kitchen hub");
      expect(gw).toContain("₪660.00 + ₪90.00/month");
      expect(gw).toContain("Adds Installation");
      expect(rows.find((r) => r.startsWith("Wireless"))).toContain("Needs Site gateway");
      expect(rows.find((r) => r.startsWith("Remote setup"))).toMatch(/₪0\.00.*Inactive/);
      expect(await cat({ pl: uk })).toContain('data-price="not-priced"');
      expect(tx).toContain("5 items · 1 has no price in Israel prices, so the agent can't quote it there · Open price lists");
      // Header: no draft yet, so no Publish; Add item opens the sheet.
      expect(tx).not.toContain("Publish v2");
      expect(html).toContain("/setup/catalog?item=new");
      // Rules card: sentences with Edit and remove, the form is not on the page.
      expect(tx).toContain("Rules · 2");
      expect(tx).toMatch(/When a quote has Site gateway \(GW-10\), add Installation \(INST-1\) × number of sites\./);
      expect(html).toMatch(/<span class="sas-nowrap">\(GW-10\)<\/span>/);
      expect(html).toMatch(/href="\/app\/polar\/setup\/catalog\?panel=rule&amp;rule=[0-9a-f-]{36}"/);
      expect(html).not.toContain('id="rule-form"');
      expect(html).not.toContain("sas-sp__panel");
      // Another account's items and rules never show.
      expect(tx).not.toContain("Other item");
    });

    it("filters and sort: kind chip, status filter, search, Prices from another list, sort by price", async () => {
      expect(tableRows(await cat({ kind: "service" })).map((r) => r.split("INST")[0].split("SVC")[0])).toEqual(["Installation", "Remote setup"]);
      expect(tableRows(await cat({ status: "price_missing" }))).toHaveLength(1);
      expect(tableRows(await cat({ q: "kitchen" }))[0]).toMatch(/^Site gateway/);
      const none = await cat({ q: "nothing-like-this" });
      expect(text(none)).toContain("No items match.");
      const ukHtml = await cat({ pl: uk });
      expect(ukHtml).toMatch(/<option value="[0-9a-f-]{36}" selected="">Prices from: UK prices<\/option>/);
      expect(text(ukHtml)).toContain("3 have no price in UK prices, so the agent can't quote them there");
      expect(tableRows(ukHtml).find((r) => r.startsWith("Wireless"))).toContain("£129.00");
      const byPrice = tableRows(await cat({ sort: "price", dir: "desc" }));
      expect(byPrice[0]).toMatch(/^Site gateway/);
      // Chip links keep the other filters and drop an open sheet.
      const chipHtml = await cat({ status: "active", item: "new" });
      expect(chipHtml).toMatch(/href="\/app\/polar\/setup\/catalog\?status=active&amp;kind=service"/);
    });

    it("item sheet: 760px with three tabs, unit chips with a live example, pinned footer, remove asks first", async () => {
      const state = await catalogState(db, acc.id);
      const sns = state.items.find((i) => i.sku === "SNS-200")!;
      const html = await cat({ item: sns.id });
      save("catalog-item", html);
      expect(html).toContain('class="sas-sp sas-sp--wide"');
      expect(html).toMatch(/<tr data-current="">/);
      expect(text(html)).toMatch(/SNS-200.*Active/);
      expect(html).toMatch(/<a class="sas-sp__tab"[^>]*aria-current="page"[^>]*>Details<\/a>/);
      expect(html).toContain(">In chat</a>");
      expect(html).toContain(">Prices and rules</a>");
      // Every tab is in the one form; only Details shows.
      expect(html).toMatch(/<div data-tab-pane="details">/);
      expect(html).toMatch(/<div hidden="" data-tab-pane="chat">/);
      expect(html).toMatch(/<div hidden="" data-tab-pane="prices">/);
      expect(html).toMatch(/<input type="radio" name="kind" checked="" value="product"/);
      expect(html).toMatch(/<input type="radio" name="unit" checked="" value="device"/);
      expect(text(html)).toContain('Shown on quotes as "2 devices".');
      expect(html).toMatch(/<input type="checkbox" role="switch" class="sas-switch" name="active" checked=""/);
      for (const f of ["name", "sku", "description", "availabilityNote", "plainName", "valueLine"]) expect(html).toContain(`name="${f}"`);
      expect(html).toMatch(/<footer class="sas-sp__foot"><button type="submit" form="ci-form" class="sas-btn sas-btn--primary">Save to draft<\/button>/);
      expect(text(html)).toContain("Changes go into catalog draft v2");
      expect(html).toContain(`confirm=${sns.id}`);
      expect(html).not.toContain('role="alertdialog"');
      const confirm = await cat({ item: sns.id, confirm: sns.id });
      expect(confirm).toContain('role="alertdialog"');
      expect(text(confirm)).toContain("Remove Wireless fridge sensor from the draft?");
    });

    it("sheet tabs: In chat and Prices and rules (one row per price list, the item's rules read only)", async () => {
      const state = await catalogState(db, acc.id);
      const gw = state.items.find((i) => i.sku === "GW-10")!;
      const html = await cat({ item: gw.id, tab: "prices" });
      save("catalog-item-prices", html);
      expect(html).toMatch(/<div data-tab-pane="prices">/);
      expect(html).toMatch(/<a class="sas-sp__tab"[^>]*aria-current="page"[^>]*>Prices and rules<\/a>/);
      const prices = html.split('data-item-prices=""')[1].split("</table>")[0];
      expect(text(prices)).toMatch(/Israel prices.*ILS · excl\. VAT.*₪660\.00.*₪90\.00\/month.*Edit/);
      expect(text(prices)).toMatch(/UK prices.*GBP · excl\. VAT.*Not priced.*Add price/);
      expect(prices).toContain(`/setup/price-lists/${uk}?sku=GW-10`);
      const rules = text(html.split('data-item-rules=""')[1].split("</ul>")[0]);
      expect(rules).toContain("When a quote has Site gateway (GW-10), add Installation (INST-1)");
      expect(rules).toContain("Wireless fridge sensor (SNS-200) needs one Site gateway (GW-10) per site.");
      const chat = await cat({ item: gw.id, tab: "chat" });
      save("catalog-item-chat", chat);
      expect(chat).toMatch(/<div data-tab-pane="chat">/);
      expect(chat).toContain('data-testid="how-it-sounds"');
      expect(text(chat)).toContain("of 60 characters");
      // A new item: Prices and rules says to save first.
      expect(text(await cat({ item: "new", tab: "prices" }))).toContain("Save the item first");
    });

    it("rule panel: Add rule opens an empty form; Edit opens it prefilled", async () => {
      const add = await cat({ panel: "rule" });
      save("catalog-rule-add", add);
      expect(add).toContain('id="rule-form"');
      expect(add).toMatch(/<button type="submit" form="rule-form"[^>]*>Add rule<\/button>/);
      expect(add).not.toContain('name="ruleId"');
      const state = await catalogState(db, acc.id);
      const auto = state.autoAdd[0];
      const edit = await cat({ panel: "rule", rule: auto.id });
      save("catalog-rule-edit", edit);
      expect(text(edit)).toContain("Edit rule");
      expect(edit).toContain(`name="ruleId" value="${auto.id}"`);
      expect(edit).toMatch(/name="whenAnyOf" checked="" value="GW-10"/);
      expect(edit).toMatch(/<input[^>]*name="removable" checked=""/);
      expect(edit).toMatch(/<option value="INST-1" selected="">/);
      // Remove asks first.
      const confirm = await cat({ confirm: `rule-${auto.id}` });
      expect(text(confirm)).toContain("Remove this rule?");
    });

    it("editing a rule changes it in place in the draft; another account's rule id is refused", async () => {
      const before = await catalogState(db, acc.id);
      const auto = before.autoAdd[0];
      const r = await run(catalogActions.addRuleAction(idle, form({ slug: acc.slug, ruleId: auto.id, kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10", "SNS-200"], qty: "one" })));
      expect(r).toEqual({ redirect: "/app/polar/setup/catalog" });
      const after = await catalogState(db, acc.id);
      expect(after.draft).not.toBeNull();
      expect(after.autoAdd).toHaveLength(1);
      expect(after.rules).toHaveLength(1);
      expect(after.autoAdd[0].rule).toEqual({ kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10", "SNS-200"], qty: "one", removable: false });
      // The published version is untouched.
      const [pub] = await db.select().from(catalogVersions).where(and(eq(catalogVersions.accountId, acc.id), eq(catalogVersions.status, "published")));
      expect(pub).toBeTruthy();
      const otherRule = (await catalogState(db, other.id)).rules[0];
      expect(await run(catalogActions.addRuleAction(idle, form({ slug: acc.slug, ruleId: otherRule.id, kind: "advice", text: "Hijack" })))).toEqual({ status: "error" });
      expect(await run(catalogActions.addRuleAction(idle, form({ slug: acc.slug, ruleId: "not-a-uuid", kind: "advice", text: "x" })))).toEqual({ status: "error" });
      expect((await catalogState(db, other.id)).rules[0].rule).toEqual({ kind: "advice", text: "Other advice" });
      // With a draft, the header offers Publish v2 and Discard draft.
      const html = await cat();
      expect(text(html)).toContain("Publish v2");
      expect(text(html)).toContain("Discard draft");
      expect(text(html)).toMatch(/Draft v2 · \d+ changes?/);
    });
  });

  describe("Price lists", () => {
    it("list table: currency in words, VAT, used by, items priced, status with version, row actions", async () => {
      const html = await lists();
      save("price-lists", html);
      const rows = tableRows(html);
      const il = rows.find((r) => r.startsWith("Israel prices"))!;
      expect(il).toMatch(/ILSIsraeli shekel.*18%Prices without VAT.*Israel.*4 of 5.*Live.*v1 · draft v2/);
      const gb = rows.find((r) => r.startsWith("UK prices"))!;
      expect(gb).toMatch(/GBPBritish pound.*20%Prices without VAT.*No market yet.*1 of 5.*Draft.*v1/);
      expect(html).toContain('data-priced="incomplete"');
      expect(html).toContain(`/setup/price-lists?copy=${israel}`);
      expect(html).toContain(`/setup/price-lists?rename=${uk}`);
      expect(html).toContain(`/setup/price-lists?confirm=${uk}`);
      expect(text(html)).toContain("New price list");
      expect(text(html)).toContain("Each market sells from one price list.");
      expect(tableRows(await lists({ status: "live" }))).toHaveLength(1);
      expect(tableRows(await lists({ q: "gbp" }))[0]).toMatch(/^UK prices/);
      expect(tableRows(await lists({ sort: "priced", dir: "asc" }))[0]).toMatch(/^UK prices/);
    });

    it("panels: Copy and adjust from a row, New price list, Rename; delete asks first", async () => {
      const copy = await lists({ copy: uk });
      expect(copy).toContain('class="sas-sp"');
      expect(copy).toMatch(/<option value="GBP" selected="">GBP · British pound \(£\)<\/option>/);
      expect(await lists({ new: "1" })).toContain("Create price list");
      const rename = await lists({ rename: uk });
      save("price-lists-rename", rename);
      expect(rename).toMatch(/id="pl-rename-name"[^>]*value="UK prices"/);
      expect(rename).toMatch(/<button type="submit" form="pl-rename"/);
      const confirm = await lists({ confirm: israel });
      save("price-lists-confirm", confirm);
      expect(text(confirm)).toContain("Delete Israel prices?");
      expect(text(confirm)).toContain("Israel sells from this list. Choose another price list for that market first.");
    });

    it("rename goes into the draft; delete is refused while a market uses the list or quotes were priced from it", async () => {
      expect(await run(plActions.renamePriceListAction(idle, form({ slug: acc.slug, lineageId: uk, name: "  " })))).toMatchObject({ status: "error" });
      expect(await run(plActions.renamePriceListAction(idle, form({ slug: acc.slug, lineageId: uk, name: "UK 2027" })))).toEqual({ redirect: `/app/polar/setup/price-lists?renamed=${uk}` });
      expect((await priceListVersions(db, acc.id, uk))[0].name).toBe("UK 2027");
      // A list that was never published: the plain message.
      expect(text(await lists({ renamed: uk }))).toContain("Name saved to the draft. Publish the price list to use it.");
      // In use by the home market.
      expect(await run(plActions.deletePriceListAction(form({ slug: acc.slug, lineageId: israel })))).toEqual({ redirect: `/app/polar/setup/price-lists?delete=in_use&list=${israel}` });
      const inUse = await lists({ delete: "in_use", list: israel });
      expect(text(inUse)).toContain("Can't delete Israel prices. Israel sells from this list. Choose another price list for that market first. Open Markets");
      expect(inUse).toMatch(/href="\/app\/polar\/markets\?m=[0-9a-f-]{36}">Open Markets</);
      // Quoted: a quote version priced from it.
      const q = await createPriceList(db, { userId: admin.id, actingAs: false }, acc.id, { name: "Quoted", currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800 });
      if (!q.ok) throw new Error(q.error);
      const [lead] = await db.insert(leads).values({ accountId: acc.id, fullName: "Lead", phone: "+972525550001", language: "en", origin: "manual" }).returning();
      const quoteId = randomUUID();
      const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, acc.id));
      await db.insert(quotes).values({ id: quoteId, accountId: acc.id, leadId: lead.id, number: 1001, status: "sent" });
      await db.insert(quoteVersions).values({
        id: randomUUID(), accountId: acc.id, quoteId, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800,
        oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0, recurringSubtotalMinor: 0, recurringDiscountMinor: 0,
        recurringTaxMinor: 0, recurringTotalMinor: 0, validUntil: new Date(Date.now() + 86_400_000), createdByActor: "agent", priceListId: q.list.id,
      });
      expect(await run(plActions.deletePriceListAction(form({ slug: acc.slug, lineageId: q.list.lineageId })))).toEqual({ redirect: `/app/polar/setup/price-lists?delete=quoted&list=${q.list.lineageId}` });
      expect(text(await lists({ delete: "quoted", list: q.list.lineageId }))).toContain("Can't delete Quoted. Quotes were priced from this list, so it can't be deleted.");
      // Another account cannot delete it; an unused list goes with every version.
      as(other);
      expect(await run(plActions.deletePriceListAction(form({ slug: other.slug, lineageId: uk })))).toEqual({ redirect: "/app/other/setup/price-lists" });
      as(acc);
      // Renaming a live list: the new name is in draft vN and needs Publish, with a link to the list.
      expect(await run(plActions.renamePriceListAction(idle, form({ slug: acc.slug, lineageId: israel, name: "Israel 2027" })))).toEqual({ redirect: `/app/polar/setup/price-lists?renamed=${israel}` });
      const israelDraft = (await priceListVersions(db, acc.id, israel)).find((v) => v.status === "draft")!;
      const renamedLive = await lists({ renamed: israel });
      expect(text(renamedLive)).toContain(`The new name "Israel 2027" is in draft v${israelDraft.version}. Publish the price list to use it. Open to publish`);
      expect(renamedLive).toContain(`href="/app/polar/setup/price-lists/${israel}">Open to publish</a>`);
      await run(plActions.renamePriceListAction(idle, form({ slug: acc.slug, lineageId: israel, name: "Israel prices" })));
      expect(await priceListVersions(db, acc.id, uk)).toHaveLength(1);
      expect(await run(plActions.deletePriceListAction(form({ slug: acc.slug, lineageId: uk })))).toEqual({ redirect: "/app/polar/setup/price-lists?deleted=1" });
      expect(await priceListVersions(db, acc.id, uk)).toHaveLength(0);
      expect((await listPriceLists(db, acc.id)).map((l) => l.shown.name)).toEqual(["Israel prices", "Quoted"]);
    });

    it("detail: summary strip, prices table with chips, tier chip and one action per row, versions card", async () => {
      const html = await detail(israel);
      save("price-list", html);
      const tx = text(html);
      expect(tx).toContain("4 of 5 items priced · 1 missing");
      const strip = text(html.split('class="sas-summary"')[1].split("</section>")[0]);
      expect(strip).toContain("CurrencyILS · Israeli shekel (₪)");
      expect(strip).toContain("VATPrices without VAT · 18%");
      expect(strip).toContain("Used byIsrael");
      expect(strip).toContain("Valid fromNot set");
      expect(strip).toContain("Edit settings");
      expect(html).toContain(`/setup/price-lists/${israel}?panel=settings`);
      // The settings form is no longer on the page.
      expect(html).not.toContain('id="pl-meta-name"');
      expect(tx).toMatch(/All5Missing price1With tiers1Recurring1/);
      const rows = tableRows(html);
      expect(rows.find((r) => r.startsWith("Wireless"))).toMatch(/SNS-200.*Product · per device.*₪590\.00.*Not charged.*From 10: ₪550\.00.*Edit/);
      expect(rows.find((r) => r.startsWith("Cold room probe"))).toMatch(/Price missing.*Add price$/);
      expect(rows.find((r) => r.startsWith("Installation"))).toBeDefined();
      expect(html).toContain(`/setup/price-lists/${israel}?sku=CRP-40`);
      // Versions: the draft with Publish and Discard, the live one with its date.
      const versions = text(html.split('id="hist-h"')[1].split("</section>")[0]);
      expect(versions).toMatch(/v2Draft.*Started .*Publish v2Discard draft/);
      expect(versions).toMatch(/v1Live.*Published /);
      expect(tx).toContain("Copy and adjust");
      expect(tableRows(await detail(israel, { show: "missing" }))).toHaveLength(1);
      expect(tableRows(await detail(israel, { show: "tiers" }))).toHaveLength(1);
      expect(tableRows(await detail(israel, { q: "gateway" }))[0]).toMatch(/^Site gateway/);
      expect(tableRows(await detail(israel, { sort: "one_time", dir: "desc" }))[0]).toMatch(/^Site gateway/);
    });

    it("detail panels: Edit settings (with the date field) and the unchanged price panel", async () => {
      const settings = await detail(israel, { panel: "settings" });
      save("price-list-settings", settings);
      expect(settings).toContain('class="sas-sp"');
      expect(settings).toContain('id="pl-meta-name"');
      expect(settings).toContain('id="pl-meta-from"');
      expect(settings).toContain('name="pricesIncludeTax"');
      const entry = await detail(israel, { sku: "CRP-40" });
      save("price-list-entry", entry);
      expect(entry).toContain("Sold in this price list");
      expect(entry).toContain('id="pe-ot"');
      expect(entry).toContain('id="rc-block"');
      expect(entry).toContain("Custom pricing");
      expect(entry).toContain("This item in your other price lists");
      expect(entry).toMatch(/<tr data-current="">/);
    });
  });
});
