import { describe, expect, it } from "vitest";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { approvalReasonText, pricingErrorText } from "@/lib/catalog/pricing";
import { autoAddRules, checkFit, describeFitRule, parseFitRule, type FitRule } from "@/lib/catalog/fit";
import { catalogAutoAdd, customPricesOf, customsFor, requestLinesOf, type PublishedCatalog } from "@/lib/quotes/pricing";

const install: AutoAddRule = { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false };

describe("auto-add rules among fit rules", () => {
  it("parseFitRule accepts a valid auto_add rule and rejects a bad one", () => {
    expect(parseFitRule(install)).toEqual(install);
    expect(parseFitRule({ ...install, whenAnyOf: [] })).toBeNull();
    expect(parseFitRule({ ...install, whenAnyOf: ["SVC-INST"] })).toBeNull();
  });
  it("checkFit ignores auto_add rules; they are described in plain words", () => {
    const rules: FitRule[] = [install, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"] }];
    expect(checkFit(rules, [{ sku: "GW-10", qty: 1 }], 1)).toEqual({ ok: true, problems: [], notes: [], fixes: [] });
    expect(autoAddRules(rules)).toEqual([install]);
    expect(describeFitRule(install)).toBe("When a quote has GW-10, add SVC-INST × number of sites.");
  });
  it("catalogAutoAdd prefers the catalog's own autoAdd list and never applies a rule twice", () => {
    const base = { rules: [install], items: [], version: {} } as unknown as PublishedCatalog;
    expect(catalogAutoAdd(base)).toEqual([install]);
    expect(catalogAutoAdd({ ...base, rules: [], autoAdd: [install] } as unknown as PublishedCatalog)).toEqual([install]);
    expect(catalogAutoAdd({ ...base, autoAdd: [] } as unknown as PublishedCatalog)).toEqual([]);
  });
});

describe("custom prices per charge", () => {
  const both = { oneTimeCharged: true, recurringCharged: true };
  const recurringOnly = { oneTimeCharged: false, recurringCharged: true };
  it("reads SKU:charge keys, and a bare SKU key as the only (or one-time) charge", () => {
    expect(customsFor({ "KIT:recurring": 400 }, "KIT", both)).toEqual({ customRecurringMinor: 400 });
    expect(customsFor({ "KIT:one_time": 9, "KIT:recurring": 4 }, "KIT", both)).toEqual({ customOneTimeMinor: 9, customRecurringMinor: 4 });
    expect(customsFor({ KIT: 7 }, "KIT", both)).toEqual({ customOneTimeMinor: 7 });
    expect(customsFor({ PLAN: 7 }, "PLAN", recurringOnly)).toEqual({ customRecurringMinor: 7 });
    expect(customsFor(undefined, "KIT", both)).toEqual({});
  });
  it("carries a person's prices per charge, and stored lines give one request line per SKU", () => {
    const lines = [
      { sku: "KIT", qty: 2, chargeType: "one_time", unitPriceMinor: 100, priceSource: "list" },
      { sku: "KIT", qty: 2, chargeType: "recurring", unitPriceMinor: 40, priceSource: "custom" },
    ];
    expect(customPricesOf(lines)).toEqual({ "KIT:recurring": 40 });
    expect(requestLinesOf(lines)).toEqual([{ sku: "KIT", qty: 2 }]);
  });
  it("explains price-list reasons and errors in plain words", () => {
    expect(approvalReasonText({ kind: "price_missing", sku: "KIT", charge: "recurring" })).toBe("KIT has no recurring price in the price list.");
    expect(approvalReasonText({ kind: "price_missing", sku: "KIT" })).toBe("KIT has no price in the catalog.");
    expect(pricingErrorText({ kind: "not_sold", sku: "KIT" })).toBe("KIT is not sold in this market.");
  });
});
