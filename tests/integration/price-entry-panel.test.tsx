import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { checkPriceBlock, serializeTierRows, tierLines, tierSummary } from "@/lib/catalog/tiers";
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
const { entryFormDefaults } = await import("@/app/app/[account]/setup/price-lists/rules");
const { default: PriceListEditorPage } = await import("@/app/app/[account]/setup/price-lists/[lineageId]/page");
const { saveItemAction, publishAction: publishCatalogAction } = await import("@/app/app/[account]/setup/catalog/actions");
const { entriesOf, itemInOtherLists, livePriceList, priceListVersions } = await import("@/lib/pricing/price-lists");
const { publishedCatalog } = await import("@/lib/catalog/service");
const { priceWithList } = await import("@/lib/pricing/engine");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
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

describe("price list item panel: tiers on both charges, custom pricing, other lists", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: SellerAccount, accB: SellerAccount;
  let ils = "", gbp = "", spare = "", betaList = "";
  const as = (account: SellerAccount) => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; };
  const lineageFrom = (r: unknown) => /price-lists\/([0-9a-f-]{36})/.exec((r as { redirect: string }).redirect)![1];
  const save = (slug: string, lineageId: string, v: Record<string, string>) => run(actions.saveEntryAction(idle, form({ slug, lineageId, sold: "yes", ...v })));
  const newList = async (slug: string, name: string, currency: string, incl: boolean) =>
    lineageFrom(await run(actions.createPriceListAction(idle, form({ slug, name, currency, taxRate: "18", ...(incl ? { pricesIncludeTax: "on" } : {}) }))));

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
    for (const [acc, slug] of [[accA, "alpha"], [accB, "beta"]] as const) {
      as(acc);
      await run(saveItemAction(idle, form({ slug, sku: "SNS-200", name: "Wireless sensor", kind: "product", unit: "device", active: "on" })));
      await run(publishCatalogAction(form({ slug })));
    }
    as(accA);
    ils = await newList("alpha", "Israel 2026", "ILS", true);
    gbp = await newList("alpha", "UK 2026", "GBP", false);
    spare = await newList("alpha", "Spare", "EUR", true);
    as(accB);
    betaList = await newList("beta", "Beta list", "ILS", true);
    await save("beta", betaList, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "999" });
    as(accA);
  });
  afterAll(async () => t.close());

  it("saves tiers for both charges as the editor sends them, and reads them back into the editor", async () => {
    // What the editor posts: its rows serialized into the hidden fields.
    const oneTimeTiers = serializeTierRows([{ qty: "10", price: "550" }]);
    const recurringTiers = serializeTierRows([{ qty: "10", price: "12.50" }]);
    const r = await save("alpha", ils, {
      sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "590", oneTimeTiers,
      recurringCharged: "on", recurringPrice: "15", recurringPeriod: "month", recurringTiers, customPricingFromQty: "20",
    });
    expect(r).toEqual({ redirect: `/app/alpha/setup/price-lists/${ils}?saved=1` });
    const draft = (await priceListVersions(db, accA.id, ils))[0];
    const [e] = await entriesOf(db, accA.id, draft.id);
    expect(e).toMatchObject({
      sku: "SNS-200", oneTimeMinor: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }],
      recurringMinor: 1_500, recurringPeriod: "month", recurringTiers: [{ minQty: 10, priceMinor: 1_250 }], customPricingFromQty: 20,
    });
    // Back in the editor: the same rows, valid, with the design's summary lines.
    const d = entryFormDefaults(e, "ILS");
    const ot = checkPriceBlock(d.oneTimePrice, tierLines(d.oneTimeTiers), 20, "ILS");
    const rc = checkPriceBlock(d.recurringPrice, tierLines(d.recurringTiers), 20, "ILS");
    expect([ot.errorCount, rc.errorCount]).toEqual([0, 0]);
    expect(tierSummary(ot.baseMinor, ot.tiers, 20, "ILS")).toBe("1–9: ₪590 · 10–19: ₪550 · 20+: custom pricing");
    expect(tierSummary(rc.baseMinor, rc.tiers, 20, "ILS", "month")).toBe("1–9: ₪15/month · 10–19: ₪12.50/month · 20+: custom pricing");
  });

  it("refuses on the server what the editor blocks, and keeps the saved entry", async () => {
    const before = await entriesOf(db, accA.id, (await priceListVersions(db, accA.id, ils))[0].id);
    const bad = await save("alpha", ils, { sku: "SNS-200", recurringCharged: "on", recurringPrice: "15", recurringTiers: "10: 16", customPricingFromQty: "20" });
    expect(bad).toMatchObject({ status: "error", errors: { recurringTiers: "Price must be lower than the tier before it (₪15 from 1)." } });
    expect(await save("alpha", ils, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "590", oneTimeTiers: "20: 500", customPricingFromQty: "20" }))
      .toMatchObject({ status: "error", errors: { oneTimeTiers: expect.stringContaining("custom pricing (20+)") } });
    expect(await save("alpha", ils, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "590", oneTimeTiers: "10: 550\n10: 540" }))
      .toMatchObject({ status: "error", errors: { oneTimeTiers: "Quantity 10 is used twice." } });
    expect(await entriesOf(db, accA.id, (await priceListVersions(db, accA.id, ils))[0].id)).toEqual(before);
  });

  it("custom pricing applies to both charges once published", async () => {
    expect(await run(actions.publishPriceListAction(form({ slug: "alpha", lineageId: ils })))).toEqual({ redirect: `/app/alpha/setup/price-lists/${ils}?published=1` });
    const live = (await livePriceList(db, accA.id, ils))!;
    const catalog = (await publishedCatalog(db, accA.id))!;
    const quote = (qty: number, custom: { customOneTimeMinor?: number; customRecurringMinor?: number } = {}) => {
      const r = priceWithList({ items: catalog.items, entries: live.entries, priceList: live.list, lines: [{ sku: "SNS-200", qty, ...custom }], discountBp: 0, maxDiscountBp: 1_000 });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r;
    };
    const lines = (r: ReturnType<typeof quote>) => r.lines.map((l) => [l.charge, l.priceSource, l.unitPriceMinor]);
    const customFlag = (r: ReturnType<typeof quote>) => r.approvalReasons.filter((a) => a.kind === "custom_pricing_qty");
    expect(lines(quote(5))).toEqual([["one_time", "list", 59_000], ["recurring", "list", 1_500]]);
    expect(lines(quote(12))).toEqual([["one_time", "tier", 55_000], ["recurring", "tier", 1_250]]);
    expect(customFlag(quote(19))).toEqual([]);
    // From 20 the quote goes to the seller for pricing, and the seller sets both prices.
    expect(customFlag(quote(20))).toHaveLength(1);
    expect(lines(quote(20, { customOneTimeMinor: 50_000, customRecurringMinor: 1_000 }))).toEqual([["one_time", "custom", 50_000], ["recurring", "custom", 1_000]]);
  });

  it("lists the item in the account's other price lists, and only this account's", async () => {
    await save("alpha", gbp, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "129", recurringCharged: "on", recurringPrice: "3" });
    const others = await itemInOtherLists(db, accA.id, "sns-200", ils);
    expect(others.map((o) => [o.list.name, o.entry?.oneTimeMinor ?? null, o.entry?.recurringMinor ?? null])).toEqual([["UK 2026", 12_900, 300], ["Spare", null, null]]);
    expect(others.some((o) => o.lineageId === ils || o.lineageId === betaList)).toBe(false);
    // Beta sees only its own list; Alpha's prices never show up there.
    expect(await itemInOtherLists(db, accB.id, "SNS-200", "00000000-0000-4000-8000-000000000000")).toMatchObject([{ lineageId: betaList, entry: { oneTimeMinor: 99_900 } }]);
    expect(await itemInOtherLists(db, accB.id, "SNS-200", ils)).toHaveLength(1);
  });

  it("another account cannot save into this price list", async () => {
    as(accB);
    expect(await save("beta", gbp, { sku: "SNS-200", oneTimeCharged: "on", oneTimePrice: "1" })).toMatchObject({ status: "error", formError: "This price list was not found." });
    await expect(PriceListEditorPage({ params: Promise.resolve({ account: "beta", lineageId: gbp }), searchParams: Promise.resolve({ sku: "SNS-200" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    as(accA);
    const draft = (await priceListVersions(db, accA.id, gbp))[0];
    expect((await entriesOf(db, accA.id, draft.id))[0]).toMatchObject({ oneTimeMinor: 12_900 });
  });

  it("renders the panel: header, both tier editors, custom pricing sentence and the other-lists card", async () => {
    const html = renderToStaticMarkup(await PriceListEditorPage({ params: Promise.resolve({ account: "alpha", lineageId: ils }), searchParams: Promise.resolve({ sku: "SNS-200" }) }));
    expect(html).toContain("SNS-200 · Product · per device");
    expect(html).toContain("Israel 2026 · ILS · prices include VAT · draft v2");
    expect(html).toContain("Sold in this price list");
    expect(html).toContain('id="pe-ot"');
    expect(html).toContain('id="pe-rc"');
    expect(html).toContain('id="pe-rp"');
    expect(html).toContain("1–9: ₪590 · 10–19: ₪550 · 20+: custom pricing");
    expect(html).toContain("1–9: ₪15/month · 10–19: ₪12.50/month · 20+: custom pricing");
    expect(html).toContain("Custom pricing, set per quote");
    expect(html).toContain("devices in one quote, you set the price yourself.");
    expect(html).toContain("Applies to both prices above. Leave empty to always use the tiers.");
    expect(html).toContain("This item in your other price lists");
    expect(html).toContain(`/app/alpha/setup/price-lists/${gbp}?sku=SNS-200`);
    expect(html).toContain("£129.00 + £3.00/mo");
    expect(html).toContain("Shown for consistency only. Each list keeps its own prices.");
    expect(html).not.toContain("Beta list");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("10: 550 (from 10 units");
  });
});
