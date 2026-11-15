import { describe, expect, it } from "vitest";
import { adjustMinor, adjustmentRatio, minorDigits, parseDecimal } from "@/lib/pricing/adjust";
import { entryProblems, metaProblem, normalizeEntry, partState, type EntryInput } from "@/lib/pricing/price-lists";

const e = (over: Partial<EntryInput> = {}): EntryInput => ({ sku: "sns-200", oneTimeCharged: true, oneTimeMinor: 12_900, recurringCharged: false, recurringMinor: null, ...over });
const norm = (over: Partial<EntryInput> = {}) => {
  const r = normalizeEntry(e(over));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("price list entries", () => {
  it("normalizes: upper-case SKU, a part that is not charged keeps no price or tiers", () => {
    expect(norm({ recurringMinor: 500, recurringTiers: [{ minQty: 5, priceMinor: 400 }] })).toEqual({
      sku: "SNS-200",
      oneTimeCharged: true,
      oneTimeMinor: 12_900,
      oneTimeTiers: [],
      recurringCharged: false,
      recurringMinor: null,
      recurringPeriod: null,
      recurringTiers: [],
      customPricingFromQty: null,
    });
    expect(norm({ recurringCharged: true, recurringMinor: 300 }).recurringPeriod).toBe("month");
    expect(norm({ recurringCharged: true, recurringMinor: 300, recurringPeriod: "year" }).recurringPeriod).toBe("year");
    expect(norm({ oneTimeTiers: [{ minQty: 50, priceMinor: 10_900 }, { minQty: 10, priceMinor: 11_900 }] }).oneTimeTiers.map((t) => t.minQty)).toEqual([10, 50]);
  });

  it("rejects bad shapes", () => {
    expect(normalizeEntry(e({ sku: "bad sku" })).ok).toBe(false);
    expect(normalizeEntry(e({ oneTimeMinor: -1 })).ok).toBe(false);
    expect(normalizeEntry(e({ oneTimeMinor: 1.5 })).ok).toBe(false);
    expect(normalizeEntry(e({ oneTimeTiers: [{ minQty: 1, priceMinor: 100 }] })).ok).toBe(false);
    expect(normalizeEntry(e({ oneTimeTiers: [{ minQty: 5, priceMinor: 100 }, { minQty: 5, priceMinor: 90 }] })).ok).toBe(false);
    expect(normalizeEntry(e({ customPricingFromQty: 0 })).ok).toBe(false);
    expect(normalizeEntry(e({ recurringCharged: true, recurringMinor: 1, recurringPeriod: "week" as "month" })).ok).toBe(false);
  });

  it("finds missing prices and broken tiers per charge, using the catalog tier rule", () => {
    expect(entryProblems(norm())).toEqual([]);
    expect(entryProblems(norm({ oneTimeMinor: null, recurringCharged: true, recurringMinor: null }))).toEqual([
      { sku: "SNS-200", charge: "one_time", kind: "price_missing", message: "SNS-200: the one-time price is missing." },
      { sku: "SNS-200", charge: "recurring", kind: "price_missing", message: "SNS-200: the recurring price is missing." },
    ]);
    const tiers = entryProblems(norm({ recurringCharged: true, recurringMinor: 300, recurringTiers: [{ minQty: 10, priceMinor: 300 }] }));
    expect(tiers).toEqual([{ sku: "SNS-200", charge: "recurring", kind: "tiers", message: "SNS-200 (recurring): The price from 10 must be lower than the tier before." }]);
    expect(entryProblems(norm({ oneTimeTiers: [{ minQty: 10, priceMinor: 100 }], customPricingFromQty: 10 }))[0].kind).toBe("tiers");
    // Not charged at all is fine.
    expect(entryProblems(norm({ oneTimeCharged: false, oneTimeMinor: null }))).toEqual([]);
  });

  it("shows each part's state", () => {
    expect(partState(null, "one_time")).toBe("not_sold");
    expect(partState(norm(), "one_time")).toBe("priced");
    expect(partState(norm(), "recurring")).toBe("not_charged");
    expect(partState(norm({ oneTimeMinor: null }), "one_time")).toBe("price_missing");
  });

  it("validates price list settings", () => {
    expect(metaProblem({ name: "UK 2026", currency: "GBP", taxRateBp: 2_000, validFrom: "2026-12-01" })).toBeNull();
    expect(metaProblem({ name: " " })).not.toBeNull();
    expect(metaProblem({ currency: "gbp" })).not.toBeNull();
    expect(metaProblem({ currency: "XYZ1" })).not.toBeNull();
    expect(metaProblem({ taxRateBp: 10_001 })).not.toBeNull();
    expect(metaProblem({ validFrom: "2026-02-30" })).not.toBeNull();
    expect(metaProblem({ validFrom: null })).toBeNull();
  });
});

describe("copy and adjust math", () => {
  it("parses decimals exactly", () => {
    expect(parseDecimal("0.215")).toEqual({ num: 215n, den: 1000n });
    expect(parseDecimal("-10")).toEqual({ num: -10n, den: 1n });
    expect(parseDecimal("+7.5")).toEqual({ num: 75n, den: 10n });
    expect(parseDecimal("1e3")).toBeNull();
    expect(parseDecimal("0.1234567")).toBeNull();
  });

  it("combines factor and percentage, and rejects nonsense", () => {
    expect(adjustmentRatio({})).toEqual({ num: 1n, den: 1n });
    expect(adjustmentRatio({ percent: "-10" })).toEqual({ num: 90n, den: 100n });
    const r = adjustmentRatio({ factor: "0.2", percent: "5" })!;
    expect(Number(r.num) / Number(r.den)).toBeCloseTo(0.21, 10);
    expect(adjustmentRatio({ factor: "0" })).toBeNull();
    expect(adjustmentRatio({ factor: "-1" })).toBeNull();
    expect(adjustmentRatio({ percent: "-100" })).toBeNull();
    expect(adjustmentRatio({ percent: "abc" })).toBeNull();
  });

  it("rounds to the minor unit, the whole unit, or up to the whole unit", () => {
    const tenOff = adjustmentRatio({ percent: "-10" })!;
    // 129.95 × 0.9 = 116.955
    expect(adjustMinor(12_995, tenOff, "minor")).toBe(11_696);
    expect(adjustMinor(12_995, tenOff, "whole")).toBe(11_700);
    expect(adjustMinor(12_995, tenOff, "whole_up")).toBe(11_700);
    // 350.00 × 0.215 = 75.25
    const toGbp = adjustmentRatio({ factor: "0.215" })!;
    expect(adjustMinor(35_000, toGbp, "minor")).toBe(7_525);
    expect(adjustMinor(35_000, toGbp, "whole")).toBe(7_500);
    expect(adjustMinor(35_000, toGbp, "whole_up")).toBe(7_600);
    // Half rounds up: 0.05 × 0.5 = 0.025 → 0.03
    expect(adjustMinor(5, adjustmentRatio({ factor: "0.5" })!, "minor")).toBe(3);
    expect(adjustMinor(0, toGbp, "whole_up")).toBe(0);
  });

  it("converts between currencies with different minor digits", () => {
    expect(minorDigits("EUR")).toBe(2);
    expect(minorDigits("JPY")).toBe(0);
    // 10.00 EUR × 160 = 1,600 JPY
    expect(adjustMinor(1_000, adjustmentRatio({ factor: "160" })!, "minor", { from: 2, to: 0 })).toBe(1_600);
    // 1,600 JPY × 0.00625 = 10.00 EUR
    expect(adjustMinor(1_600, adjustmentRatio({ factor: "0.00625" })!, "minor", { from: 0, to: 2 })).toBe(1_000);
  });

  it("refuses results too large for a price", () => {
    expect(adjustMinor(2_000_000_000, adjustmentRatio({ factor: "2" })!, "minor")).toBeNull();
  });
});
