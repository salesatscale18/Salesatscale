/**
 * Deal size estimate (LD, owner approved 22 Nov): deal fields × the market's
 * price list, through the fit and pricing helpers create_quote and check_fit
 * use. Pure; no model call. Display only (never summed): see list-row.
 */
import { describe, expect, it } from "vitest";
import type { EngineEntry } from "@/lib/pricing/engine";
import type { FitRule } from "@/lib/catalog/fit";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { countOf, estimateDeal, type EstimateInput, type EstimateItem } from "@/lib/leads/deal-estimate";
import { dealSortValue, estimateValue, sortByDealValue } from "@/lib/leads/list-row";
import { NO_FACTS } from "@/lib/leads/list-facts";

const entry = (sku: string, oneTimeMinor: number | null, extra: Partial<EngineEntry> = {}): EngineEntry => ({
  sku, oneTimeCharged: true, oneTimeMinor, oneTimeTiers: [], recurringCharged: false, recurringMinor: null, recurringPeriod: null, recurringTiers: [],
  customPricingFromQty: null, ...extra,
});

// The demo catalog (lib/demo/seed.ts): sensor per device, gateway per site (+ monthly plan), installation per site added automatically.
const ITEMS: EstimateItem[] = [
  { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device", kind: "product", active: true },
  { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site", kind: "product", active: true },
  { sku: "INST-1", name: "Installation", plainName: "installation", unit: "site", kind: "service", active: true },
];
const RULES: FitRule[] = [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }];
const AUTO: AutoAddRule[] = [{ kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true }];
const ENTRIES: EngineEntry[] = [
  entry("SNS-200", 59_000, { oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] }),
  entry("GW-10", 66_000, { recurringCharged: true, recurringMinor: 9_000, recurringPeriod: "month" }),
  entry("INST-1", 25_000),
];
const FIELDS: EstimateInput["fields"] = [
  { key: "sites", label: "Number of sites", stage: "before_quote" },
  { key: "current_monitoring", label: "How they check fridges today", stage: "optional" },
  { key: "company_name", label: "Company name", stage: "before_order_form" },
];
const input = (values: Record<string, string>, over: Partial<EstimateInput> = {}): EstimateInput => ({
  fields: FIELDS, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])), items: ITEMS, rules: RULES, autoAdd: AUTO,
  priceList: { list: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 }, entries: ENTRIES }, ...over,
});

describe("countOf", () => {
  it("reads a whole number with at most two words after it", () => {
    expect(countOf("4")).toBe(4);
    expect(countOf("about 15")).toBe(15);
    expect(countOf("12 fridges")).toBe(12);
    expect(countOf("1,200")).toBe(1200);
    expect(countOf("15-20")).toBe(15);
  });
  it("ignores text that is not a count", () => {
    expect(countOf("2 times a day on paper")).toBeNull();
    expect(countOf("paper sheet")).toBeNull();
    expect(countOf("0")).toBeNull();
    expect(countOf("")).toBeNull();
    expect(countOf("3.5")).toBeNull();
  });
});

describe("estimateDeal (demo catalog)", () => {
  it("sites only: one gateway per site plus installation added per site, with VAT, as a quote totals it", () => {
    const e = estimateDeal(input({ sites: "4" }))!;
    // 4 × 660 + 4 × 250 = 3,640 ILS, + 18% VAT = 4,295.20; 4 × 90 = 360/mo + VAT = 424.80.
    expect(e).toEqual({ currency: "ILS", oneTimeMinor: 429_520, recurringMinor: 42_480, recurringPeriod: "month" });
  });

  it("a count of sensors adds them, with the volume tier, and the gateways they need", () => {
    const e = estimateDeal(input({ sites: "2", sensors: "12" }))!;
    // 12 × 550 + 2 × 660 + 2 × 250 = 8,420 ILS + VAT.
    expect(e.oneTimeMinor).toBe(Math.round(842_000 * 1.18));
    // Sensors without sites: one gateway from the fit rule's fix, installation for it.
    const noSites = estimateDeal(input({ sensors: "3" }))!;
    expect(noSites.oneTimeMinor).toBe(Math.round((3 * 59_000 + 66_000 + 25_000) * 1.18));
  });

  it("not enough data: nothing to estimate", () => {
    expect(estimateDeal(input({}))).toBeNull();
    expect(estimateDeal(input({ current_monitoring: "paper logs" }))).toBeNull();
    // A free-text answer that happens to start with a number is not a count of fridges.
    expect(estimateDeal(input({ current_monitoring: "2 times a day on paper" }))).toBeNull();
    // Order-form fields are never read.
    expect(estimateDeal(input({ company_name: "4" }))).toBeNull();
    // Agent bookkeeping keys (asked counts) are not deal data.
    expect(estimateDeal(input({ _asked_sites: "2" }))).toBeNull();
  });

  it("no price list, a price still missing, or an item not sold here: no estimate", () => {
    expect(estimateDeal(input({ sites: "4" }, { priceList: null }))).toBeNull();
    expect(estimateDeal(input({ sites: "4" }, { priceList: { list: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 }, entries: [entry("GW-10", null), entry("INST-1", 25_000)] } }))).toBeNull();
    // Without a gateway in the price list, nothing per site is sold: no estimate.
    expect(estimateDeal(input({ sites: "4" }, { priceList: { list: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 }, entries: [entry("INST-1", 25_000)] } }))).toBeNull();
  });

  it("products of interest limit the estimate to the products named", () => {
    const fields = [...FIELDS, { key: "products_of_interest", label: "Products of interest", stage: "optional" as const }];
    // Only the gateway named: per site, and installation with it.
    expect(estimateDeal(input({ sites: "2", sensors: "10", products_of_interest: "the kitchen hub" }, { fields }))!.oneTimeMinor).toBe(Math.round((2 * 66_000 + 2 * 25_000) * 1.18));
  });

  it("two products charged per site with no products field: ambiguous, no estimate", () => {
    const items = [...ITEMS, { sku: "GW-20", name: "Pro gateway", unit: "site", kind: "product" as const, active: true }];
    const entries = [...ENTRIES, entry("GW-20", 90_000)];
    expect(estimateDeal(input({ sites: "2" }, { items, priceList: { list: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 }, entries } }))).toBeNull();
  });

  it("prices that include tax are totalled as they are", () => {
    const e = estimateDeal(input({ sites: "1" }, { priceList: { list: { currency: "EUR", pricesIncludeTax: true, taxRateBp: 2000 }, entries: ENTRIES } }))!;
    expect(e).toMatchObject({ currency: "EUR", oneTimeMinor: 91_000, recurringMinor: 9_000 });
  });
});

describe("estimate display and sort (display only)", () => {
  it("reads '≈ ₪x est.' with the monthly amount, never a quote's words", () => {
    const v = estimateValue({ currency: "ILS", oneTimeMinor: 350_000, recurringMinor: 36_000, recurringPeriod: "month" })!;
    expect(v.oneTime).toMatch(/^≈\s₪3,500(\.00)? est\.$/);
    expect(v.recurring).toMatch(/₪360(\.00)?\/mo/);
    expect(estimateValue(null)).toBeNull();
  });

  it("sorts quotes and estimates together, leads with neither last in both directions, one currency never added to another", () => {
    const quote = (oneTimeMinor: number) => ({ ...NO_FACTS, quote: { number: 1, version: 1, status: "sent" as const, currency: "ILS", oneTimeMinor, recurringMinor: 0, recurringPeriod: null, toPrice: false } });
    const est = (oneTimeMinor: number) => ({ currency: "ILS", oneTimeMinor, recurringMinor: 0, recurringPeriod: null });
    const rows = [
      { id: "none", v: dealSortValue(NO_FACTS, null) },
      { id: "q-small", v: dealSortValue(quote(100_000), null) },
      { id: "est", v: dealSortValue(NO_FACTS, est(300_000)) },
      { id: "q-big", v: dealSortValue(quote(500_000), est(1)) },
    ];
    expect(sortByDealValue(rows, (r) => r.v, "desc").map((r) => r.id)).toEqual(["q-big", "est", "q-small", "none"]);
    expect(sortByDealValue(rows, (r) => r.v, "asc").map((r) => r.id)).toEqual(["q-small", "est", "q-big", "none"]);
  });
});
