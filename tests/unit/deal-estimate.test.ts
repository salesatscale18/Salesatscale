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
import { dealSortValue, estimateValue, roundEstimateOneTime, roundEstimateRecurring, sortByDealValue } from "@/lib/leads/list-row";
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
  it("reads '≈ ₪x est.' with the monthly amount in whole, rounded units, never a quote's words", () => {
    // The demo deal: 4,295.20 one-time and 424.80/mo.
    const v = estimateValue({ currency: "ILS", oneTimeMinor: 429_520, recurringMinor: 42_480, recurringPeriod: "month" })!;
    expect(v.oneTime).toBe("≈\u00a0₪4,300 est.");
    expect(v.recurring).toBe("+ ₪425/mo");
    const small = estimateValue({ currency: "ILS", oneTimeMinor: 87_449, recurringMinor: 4_249, recurringPeriod: "year" })!;
    expect(small.oneTime).toBe("≈\u00a0₪870 est.");
    expect(small.recurring).toBe("+ ₪42/yr");
    expect(estimateValue({ currency: "ILS", oneTimeMinor: 350_000, recurringMinor: 0, recurringPeriod: null })!.recurring).toBeNull();
    expect(estimateValue(null)).toBeNull();
  });

  it("rounds one-time to 2 significant digits from 1,000, else to 10; monthly to 5 from 100, else to 1", () => {
    expect([0, 4, 5, 994, 995, 999.99, 1000, 1049, 1050, 4295.2, 9949, 9950, 12_345, 987_654].map(roundEstimateOneTime))
      .toEqual([0, 0, 10, 990, 1000, 1000, 1000, 1000, 1100, 4300, 9900, 10_000, 12_000, 990_000]);
    expect([0, 0.4, 0.5, 42.49, 99.4, 99.5, 100, 102.4, 102.5, 424.8, 1234].map(roundEstimateRecurring))
      .toEqual([0, 0, 1, 42, 99, 100, 100, 100, 105, 425, 1235]);
  });

  it("whole units in other currencies too", () => {
    expect(estimateValue({ currency: "EUR", oneTimeMinor: 91_000, recurringMinor: 9_000, recurringPeriod: "month" })).toEqual({ oneTime: "≈\u00a0€910 est.", recurring: "+ €90/mo" });
    expect(estimateValue({ currency: "JPY", oneTimeMinor: 123_456, recurringMinor: 0, recurringPeriod: null })!.oneTime).toBe("≈\u00a0¥120,000 est.");
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
