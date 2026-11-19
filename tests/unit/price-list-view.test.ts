import { describe, expect, it } from "vitest";
import type { PriceList, PriceListEntry } from "@/db/schema";
import { sortRows } from "@/lib/list-kit";
import {
  deleteRefusalText, entryPriced, filterPriceLists, joinNames, filterPriceRows, hasRecurring, hasTiers, itemsPriced, listUpdatedAt, priceListSortAccessors, priceRowCounts,
  priceRowSortAccessors, priceWarningGroups, tierChip, vatParts, type PriceListRow, type PriceRow,
} from "@/lib/pricing/list-view";
import type { PriceListSummary } from "@/lib/pricing/price-lists";

const entry = (sku: string, o: Partial<PriceListEntry> = {}): PriceListEntry =>
  ({ id: `e-${sku}`, accountId: "a", priceListId: "p", sku, oneTimeCharged: true, oneTimeMinor: 1000, oneTimeTiers: [], recurringCharged: false, recurringMinor: null, recurringPeriod: null, recurringTiers: [], customPricingFromQty: null, ...o }) as PriceListEntry;
const list = (o: Partial<PriceList>): PriceList =>
  ({ id: "v", accountId: "a", lineageId: "l", name: "Israel prices", currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, validFrom: null, version: 1, status: "live", copiedFromId: null, createdAt: new Date("2026-11-01T10:00:00Z"), publishedAt: null, publishedByUserId: null, ...o }) as PriceList;

describe("price list helpers", () => {
  it("items priced: an item is priced when every charged part has a price; not sold is not priced", () => {
    const es = [entry("A"), entry("B", { oneTimeMinor: null }), entry("C", { oneTimeCharged: false, oneTimeMinor: null }), entry("GONE")];
    expect(entryPriced(es[0])).toBe(true);
    expect(entryPriced(es[1])).toBe(false);
    expect(entryPriced(es[2])).toBe(true);
    expect(entryPriced(null)).toBe(false);
    expect(itemsPriced(["A", "B", "C", "D", "A"], es)).toEqual({ priced: 2, total: 4, missing: 2 });
    expect(itemsPriced([], es)).toEqual({ priced: 0, total: 0, missing: 0 });
  });

  it("tier chip: the first tier, the recurring one with its period, and how many more", () => {
    expect(tierChip(entry("A"), "ILS")).toBeNull();
    expect(tierChip(null, "ILS")).toBeNull();
    expect(tierChip(entry("A", { oneTimeTiers: [{ minQty: 20, priceMinor: 50_000 }, { minQty: 10, priceMinor: 55_000 }] }), "ILS")).toBe("From 10: ₪550.00 · +1");
    expect(tierChip(entry("A", { oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] }), "ILS")).toBe("From 10: ₪550.00");
    expect(tierChip(entry("A", { recurringCharged: true, recurringMinor: 900, recurringPeriod: "year", recurringTiers: [{ minQty: 5, priceMinor: 800 }] }), "GBP")).toBe("From 5: £8.00/year");
    // Tiers of a part that is not charged do not count.
    expect(tierChip(entry("A", { oneTimeCharged: false, oneTimeTiers: [{ minQty: 10, priceMinor: 1 }] }), "ILS")).toBeNull();
    expect(hasTiers(entry("A", { oneTimeCharged: false, oneTimeTiers: [{ minQty: 10, priceMinor: 1 }] }))).toBe(false);
    expect(hasRecurring(entry("A", { recurringCharged: true }))).toBe(true);
  });

  it("VAT parts and the updated date", () => {
    expect(vatParts(list({}))).toEqual({ rate: "18%", mode: "Prices without VAT", line: "prices without VAT" });
    expect(vatParts(list({ pricesIncludeTax: true, taxRateBp: 1750 }))).toEqual({ rate: "17.5%", mode: "Prices include VAT", line: "prices include VAT" });
    const live = list({ publishedAt: new Date("2026-11-10T00:00:00Z") });
    const draft = list({ status: "draft", createdAt: new Date("2026-11-15T00:00:00Z") });
    expect(listUpdatedAt({ live, draft: null }).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(listUpdatedAt({ live, draft }).toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(listUpdatedAt({ live: null, draft }).toISOString()).toBe("2026-11-15T00:00:00.000Z");
  });

  it("price lists list: search, status filter and sort", () => {
    const sum = (name: string, currency: string, live: boolean, draft: boolean): PriceListSummary =>
      ({ lineageId: name, shown: list({ name, currency }), live: live ? list({ name }) : null, draft: draft ? list({ name, status: "draft" }) : null, entryCount: 0, missingPrices: 0, usedBy: [] });
    const rows: PriceListRow[] = [
      { summary: sum("UK prices", "GBP", false, true), priced: { priced: 3, total: 5, missing: 2 }, updated: new Date("2026-11-17") },
      { summary: sum("Israel prices", "ILS", true, true), priced: { priced: 4, total: 5, missing: 1 }, updated: new Date("2026-11-18") },
      { summary: sum("Euro prices", "EUR", true, false), priced: { priced: 5, total: 5, missing: 0 }, updated: new Date("2026-11-12") },
    ];
    const names = (rs: PriceListRow[]) => rs.map((r) => r.summary.shown.name);
    expect(names(filterPriceLists(rows, { q: "eur" }))).toEqual(["Euro prices"]);
    expect(names(filterPriceLists(rows, { q: "prices", status: "live" }))).toEqual(["Israel prices", "Euro prices"]);
    expect(names(filterPriceLists(rows, { status: "draft" }))).toEqual(["UK prices", "Israel prices"]);
    expect(names(sortRows(rows, "name", "asc", priceListSortAccessors))).toEqual(["Euro prices", "Israel prices", "UK prices"]);
    expect(names(sortRows(rows, "updated", "desc", priceListSortAccessors))).toEqual(["Israel prices", "UK prices", "Euro prices"]);
    expect(names(sortRows(rows, "priced", "asc", priceListSortAccessors))).toEqual(["UK prices", "Israel prices", "Euro prices"]);
  });

  it("prices table: chips All / Missing price / With tiers / Recurring, search, sort", () => {
    const rows: PriceRow[] = [
      { sku: "SNS-200", name: "Wireless fridge sensor", kind: "product", entry: entry("SNS-200", { oneTimeMinor: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] }) },
      { sku: "GW-10", name: "Site gateway", kind: "product", entry: entry("GW-10", { oneTimeMinor: 66_000, recurringCharged: true, recurringMinor: 9_000 }) },
      { sku: "CRP-40", name: "Cold room probe", kind: "product", entry: entry("CRP-40", { oneTimeMinor: null }) },
      { sku: "INST-1", name: "Installation", kind: "service", entry: null },
      { sku: "OLD-1", name: null, kind: null, entry: entry("OLD-1", { oneTimeMinor: 100 }) },
    ];
    expect(priceRowCounts(rows)).toEqual({ all: 5, missing: 2, tiers: 1, recurring: 1 });
    const skus = (rs: PriceRow[]) => rs.map((r) => r.sku);
    expect(skus(filterPriceRows(rows, { show: "missing" }))).toEqual(["CRP-40", "INST-1"]);
    expect(skus(filterPriceRows(rows, { show: "tiers" }))).toEqual(["SNS-200"]);
    expect(skus(filterPriceRows(rows, { show: "recurring" }))).toEqual(["GW-10"]);
    expect(skus(filterPriceRows(rows, { q: "old-" }))).toEqual(["OLD-1"]);
    expect(skus(filterPriceRows(rows, { q: "gateway", show: "missing" }))).toEqual([]);
    expect(skus(sortRows(rows, "one_time", "desc", priceRowSortAccessors))).toEqual(["GW-10", "SNS-200", "OLD-1", "CRP-40", "INST-1"]);
    expect(skus(sortRows(rows, "item", "asc", priceRowSortAccessors))).toEqual(["CRP-40", "INST-1", "OLD-1", "GW-10", "SNS-200"]);
  });
});

describe("price list delete refusal", () => {
  it("says why in plain words and names every market, or the quotes", () => {
    expect(joinNames(["Israel", "Cyprus", "Greece"])).toBe("Israel, Cyprus and Greece");
    expect(deleteRefusalText("in_use", ["Israel"])).toBe("Israel sells from this list. Choose another price list for that market first.");
    expect(deleteRefusalText("in_use", ["Israel", "Cyprus"])).toBe("Israel and Cyprus sell from this list. Choose another price list for those markets first.");
    expect(deleteRefusalText("in_use", [])).toBe("A market sells from this list. Choose another price list for that market first.");
    expect(deleteRefusalText("quoted", [])).toMatch(/^Quotes were priced from this list, so it can.t be deleted\./);
    expect(deleteRefusalText("not_found", [])).toBeNull();
    expect(deleteRefusalText(undefined, [])).toBeNull();
  });
  it("price warning: blocking problems first, then catalog items not in the list (each once); empty groups stay empty", () => {
    const problems = [{ sku: "INST-1", charge: "one_time", kind: "price_missing", message: "INST-1: the one-time price is missing." }];
    const rows = [{ sku: "GW-1", entry: entry("GW-1") }, { sku: "INST-1", entry: entry("INST-1", { oneTimeMinor: null }) }, { sku: "PRB-30", entry: null }, { sku: "PRB-30", entry: null }];
    expect(priceWarningGroups(problems, rows)).toEqual({
      mustFix: [{ key: "INST-1-one_time-price_missing", text: "INST-1: the one-time price is missing." }],
      notInList: ["PRB-30"],
    });
    expect(priceWarningGroups([], [{ sku: "A", entry: entry("A") }])).toEqual({ mustFix: [], notInList: [] });
  });
});
