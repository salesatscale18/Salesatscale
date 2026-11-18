import { describe, expect, it } from "vitest";
import type { CatalogItem, PriceListEntry } from "@/db/schema";
import {
  capFirst, catalogRows, catalogSortAccessors, filterCatalogRows, itemPriceState, itemRuleChips, itemStatus, ruleSkus, rulesMentioning,
} from "@/lib/catalog/view";
import type { FitRule } from "@/lib/catalog/fit";
import { sortRows } from "@/lib/list-kit";

const item = (sku: string, name: string, o: Partial<CatalogItem> = {}): CatalogItem =>
  ({ id: `id-${sku}`, sku, name, kind: "product", unit: "device", unitCustom: null, active: true, plainName: null, ...o }) as CatalogItem;
const entry = (sku: string, o: Partial<PriceListEntry> = {}): PriceListEntry =>
  ({ id: `e-${sku}`, accountId: "a", priceListId: "p", sku, oneTimeCharged: true, oneTimeMinor: 1000, oneTimeTiers: [], recurringCharged: false, recurringMinor: null, recurringPeriod: null, recurringTiers: [], customPricingFromQty: null, ...o }) as PriceListEntry;

const items = [
  item("SNS-200", "Wireless fridge sensor", { plainName: "wireless fridge sensor" }),
  item("GW-10", "Site gateway", { unit: "site", plainName: "kitchen hub" }),
  item("CRP-40", "Cold room probe"),
  item("INST-1", "Installation", { kind: "service", unit: "site" }),
  item("SVC-REM", "Remote setup", { kind: "service", unit: "site", active: false }),
];
const rules: FitRule[] = [
  { kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
  { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
  { kind: "max_per", sku: "CRP-40", max: 4, perOneOf: ["GW-10", "SNS-200"] },
  { kind: "advice", text: "Offer the yearly plan.", sku: "CRP-40" },
  { kind: "advice", text: "Be kind." },
];
const entries = [
  entry("SNS-200", { oneTimeMinor: 59_000 }),
  entry("GW-10", { oneTimeMinor: 66_000, recurringCharged: true, recurringMinor: 9_000, recurringPeriod: "month" }),
  entry("CRP-40", { oneTimeMinor: null }),
  entry("SVC-REM", { oneTimeCharged: false, oneTimeMinor: null }),
];

describe("catalog list helpers", () => {
  it("capitalises the chat name as on quotes", () => {
    expect(capFirst("wireless fridge sensor")).toBe("Wireless fridge sensor");
    expect(capFirst("")).toBe("");
  });

  it("price state per item in the chosen list", () => {
    expect(itemPriceState(null)).toBe("not_priced");
    expect(itemPriceState(entries[0])).toBe("priced");
    expect(itemPriceState(entries[1])).toBe("priced");
    expect(itemPriceState(entries[2])).toBe("price_missing");
    expect(itemPriceState(entries[3])).toBe("not_charged");
    expect(itemPriceState(entry("X", { recurringCharged: true, recurringMinor: null }))).toBe("price_missing");
  });

  it("status: Inactive wins, then Price missing, else Active; no list means no price check", () => {
    expect(itemStatus(false, "not_priced")).toBe("inactive");
    expect(itemStatus(true, "not_priced")).toBe("price_missing");
    expect(itemStatus(true, "price_missing")).toBe("price_missing");
    expect(itemStatus(true, "not_charged")).toBe("active");
    expect(itemStatus(true, null)).toBe("active");
  });

  it("rule chips name items, never codes", () => {
    const nameOf = (s: string) => items.find((i) => i.sku === s)?.name;
    expect(itemRuleChips("SNS-200", rules, nameOf)).toEqual(["Needs Site gateway"]);
    expect(itemRuleChips("GW-10", rules, nameOf)).toEqual(["Adds Installation"]);
    expect(itemRuleChips("CRP-40", rules, nameOf)).toEqual(["Up to 4 per Site gateway or Wireless fridge sensor", "Advice"]);
    expect(itemRuleChips("INST-1", rules, nameOf)).toEqual([]);
    // An unknown item falls back to its code.
    expect(itemRuleChips("SNS-200", [{ kind: "requires", sku: "SNS-200", oneOf: ["ZZ-1"] }], nameOf)).toEqual(["Needs ZZ-1"]);
  });

  it("rules that name an item (the sheet's read-only list)", () => {
    expect(ruleSkus(rules[2])).toEqual(["CRP-40", "GW-10", "SNS-200"]);
    expect(ruleSkus(rules[4])).toEqual([]);
    const wrapped = rules.map((rule, i) => ({ id: String(i), rule }));
    expect(rulesMentioning("GW-10", wrapped).map((r) => r.id)).toEqual(["0", "1", "2"]);
    expect(rulesMentioning("SVC-REM", wrapped)).toEqual([]);
  });

  it("rows: prices from the chosen list, statuses and chips", () => {
    const rows = catalogRows(items, entries, rules);
    expect(rows.map((r) => [r.item.sku, r.price, r.status])).toEqual([
      ["SNS-200", "priced", "active"],
      ["GW-10", "priced", "active"],
      ["CRP-40", "price_missing", "price_missing"],
      ["INST-1", "not_priced", "price_missing"],
      ["SVC-REM", "not_charged", "inactive"],
    ]);
    // Without a price list there is no price column state.
    expect(catalogRows(items, null, rules).every((r) => r.price === null && r.status !== "price_missing")).toBe(true);
  });

  it("filters: search by name, chat name or code; kind; status", () => {
    const rows = catalogRows(items, entries, rules);
    expect(filterCatalogRows(rows, { q: "gw-" }).map((r) => r.item.sku)).toEqual(["GW-10"]);
    expect(filterCatalogRows(rows, { q: "kitchen" }).map((r) => r.item.sku)).toEqual(["GW-10"]);
    expect(filterCatalogRows(rows, { q: "PROBE" }).map((r) => r.item.sku)).toEqual(["CRP-40"]);
    expect(filterCatalogRows(rows, { kind: "service" }).map((r) => r.item.sku)).toEqual(["INST-1", "SVC-REM"]);
    expect(filterCatalogRows(rows, { status: "price_missing" }).map((r) => r.item.sku)).toEqual(["CRP-40", "INST-1"]);
    expect(filterCatalogRows(rows, { kind: "product", status: "active", q: "sensor" }).map((r) => r.item.sku)).toEqual(["SNS-200"]);
  });

  it("sorts by name, code, price (unpriced last) and status (Price missing first)", () => {
    const rows = catalogRows(items, entries, rules);
    const by = (k: keyof typeof catalogSortAccessors, d: "asc" | "desc") => sortRows(rows, k, d, catalogSortAccessors).map((r) => r.item.sku);
    expect(by("name", "asc")).toEqual(["CRP-40", "INST-1", "SVC-REM", "GW-10", "SNS-200"]);
    expect(by("code", "desc")).toEqual(["SVC-REM", "SNS-200", "INST-1", "GW-10", "CRP-40"]);
    expect(by("price", "desc")).toEqual(["GW-10", "SNS-200", "SVC-REM", "CRP-40", "INST-1"]);
    expect(by("status", "asc").slice(0, 2)).toEqual(["CRP-40", "INST-1"]);
    expect(by("charged", "asc")[0]).toBe("SNS-200");
  });
});
