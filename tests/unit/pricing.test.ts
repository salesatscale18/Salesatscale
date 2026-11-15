import { describe, expect, it } from "vitest";
import { computeTotals, priceQuote, roundDiv, unitPriceFor, type PricingItem } from "@/lib/catalog/pricing";

const item = (o: Partial<PricingItem> & { sku: string }): PricingItem => ({
  id: o.sku, name: o.sku, chargeType: "one_time", period: null, unit: "unit", priceMinor: 1000, volumeTiers: [], customPricingFromQty: null, active: true, ...o,
});

// The pilot-style catalog from the canvas (prices include VAT).
const catalog = [
  item({ sku: "SNS-200", unit: "sensor", priceMinor: 59_000, volumeTiers: [{ minQty: 10, priceMinor: 55_000 }], customPricingFromQty: 20 }),
  item({ sku: "GW-10", unit: "site", priceMinor: 66_000 }),
  item({ sku: "PLAN-M", unit: "site", chargeType: "recurring", period: "month", priceMinor: 9_000 }),
  item({ sku: "ADD-CELL", unit: "gateway", chargeType: "recurring", period: "month", priceMinor: null }),
  item({ sku: "OLD", active: false }),
];
const base = { items: catalog, discountBp: 0, maxDiscountBp: 700, pricesIncludeTax: true, taxRateBp: 1800 };

describe("roundDiv", () => {
  it.each([[5, 2, 3], [4, 2, 2], [1, 3, 0], [2, 3, 1], [0, 7, 0], [15, 10, 2], [14, 10, 1]])("%i/%i → %i", (n, d, r) => expect(roundDiv(n, d)).toBe(r));
  it("rejects negatives and non-integers", () => {
    expect(() => roundDiv(-1, 2)).toThrow();
    expect(() => roundDiv(1.5, 2)).toThrow();
    expect(() => roundDiv(1, 0)).toThrow();
  });
});

describe("unitPriceFor", () => {
  const sns = catalog[0];
  it("uses list price below the first tier and the highest tier reached", () => {
    expect(unitPriceFor(sns, 9)).toEqual({ priceMinor: 59_000, source: "list" });
    expect(unitPriceFor(sns, 10)).toEqual({ priceMinor: 55_000, source: "tier" });
    const multi = { priceMinor: 100, volumeTiers: [{ minQty: 50, priceMinor: 70 }, { minQty: 10, priceMinor: 90 }] };
    expect(unitPriceFor(multi, 60).priceMinor).toBe(70);
    expect(unitPriceFor(multi, 49).priceMinor).toBe(90);
  });
  it("has no price when the catalog has none", () => expect(unitPriceFor({ priceMinor: null, volumeTiers: [] }, 3).priceMinor).toBeNull());
});

describe("computeTotals", () => {
  it("VAT included: total is the net price and tax is extracted", () => {
    expect(computeTotals(486_000, 0, true, 1800)).toEqual({ subtotalMinor: 486_000, discountMinor: 0, taxMinor: 74_136, totalMinor: 486_000 });
  });
  it("VAT added on top, after the discount", () => {
    expect(computeTotals(100_000, 500, false, 1800)).toEqual({ subtotalMinor: 100_000, discountMinor: 5_000, taxMinor: 17_100, totalMinor: 112_100 });
  });
  it("zero rate and empty subtotal", () => {
    expect(computeTotals(0, 700, true, 1800)).toEqual({ subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 });
    expect(computeTotals(999, 0, false, 0).totalMinor).toBe(999);
  });
  it("rounds half up on discounts", () => expect(computeTotals(1_005, 500, true, 0).discountMinor).toBe(50));
});

describe("priceQuote", () => {
  it("prices the canvas quote: 6 sensors, 2 gateways, plan for 2 sites", () => {
    const r = priceQuote({ ...base, lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oneTime.totalMinor).toBe(486_000);
    expect(r.recurring.totalMinor).toBe(18_000);
    expect(r.recurringPeriod).toBe("month");
    expect(r.approvalReasons).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.lines.map((l) => [l.sku, l.unitPriceMinor, l.priceSource, l.lineTotalMinor])).toEqual([
      ["SNS-200", 59_000, "list", 354_000], ["GW-10", 66_000, "list", 132_000], ["PLAN-M", 9_000, "list", 18_000],
    ]);
  });

  it("applies volume tiers and flags the custom-pricing quantity", () => {
    const tier = priceQuote({ ...base, lines: [{ sku: "SNS-200", qty: 12 }] });
    expect(tier.ok && tier.lines[0]).toMatchObject({ unitPriceMinor: 55_000, priceSource: "tier" });
    const custom = priceQuote({ ...base, lines: [{ sku: "SNS-200", qty: 20 }] });
    expect(custom.ok && custom.approvalReasons).toEqual([{ kind: "custom_pricing_qty", sku: "SNS-200", qty: 20, from: 20 }]);
  });

  it("needs approval for a missing price and leaves it out of totals", () => {
    const r = priceQuote({ ...base, lines: [{ sku: "PLAN-M", qty: 1 }, { sku: "ADD-CELL", qty: 1 }] });
    expect(r.ok && r.approvalReasons).toEqual([{ kind: "price_missing", sku: "ADD-CELL" }]);
    expect(r.ok && r.complete).toBe(false);
    expect(r.ok && r.recurring.subtotalMinor).toBe(9_000);
  });

  it("a person's custom price clears the price reason and is labelled custom", () => {
    const r = priceQuote({ ...base, lines: [{ sku: "ADD-CELL", qty: 2, customUnitPriceMinor: 2_500 }] });
    expect(r.ok && r.approvalReasons).toEqual([]);
    expect(r.ok && r.lines[0]).toMatchObject({ priceSource: "custom", lineTotalMinor: 5_000 });
  });

  it("flags a discount above the limit but allows one at the limit", () => {
    const over = priceQuote({ ...base, discountBp: 1500, lines: [{ sku: "GW-10", qty: 1 }] });
    expect(over.ok && over.approvalReasons).toEqual([{ kind: "discount_over_limit", requestedBp: 1500, limitBp: 700 }]);
    const at = priceQuote({ ...base, discountBp: 700, lines: [{ sku: "GW-10", qty: 1 }] });
    expect(at.ok && at.approvalReasons).toEqual([]);
    expect(at.ok && at.oneTime).toMatchObject({ discountMinor: 4_620, totalMinor: 61_380 });
  });

  it("rejects unknown, inactive, duplicate and bad quantities, bad discounts and empty quotes", () => {
    const r = priceQuote({ ...base, discountBp: -1, lines: [{ sku: "NOPE", qty: 1 }, { sku: "OLD", qty: 1 }, { sku: "GW-10", qty: 0 }, { sku: "PLAN-M", qty: 1.5 }, { sku: "SNS-200", qty: 1 }, { sku: "SNS-200", qty: 2 }] });
    expect(!r.ok && r.errors.map((e) => e.kind)).toEqual(["bad_discount", "unknown_sku", "inactive", "bad_qty", "bad_qty", "duplicate_sku"]);
    expect(priceQuote({ ...base, lines: [] }).ok).toBe(false);
    expect(priceQuote({ ...base, lines: [{ sku: "GW-10", qty: 1, customUnitPriceMinor: -5 }] }).ok).toBe(false);
  });

  it("refuses mixed billing periods", () => {
    const yearly = item({ sku: "PLAN-Y", chargeType: "recurring", period: "year" });
    const r = priceQuote({ ...base, items: [...catalog, yearly], lines: [{ sku: "PLAN-M", qty: 1 }, { sku: "PLAN-Y", qty: 1 }] });
    expect(!r.ok && r.errors).toEqual([{ kind: "mixed_periods" }]);
  });

  it("stays exact on large quantities", () => {
    const r = priceQuote({ ...base, lines: [{ sku: "GW-10", qty: 100_000 }] });
    expect(r.ok && r.oneTime.totalMinor).toBe(6_600_000_000);
  });
});
