/** Settings › Markets round-3 fixes (R3-7), rendered on PGlite: Edit next to Reset, the holidays row and form, and the price list line. */
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
const { overrideSettingAction } = await import("@/app/app/[account]/markets/actions");
const { createMarket, setMarketPriceList } = await import("@/lib/markets/service");
const { listPriceLists } = await import("@/lib/pricing/price-lists");

const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const run = async <T,>(p: Promise<T>) => {
  try { return await p; } catch (e) { if (!(e as { url?: string }).url) throw e; return { redirect: (e as { url: string }).url }; }
};
/** The HTML of one setting row (up to the next setting). */
const rowOf = (html: string, key: string) => html.split(`data-setting="${key}"`)[1]?.split("data-setting=")[0] ?? "";

describe("Settings › Markets (R3-7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let marketId = "";

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
    await seedCatalog(db, acc.id, [{ sku: "KIT-1", name: "Starter kit", unit: "device" }]);
    const r = await createMarket(db, { userId: me.id, actingAs: false }, acc.id, { name: "United Kingdom", countries: ["GB"], phonePrefixes: ["+44"] });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    marketId = r.market.id;
  });
  afterAll(async () => t.close());

  it("a setting set for the market shows Different here, Reset and Change; Change opens the same form prefilled", async () => {
    // createMarket gave the UK market its own time zone.
    const html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId })));
    const tz = rowOf(html, "timezone");
    expect(tz).toContain(">Different here<");
    expect(tz).toMatch(/>Reset<\/button>[^]*<a [^>]*href="[^"]*override=timezone#set-timezone"[^>]*data-edit-setting="timezone"[^>]*>Change<\/a>/);
    expect(html).toContain("Different from your account: 1.");
    expect(html).toContain("Change only what is different there.");
    expect(html.toLowerCase()).not.toContain("overrid".concat("den<"));
    // A row that follows the account offers only "Change".
    expect(rowOf(html, "languages")).toMatch(/>Change<\/a>/);
    expect(rowOf(html, "languages")).not.toContain("Different here");

    const editing = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId, override: "timezone" })));
    expect(editing).toMatch(/data-override-form="timezone"[^]*<option value="Europe\/London" selected="">/);
    expect(editing).toMatch(/data-override-form="timezone"[^]*>Save<\/button>/);
    // While the form is open, Change is not shown again; Reset stays.
    expect(rowOf(editing, "timezone")).not.toContain(">Change<");
    expect(rowOf(editing, "timezone")).toContain(">Reset<");
  });

  it("holidays: None + Add dates without dates (no account default); count, next date and Edit with dates; no Reset", async () => {
    let html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId })));
    let row = rowOf(html, "holidays");
    expect(row).toContain(">None<");
    expect(row).toContain(">Add dates<");
    expect(row).not.toContain("Same as account default");
    expect(row).not.toContain(">Reset<");

    // The form: a date field with Add date, and the list (empty).
    const form = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId, override: "holidays" })));
    expect(form).toMatch(/data-override-form="holidays"[^]*data-date-field="holidays"[^]*>Add date<[^]*No dates yet\.[^]*>Save<\/button>/);
    expect(form).not.toContain("<textarea");

    // Saving dates through the action (one value per date), then all removed.
    const save = (dates: string[]) => {
      const f = new FormData();
      f.set("slug", acc.slug); f.set("marketId", marketId); f.set("key", "holidays");
      for (const d of dates) f.append("holidays", d);
      return run(overrideSettingAction(f));
    };
    const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await save([future(40), future(10), "2020-01-01", ""]);
    const [m] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(m.overrides.holidays).toEqual(["2020-01-01", future(10), future(40)]);
    html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId })));
    row = rowOf(html, "holidays");
    const next = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${future(10)}T12:00:00Z`));
    expect(row).toContain(`3 dates · next ${next}`);
    expect(row).toContain(">Edit<");
    expect(row).not.toContain(">Reset<");
    const editForm = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId, override: "holidays" })));
    expect(editForm).toContain(`data-holiday="${future(10)}"`);
    expect(editForm).toMatch(new RegExp(`aria-label="Remove ${next}"`));

    await save([""]);
    const [cleared] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect("holidays" in cleared.overrides).toBe(false);
    expect(rowOf(renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId }))), "holidays")).toContain(">None<");
  });

  it("the line under the price list shows only when it says more than the value; the Price lists link stays in the picker", async () => {
    let html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId })));
    expect(html).toMatch(/data-price-list-note="none"[^>]*>Without a price list this market can&#x27;t quote\.</);
    await seedPricing(db, acc.id, [{ sku: "KIT-1", oneTime: 100_000 }], { userId: me.id });
    const [list] = await listPriceLists(db, acc.id);
    await setMarketPriceList(db, { userId: me.id, actingAs: false }, acc.id, marketId, list.lineageId);
    html = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId })));
    expect(html).not.toContain("data-price-list-note");
    expect(html).not.toContain("Selling from");
    const picker = renderToStaticMarkup(await MarketsPage(props(acc.slug, { m: marketId, edit: "price_list" })));
    expect(picker).toMatch(/data-price-list-form=""[^]*data-price-list-link=""><a [^>]*>Price lists<\/a>/);
  });
});
