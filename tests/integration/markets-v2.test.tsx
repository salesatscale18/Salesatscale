/**
 * Settings › Markets, MarketsV2 layout (UX board, 24 Nov), rendered on PGlite:
 * the header's differ line, "Different here" + Reset + Change on rows that differ,
 * only Change on rows that follow the account, account-wide rows, the readiness
 * strip with fix links, the price list row and its picker (saved through the
 * existing action), and the markets list's second line. Layout only: what a
 * market stores and checks is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { markets, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
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
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { overrideSettingAction, setPriceListAction } = await import("@/app/app/[account]/markets/actions");
const { createMarket, ensureHomeMarket } = await import("@/lib/markets/service");
const { getOrderFormSettings, saveLegalSection, saveOrderFormSettings } = await import("@/lib/orders/settings");
const { saveMarketLegalSection } = await import("@/lib/markets/legal");
const { createPriceList, listPriceLists } = await import("@/lib/pricing/price-lists");
const { setMarketPriceList } = await import("@/lib/markets/service");

const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const run = async <T,>(p: Promise<T>) => {
  try { return await p; } catch (e) { if (!(e as { url?: string }).url) throw e; return { redirect: (e as { url: string }).url }; }
};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
/** The HTML of one setting row (up to the next setting). */
const rowOf = (html: string, key: string) => html.split(`data-setting="${key}"`)[1]?.split("data-setting=")[0] ?? "";
/** The action group of a row. */
const actOf = (row: string) => row.split('data-row-end="">')[1]?.split("</span></div>")[0] ?? "";
const checkOf = (html: string, key: string) => html.match(new RegExp(`<li[^>]*data-check="${key}"[\\s\\S]*?</li>`))?.[0] ?? "";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("Settings › Markets (MarketsV2)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let homeId = "";
  let ukId = "";
  const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await MarketsPage(props(acc.slug, sp)));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "o@polar.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    homeId = (await ensureHomeMarket(db, acc.id))!.id;
    await seedCatalog(db, acc.id, [{ sku: "KIT-1", name: "Starter kit", unit: "device" }]);
    // The home market: a live price list, legal texts in both languages, bank details for bank transfer.
    await seedPricing(db, acc.id, [{ sku: "KIT-1", oneTime: 100_000 }], { userId: me.id, name: "Israel prices" });
    const of = await getOrderFormSettings(db, acc.id);
    await saveOrderFormSettings(db, acc.id, { fields: of.fields, card: true, bankTransfer: true, bankDetails: "Test Bank · 800 · 123456", linkValidDays: 7 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language, body: "Terms" });
    const r = await createMarket(db, { userId: me.id, actingAs: false }, acc.id, { name: "United Kingdom", countries: ["GB"], phonePrefixes: ["+44"] });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    ukId = r.market.id;
  });
  afterAll(async () => t.close());

  it("a market that follows the account: the 'follows' sub line, no tags, only Change on its rows, no 'Same as account' tag", async () => {
    const html = await page({ m: homeId });
    expect(html).toContain('data-differ-count="0"');
    expect(text(html)).toContain("Follows your account defaults in everything. Change only what is different in this market.");
    expect(html).not.toContain("Different here");
    expect(html).not.toContain("Same as account default");
    for (const k of ["languages", "timezone", "contactHours", "paymentMethods", "bankDetails", "leadTime"]) {
      const act = actOf(rowOf(html, k));
      expect(act, k).toMatch(/^<a class="mk-act" href="[^"]*override=[a-zA-Z]+#set-[a-zA-Z]+" data-edit-setting="[a-zA-Z]+">Change<\/a>$/);
      expect(act, k).not.toContain("Reset");
    }
    // The legal texts follow the account: Change (to the order form), no tag.
    const legal = rowOf(html, "legal");
    expect(legal).toContain("Order form texts");
    expect(legal).not.toContain("Different here");
    expect(actOf(legal)).toMatch(/order-form\?market=[^"]*" data-row-action="" data-legal-action="">Change<\/a>$/);
  });

  it("rows that differ: Different here after the value, then Reset and Change; the sub line counts them", async () => {
    // createMarket gave the UK its own time zone; add its own languages through the existing action.
    await run(overrideSettingAction(form({ slug: acc.slug, marketId: ukId, key: "languages", languages: "en" })));
    const html = await page({ m: ukId });
    expect(html).toContain('data-differ-count="2"');
    expect(text(html)).toContain("Different from your account: 2.");
    expect(text(html)).not.toContain("Follows your account defaults in everything");
    for (const k of ["languages", "timezone"]) {
      const row = rowOf(html, k);
      // Two actions: in a narrow card (about 1280 wide) they drop under the value.
      expect(row, k).toContain('class="mk-row mk-row--two"');
      // "Different here" under the label; the value column holds only the value.
      expect(row, k).toMatch(/<span class="mk-row__label">[^<]+<span class="mk-row__tag"><span class="mk-diff" data-source="market">Different here<\/span><\/span><\/span><span class="mk-row__value"><span>/);
      expect(row.split('class="mk-row__value"')[1], k).not.toContain("Different here");
      expect(actOf(row), k).toMatch(new RegExp(`^<form[^>]*>.*<button type="submit" class="mk-act" data-reset-setting="${k}">Reset</button></form><a class="mk-act" [^>]*data-edit-setting="${k}">Change</a>$`));
    }
    // An inheriting row on the same market: only Change, kept beside the value.
    expect(rowOf(html, "paymentMethods")).toContain('class="mk-row"');
    expect(rowOf(html, "paymentMethods")).not.toContain("Different here");
    expect(actOf(rowOf(html, "paymentMethods"))).not.toContain("Reset");
    // A market's own legal text also differs: tagged and counted.
    await saveMarketLegalSection(db, { userId: me.id, actingAs: false }, acc.id, ukId, { sectionKey: "sales_terms", title: "UK terms", language: "en", body: "UK" });
    const withLegal = await page({ m: ukId });
    expect(withLegal).toContain('data-differ-count="3"');
    expect(rowOf(withLegal, "legal")).toContain(">Different here<");
    expect(actOf(rowOf(withLegal, "legal"))).not.toContain("Reset");
  });

  it("account-wide rows: currency says Account-wide in place of an action; from a price list in another currency it says so", async () => {
    const html = await page({ m: homeId });
    const cur = rowOf(html, "currency");
    expect(cur).toContain("ILS · Israeli shekel (₪)");
    expect(actOf(cur)).toBe('<span class="mk-row__note" data-account-wide="">Account-wide</span>');
    expect(cur).not.toContain("mk-act");
    // Holidays have no account default: no tag and no Reset, "Add dates" without dates.
    expect(rowOf(html, "holidays")).not.toContain("Different here");
    expect(actOf(rowOf(html, "holidays"))).toMatch(/>Add dates<\/a>$/);
  });

  it("readiness strip: a passing market shows 'Ready to sell · 4 of 4' and short ticks; a failing one shows the check in warning tone with its fix link", async () => {
    const home = await page({ m: homeId });
    expect(text(home)).toContain("Ready to sell · 4 of 4");
    expect(home).toContain('data-ready="yes"');
    for (const [k, label] of [["where", "Leads can reach it"], ["price_list", "Price list is live"], ["legal_texts", "Legal texts in every language"], ["payment_methods", "A payment method"]]) {
      const li = checkOf(home, k);
      expect(li, k).toContain('data-check-icon="pass"');
      expect(li, k).toContain(`<span>${label}</span>`);
      expect(li, k).not.toContain("data-check-fix");
    }
    const wa = checkOf(home, "whatsapp");
    expect(wa).toContain('data-check-icon="optional"');
    expect(wa).toContain("WhatsApp number · optional");
    expect(wa).toContain("settings?section=whatsapp");
    // The long go-live list at the bottom is gone (the same checks are in the strip).
    expect(home).not.toContain(">Go-live checks<");
    expect(home.match(/data-check="/g)?.length).toBe(5);

    // The UK has no price list: its check fails, in warning tone, with the fix link to the picker.
    const uk = await page({ m: ukId });
    expect(uk).toContain('data-ready="no"');
    expect(text(uk)).toMatch(/Ready to sell · [0-3] of 4/);
    const pl = checkOf(uk, "price_list");
    expect(pl).toContain('class="mk-ck mk-ck--fail"');
    expect(pl).toContain('data-check-icon="fail"');
    // No positive label on a failing check: what is wrong, then the fix link.
    expect(pl).not.toContain("Price list is live");
    expect(pl).toMatch(/<span>No price list<\/span>.*<span aria-hidden="true">·<\/span><a class="mk-act" href="[^"]*\?m=[^"]*&amp;edit=price_list#set-price_list" data-check-fix="price_list" title="Choose a price list\.">Choose one<\/a>/);
    // Go live stays disabled while a check fails.
    expect(uk.match(/<button[^>]*value="live"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(home.match(/<button[^>]*value="live"[^>]*>/)?.[0]).not.toContain("disabled");
  });

  it("price list: a normal row with Change; Change opens the picker, which saves through the existing action", async () => {
    let html = await page({ m: ukId });
    const row = rowOf(html, "price_list");
    expect(row).toContain("No price list yet");
    expect(actOf(row)).toMatch(/<a class="mk-act" href="[^"]*edit=price_list#set-price_list" data-edit-setting="price_list">Change<\/a>$/);
    // No always-open select with its own Save button.
    expect(html).not.toContain('name="lineageId"');
    expect(html).not.toContain("Save price list");

    const picker = await page({ m: ukId, edit: "price_list" });
    const pick = rowOf(picker, "price_list");
    expect(pick).toMatch(/<form[^>]*data-price-list-form=""/);
    expect(pick).toMatch(/<select class="sas-select" id="mk-pl" name="lineageId">/);
    expect(pick).toContain(">Price lists</a>");
    expect(actOf(pick)).not.toContain(">Change<");

    const [list] = await listPriceLists(db, acc.id);
    const r = await run(setPriceListAction(form({ slug: acc.slug, marketId: ukId, lineageId: list.lineageId })));
    expect((r as { redirect: string }).redirect).toContain("saved=price_list");
    const [m] = await db.select().from(markets).where(eq(markets.id, ukId));
    expect(m.priceListLineageId).toBe(list.lineageId);
    html = await page({ m: ukId });
    expect(text(rowOf(html, "price_list"))).toContain("Israel prices · ILS · live v1");
    expect(checkOf(html, "price_list")).toContain('data-check-icon="pass"');
  });

  it("markets list: name + status, then 'Home market · n leads' / 'n leads · x of 4 checks'; a picker for phones", async () => {
    // A new market without a price list fails some checks; the UK now passes all four (it has a live price list).
    const de = await createMarket(db, { userId: me.id, actingAs: false }, acc.id, { name: "Germany", countries: ["DE"], phonePrefixes: ["+49"] });
    if (!de.ok) throw new Error(JSON.stringify(de.errors));
    const html = await page({ m: homeId });
    const line = (id: string) => text(html.split(`data-market-row="${id}"`)[1].split("</li>")[0]);
    expect(line(homeId)).toMatch(/IsraelSetting upHome market · 0 leads$/);
    expect(line(de.market.id)).toMatch(/GermanySetting up0 leads · [0-3] of 4 checks$/);
    expect(line(ukId)).toMatch(/United KingdomSetting up0 leads$/);
    expect(html.split(`data-market-row="${ukId}"`)[1].split("</li>")[0]).toContain('data-status="market.setting_up"');
    // Phone: the same markets in a picker.
    expect(html.match(/<form[^>]*data-market-picker=""[^>]*>/)?.[0]).toMatch(/action="\/app\/polar\/markets" method="get"/);
    expect(html).toContain(`<option value="${ukId}">United Kingdom · Setting up</option>`);
    // Never a full email for a person on this page.
    expect(html).not.toContain("o@polar.test");
  });

  it("about 1280 wide: two columns stay (narrower list and label), they stack only under 640px; squeezed rows drop their actions", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/app/[account]/markets/markets.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 1379px\) \{ \.mk-list \{ width: 200px; \} \}/);
    expect(css).toMatch(/@container mkdetail \(max-width: 639px\) \{ \.mk-cols \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
    expect(css).toMatch(/@container mkdetail \(max-width: 820px\) \{ \.mk-row \{ --mk-label: 112px; \} \}/);
    expect(css).toMatch(/@container mkcard \(max-width: 420px\) \{\s*\.mk-row--two \{ grid-template-columns: var\(--mk-label\) minmax\(0, 1fr\); \}\s*\.mk-row--two \.mk-row__act \{ grid-column: 2; \}/);
    // No unnamed container queries: each one names the box it measures.
    expect(css).not.toMatch(/@container \(/);
  });

  it("polish (25 Nov): a failing check says what is wrong, then its fix link; passing checks keep their labels", async () => {
    const actor = { userId: me.id, actingAs: false };
    /** The failing check's visible words: "Label · Fix". */
    const failLine = (html: string, key: string) => {
      const li = checkOf(html, key);
      expect(li, key).toContain('class="mk-ck mk-ck--fail"');
      return text(li.replace(/<span class="sas-sr">[^<]*<\/span>/, "")).replace(/·/g, " · ").replace(/\s+/g, " ").trim();
    };
    const mk = async (name: string, input: Record<string, string[]>) => {
      const r = await createMarket(db, actor, acc.id, { name, ...input });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r.market.id;
    };
    // No routing at all: nobody reaches it.
    const nowhere = await mk("Nowhere", { countries: [] });
    let html = await page({ m: nowhere });
    expect(failLine(html, "where")).toBe("No leads can reach it · Set where");
    expect(checkOf(html, "where")).toMatch(/href="[^"]*&amp;edit=where#where" data-check-fix="where"/);
    // No price list assigned.
    expect(failLine(html, "price_list")).toBe("No price list · Choose one");
    expect(html).not.toMatch(/mk-ck--fail[^]*?<span>(Leads can reach it|Price list is live)<\/span>/);

    // A phone prefix but no countries: the more specific reason.
    const noCountries = await mk("Prefix only", { countries: [], phonePrefixes: ["+33"] });
    html = await page({ m: noCountries });
    expect(failLine(html, "where")).toBe("No countries yet · Add countries");

    // A price list assigned but not live (a draft).
    const draft = await createPriceList(db, actor, acc.id, { name: "Draft list", currency: "EUR", pricesIncludeTax: true, taxRateBp: 2000 });
    if (!draft.ok) throw new Error(draft.error);
    await setMarketPriceList(db, actor, acc.id, noCountries, draft.list.lineageId);
    html = await page({ m: noCountries });
    expect(failLine(html, "price_list")).toBe("Price list not live · Publish the price list");
    expect(checkOf(html, "price_list")).toMatch(/href="\/app\/polar\/setup\/price-lists" data-check-fix="price_list"/);

    // Legal texts missing in Hebrew for this market (its Hebrew text removed).
    await saveMarketLegalSection(db, actor, acc.id, noCountries, { sectionKey: "sales_terms", title: "Sales terms", language: "he", body: "", active: false });
    html = await page({ m: noCountries });
    expect(failLine(html, "legal_texts")).toBe("Legal texts missing in Hebrew · Add texts");
    expect(checkOf(html, "legal_texts")).toMatch(/order-form\?market=[^"]*" data-check-fix="legal_texts"/);

    // Bank transfer without bank details.
    await db.update(markets).set({ overrides: { bankDetails: null } }).where(eq(markets.id, noCountries));
    html = await page({ m: noCountries });
    expect(failLine(html, "payment_methods")).toBe("No bank details for bank transfer · Add them");
    expect(checkOf(html, "payment_methods")).toMatch(/override=bankDetails#set-bankDetails" data-check-fix="payment_methods"/);

    // No payment method at all (the account's order form has none turned on).
    const of = await getOrderFormSettings(db, acc.id);
    await saveOrderFormSettings(db, acc.id, { fields: of.fields, card: false, bankTransfer: false, bankDetails: of.bankDetails, linkValidDays: 7 });
    try {
      html = await page({ m: nowhere });
      expect(failLine(html, "payment_methods")).toBe("No payment method · Add one");
      expect(checkOf(html, "payment_methods")).toMatch(/override=paymentMethods#set-paymentMethods" data-check-fix="payment_methods"/);
    } finally {
      await saveOrderFormSettings(db, acc.id, { fields: of.fields, card: of.card, bankTransfer: of.bankTransfer, bankDetails: of.bankDetails, linkValidDays: 7 });
    }
  });

  it("polish (25 Nov): the time zone row drops the IANA name (the editor keeps it); contact hours break per group", async () => {
    let html = await page({ m: ukId });
    const tz = text(rowOf(html, "timezone"));
    expect(tz).toMatch(/United Kingdom time \(GMT[+-]\d\)/);
    expect(tz).not.toContain("Europe/London");
    const editor = await page({ m: ukId, override: "timezone" });
    expect(editor).toMatch(/<option value="Europe\/London" selected="">United Kingdom time · Europe\/London \(GMT[+-]\d\)<\/option>/);

    // Mon–Thu / Fri / Sat–Sun: three groups, each unbreakable; the separator is its own element the CSS hides when stacked.
    await run(overrideSettingAction(form({
      slug: acc.slug, marketId: ukId, key: "contactHours",
      mon_on: "on", mon_from: "09:00", mon_to: "17:30", tue_on: "on", tue_from: "09:00", tue_to: "17:30",
      wed_on: "on", wed_from: "09:00", wed_to: "17:30", thu_on: "on", thu_from: "09:00", thu_to: "17:30",
      fri_on: "on", fri_from: "09:00", fri_to: "16:00", sat_from: "09:00", sat_to: "13:00", sun_from: "09:00", sun_to: "13:00",
    })));
    html = await page({ m: ukId });
    const hours = rowOf(html, "contactHours");
    expect(hours).toContain(
      '<span class="mk-hours" data-fits="400"><span class="mk-hours__g"><span class="sas-nowrap">Mon–Thu 09:00–17:30</span></span>'
      + '<span class="mk-hours__g"><span class="mk-hours__sep"> · </span><span class="sas-nowrap">Fri 09:00–16:00</span></span>'
      + '<span class="mk-hours__g"><span class="mk-hours__sep"> · </span><span class="sas-nowrap">Sat–Sun off</span></span></span>',
    );
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/app/[account]/markets/markets.css", "utf8");
    expect(css).toContain(".mk-row__value { container: mkvalue / inline-size; }");
    expect(css).toContain('@container mkvalue (max-width: 399px) { .mk-hours[data-fits="400"] .mk-hours__g { display: block; } .mk-hours[data-fits="400"] .mk-hours__sep { display: none; } }');
    expect(css).toContain(".mk-row__tag { display: block; margin-block-start: 4px; }");
  });
});
