import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, markets, priceLists, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";

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
}));

const actions = await import("@/app/app/[account]/setup/price-lists/actions");
const { saveItemAction, publishAction: publishCatalogAction } = await import("@/app/app/[account]/setup/catalog/actions");
const { entriesOf, listPriceLists, livePriceList, priceListVersions } = await import("@/lib/pricing/price-lists");
const { setupProgress } = await import("@/lib/overview/setup");
const { createMarket } = await import("@/lib/markets/service");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const idle = { status: "idle" as const };
/** Runs an action; a redirect comes back as `{ redirect: url }`. */
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};

describe("price list screens", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: SellerAccount, accB: SellerAccount;
  let ilsList = "";
  const as = (account: SellerAccount, actingAs = false) => { holder.access = { account, user: admin, actingAs, role: actingAs ? "platform_admin" : "seller_admin" }; };
  const lineageFrom = (r: unknown) => /price-lists\/([0-9a-f-]{36})/.exec((r as { redirect: string }).redirect)![1];
  const entry = (lineageId: string, v: Record<string, string>) => run(actions.saveEntryAction(idle, form({ slug: "alpha", lineageId, sold: "yes", ...v })));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    };
    accA = await mk("Alpha");
    accB = await mk("Beta");
    as(accA);
    for (const [sku, name, kind, unit] of [["SNS-200", "Wireless sensor", "product", "device"], ["GW-10", "Site gateway", "product", "device"], ["PLAN-M", "Monitoring", "service", "site"], ["SVC-INST", "Installation", "service", "site"]]) {
      await run(saveItemAction(idle, form({ slug: "alpha", sku, name, kind, unit, active: "on" })));
    }
    await run(publishCatalogAction(form({ slug: "alpha" })));
  });
  afterAll(async () => t.close());

  it("creates the first price list and gives it to the home market", async () => {
    expect((await setupProgress(db, accA)).has("prices")).toBe(false);
    expect(await run(actions.createPriceListAction(idle, form({ slug: "alpha", name: "", currency: "ILS", taxRate: "18" })))).toMatchObject({ status: "error", errors: { name: expect.any(String) } });
    const r = await run(actions.createPriceListAction(idle, form({ slug: "alpha", name: "Israel 2026", currency: "ILS", pricesIncludeTax: "on", taxRate: "18", validFrom: "" })));
    ilsList = lineageFrom(r);
    expect(r).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?created=1` });
    const [home] = await db.select().from(markets).where(and(eq(markets.accountId, accA.id), eq(markets.isHome, true)));
    expect(home.priceListLineageId).toBe(ilsList);
    expect((await listPriceLists(db, accA.id))[0]).toMatchObject({ shown: { name: "Israel 2026", currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800, status: "draft" }, usedBy: [{ id: home.id }] });
    // Draft only: prices are not done yet.
    expect((await setupProgress(db, accA)).has("prices")).toBe(false);
  });

  it("a second price list does not take over the home market", async () => {
    const r = await run(actions.createPriceListAction(idle, form({ slug: "alpha", name: "Spare", currency: "USD", taxRate: "0" })));
    const spare = lineageFrom(r);
    const [home] = await db.select().from(markets).where(and(eq(markets.accountId, accA.id), eq(markets.isHome, true)));
    expect(home.priceListLineageId).toBe(ilsList);
    expect((await listPriceLists(db, accA.id)).find((l) => l.lineageId === spare)?.usedBy).toEqual([]);
  });

  it("edits entries: sold here, one-time, recurring with period and tiers, custom pricing", async () => {
    expect(await entry(ilsList, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "590", oneTimeTiers: "10: 550", recurringCharged: "on", recurringPrice: "12.5", recurringPeriod: "year", customPricingFromQty: "50" })).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?saved=1` });
    await entry(ilsList, { sku: "GW-10", oneTimeCharged: "on", oneTimePrice: "660" });
    await entry(ilsList, { sku: "PLAN-M", recurringCharged: "on", recurringPrice: "90" });
    await entry(ilsList, { sku: "SVC-INST", oneTimeCharged: "on", oneTimePrice: "" });
    expect(await entry(ilsList, { sku: "GW-10", oneTimeCharged: "on", oneTimePrice: "6.605" })).toMatchObject({ status: "error", errors: { oneTimePrice: expect.any(String) } });
    expect(await entry(ilsList, { sku: "NOT-IN-CATALOG", oneTimeCharged: "on", oneTimePrice: "1" })).toMatchObject({ status: "error", formError: "This item is not in the catalog." });

    const draft = (await priceListVersions(db, accA.id, ilsList))[0];
    const rows = await entriesOf(db, accA.id, draft.id);
    expect(rows.find((e) => e.sku === "SNS-200")).toMatchObject({ oneTimeMinor: 59000, oneTimeTiers: [{ minQty: 10, priceMinor: 55000 }], recurringMinor: 1250, recurringPeriod: "year", customPricingFromQty: 50 });
    expect(rows.find((e) => e.sku === "PLAN-M")).toMatchObject({ oneTimeCharged: false, oneTimeMinor: null, recurringMinor: 9000, recurringPeriod: "month" });
    expect(rows.find((e) => e.sku === "SVC-INST")).toMatchObject({ oneTimeCharged: true, oneTimeMinor: null });
    expect((await listPriceLists(db, accA.id)).find((l) => l.lineageId === ilsList)?.missingPrices).toBe(1);

    // "Sold here: no" removes the entry; saving it again when it is gone is fine.
    await entry(ilsList, { sku: "GW-10", sold: "no" });
    expect(await entry(ilsList, { sku: "GW-10", sold: "no" })).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?saved=1` });
    expect((await entriesOf(db, accA.id, draft.id)).map((e) => e.sku)).toEqual(["PLAN-M", "SNS-200", "SVC-INST"]);
  });

  it("publish is refused while a price is missing, then goes live; the Prices step is done", async () => {
    expect(await run(actions.publishPriceListAction(form({ slug: "alpha", lineageId: ilsList })))).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?publish=problems` });
    await entry(ilsList, { sku: "SVC-INST", oneTimeCharged: "on", oneTimePrice: "350" });
    expect(await run(actions.publishPriceListAction(form({ slug: "alpha", lineageId: ilsList })))).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?published=1` });
    expect((await livePriceList(db, accA.id, ilsList))?.entries).toHaveLength(3);
    expect((await setupProgress(db, accA)).has("prices")).toBe(true);
    expect((await setupProgress(db, accB)).has("prices")).toBe(false);
  });

  it("an edit after publishing starts draft v2; settings save to it; discard goes back to live", async () => {
    const saved = await run(actions.saveMetaAction(idle, form({ slug: "alpha", lineageId: ilsList, name: "Israel 2027", pricesIncludeTax: "", taxRate: "17", validFrom: "2027-01-01" })));
    expect(saved).toEqual({ status: "saved" });
    expect(await run(actions.saveMetaAction(idle, form({ slug: "alpha", lineageId: ilsList, name: "x", taxRate: "x" })))).toMatchObject({ status: "error", errors: { taxRate: expect.any(String) } });
    const versions = await priceListVersions(db, accA.id, ilsList);
    expect(versions.map((v) => [v.version, v.status])).toEqual([[2, "draft"], [1, "live"]]);
    expect(versions[0]).toMatchObject({ name: "Israel 2027", pricesIncludeTax: false, taxRateBp: 1700, validFrom: "2027-01-01", currency: "ILS" });
    expect(await run(actions.discardPriceListDraftAction(form({ slug: "alpha", lineageId: ilsList })))).toEqual({ redirect: `/app/alpha/setup/price-lists/${ilsList}?discarded=1` });
    expect((await priceListVersions(db, accA.id, ilsList)).map((v) => v.status)).toEqual(["live"]);
    // Prices still come from the live version.
    expect((await setupProgress(db, accA)).has("prices")).toBe(true);
  });

  it("copy and adjust makes a new draft list in another currency and reports its problems", async () => {
    const live = (await livePriceList(db, accA.id, ilsList))!.list;
    expect(await run(actions.copyPriceListAction(idle, form({ slug: "alpha", source: live.id, name: "UK 2026", currency: "GBP", taxRate: "20", mode: "factor", amount: "", rounding: "whole" })))).toMatchObject({ status: "error", errors: { adjust: expect.any(String) } });
    expect(await run(actions.copyPriceListAction(idle, form({ slug: "alpha", source: "not-a-uuid", name: "UK", currency: "GBP", taxRate: "20", mode: "percent", amount: "0", rounding: "minor" })))).toMatchObject({ status: "error", errors: { source: expect.any(String) } });
    const r = await run(actions.copyPriceListAction(idle, form({ slug: "alpha", source: live.id, name: "UK 2026", currency: "GBP", taxRate: "20", mode: "factor", amount: "0.25", rounding: "whole", validFrom: "2026-12-01" })));
    const uk = lineageFrom(r);
    expect(r).toEqual({ redirect: `/app/alpha/setup/price-lists/${uk}?copied=3&problems=0` });
    const [list] = await priceListVersions(db, accA.id, uk);
    expect(list).toMatchObject({ name: "UK 2026", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2000, validFrom: "2026-12-01", status: "draft", copiedFromId: live.id });
    const rows = await entriesOf(db, accA.id, list.id);
    expect(rows.find((e) => e.sku === "SNS-200")).toMatchObject({ oneTimeMinor: 14800, oneTimeTiers: [{ minQty: 10, priceMinor: 13800 }] });

    // Rounding that makes a tier equal to the base price is reported as a problem.
    const p = await run(actions.copyPriceListAction(idle, form({ slug: "alpha", source: live.id, name: "Tiny", currency: "ILS", taxRate: "0", mode: "factor", amount: "0.001", rounding: "whole" })));
    expect((p as { redirect: string }).redirect).toMatch(/copied=3&problems=1$/);
  });

  it("keeps price lists to their account and refuses bad ids", async () => {
    as(accB);
    expect(await run(actions.saveEntryAction(idle, form({ slug: "beta", lineageId: ilsList, sku: "SNS-200", sold: "yes", oneTimeCharged: "on", oneTimePrice: "1" })))).toMatchObject({ status: "error", formError: "This price list was not found." });
    expect(await run(actions.saveMetaAction(idle, form({ slug: "beta", lineageId: ilsList, name: "Hacked", taxRate: "0" })))).toMatchObject({ status: "error" });
    expect(await run(actions.publishPriceListAction(form({ slug: "beta", lineageId: ilsList })))).toEqual({ redirect: "/app/beta/setup/price-lists" });
    expect(await run(actions.discardPriceListDraftAction(form({ slug: "beta", lineageId: "' or 1=1" })))).toEqual({ redirect: "/app/beta/setup/price-lists" });
    const live = (await livePriceList(db, accA.id, ilsList))!.list;
    expect(await run(actions.copyPriceListAction(idle, form({ slug: "beta", source: live.id, name: "Copy", currency: "ILS", taxRate: "0", mode: "percent", amount: "0", rounding: "minor" })))).toMatchObject({ status: "error", errors: { source: expect.any(String) } });
    expect(await db.select().from(priceLists).where(eq(priceLists.accountId, accB.id))).toEqual([]);
    expect((await livePriceList(db, accA.id, ilsList))?.list.name).toBe("Israel 2026");

    // Beta's own first list goes to Beta's home market, even when Beta has other markets.
    await createMarket(db, { userId: admin.id, actingAs: false }, accB.id, { name: "Cyprus", countries: ["CY"] });
    const r = await run(actions.createPriceListAction(idle, form({ slug: "beta", name: "Beta", currency: "EUR", taxRate: "0" })));
    const rows = await db.select().from(markets).where(eq(markets.accountId, accB.id));
    expect(rows.find((m) => m.isHome)?.priceListLineageId).toBe(lineageFrom(r));
    expect(rows.find((m) => !m.isHome)?.priceListLineageId).toBeNull();
  });

  it("audits through the service functions, including acting-as", async () => {
    as(accA, true);
    await entry(ilsList, { sku: "GW-10", oneTimeCharged: "on", oneTimePrice: "700" });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accA.id), eq(auditLog.targetId, ilsList)));
    const actionsSeen = new Set(audits.map((a) => a.action));
    for (const a of ["price_list.created", "price_list.entry_set", "price_list.entry_removed", "price_list.published", "price_list.settings_saved", "price_list.draft_discarded"]) expect(actionsSeen.has(a), a).toBe(true);
    expect(audits.some((a) => a.action === "price_list.entry_set" && a.actingAs)).toBe(true);
    const marketAudit = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accA.id), eq(auditLog.action, "market.price_list_set")));
    expect(marketAudit).toHaveLength(1);
  });
});
