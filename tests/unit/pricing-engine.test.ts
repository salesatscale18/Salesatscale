import { describe, expect, it } from "vitest";
import { engineApprovalText, engineErrorText, priceWithList, type EngineEntry, type EngineInput, type EngineItem } from "@/lib/pricing/engine";
import type { AutoAddRule } from "@/lib/pricing/auto-add";

const item = (sku: string, over: Partial<EngineItem> = {}): EngineItem => ({ id: `id-${sku}`, sku, name: sku, unit: "device", kind: "product", active: true, ...over });
const entry = (sku: string, over: Partial<EngineEntry> = {}): EngineEntry => ({
  sku,
  oneTimeCharged: false,
  oneTimeMinor: null,
  oneTimeTiers: [],
  recurringCharged: false,
  recurringMinor: null,
  recurringPeriod: null,
  recurringTiers: [],
  customPricingFromQty: null,
  ...over,
});

const items = [
  item("SNS-200"),
  item("GW-10"),
  item("PLAN-M", { kind: "service", unit: "site" }),
  item("PLAN-Y", { kind: "service", unit: "site" }),
  item("SVC-INST", { kind: "service", unit: "site" }),
  item("FREE-APP", { kind: "service" }),
  item("OLD", { kind: null }),
  item("GONE", { active: false }),
  item("SNS-210"),
];
const entries = [
  // Both charges on one item, with tiers on each.
  entry("SNS-200", {
    oneTimeCharged: true, oneTimeMinor: 12_900, oneTimeTiers: [{ minQty: 10, priceMinor: 11_900 }, { minQty: 50, priceMinor: 10_900 }],
    recurringCharged: true, recurringMinor: 300, recurringPeriod: "month", recurringTiers: [{ minQty: 20, priceMinor: 250 }],
    customPricingFromQty: 200,
  }),
  entry("GW-10", { oneTimeCharged: true, oneTimeMinor: 14_900 }),
  entry("PLAN-M", { recurringCharged: true, recurringMinor: 1_900, recurringPeriod: "month" }),
  entry("PLAN-Y", { recurringCharged: true, recurringMinor: 19_000, recurringPeriod: "year" }),
  // Price missing.
  entry("SVC-INST", { oneTimeCharged: true, oneTimeMinor: null }),
  // Sold, nothing charged.
  entry("FREE-APP"),
  entry("OLD", { oneTimeCharged: true, oneTimeMinor: 1_000 }),
  entry("GONE", { oneTimeCharged: true, oneTimeMinor: 1_000 }),
  // SNS-210 has no entry: not sold.
];

const base = (over: Partial<EngineInput> = {}): EngineInput => ({
  items,
  entries,
  priceList: { currency: "GBP", pricesIncludeTax: false, taxRateBp: 2_000 },
  lines: [],
  discountBp: 0,
  maxDiscountBp: 1_000,
  ...over,
});

const ok = (input: EngineInput) => {
  const r = priceWithList(input);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};

describe("pricing engine v2", () => {
  it("expands one item into a one-time and a recurring line", () => {
    const r = ok(base({ lines: [{ sku: "SNS-200", qty: 2 }] }));
    expect(r.lines.map((l) => [l.charge, l.period, l.unitPriceMinor, l.priceSource, l.lineTotalMinor])).toEqual([
      ["one_time", null, 12_900, "list", 25_800],
      ["recurring", "month", 300, "list", 600],
    ]);
    expect(r.oneTime.subtotalMinor).toBe(25_800);
    expect(r.recurring.subtotalMinor).toBe(600);
    expect(r.recurringPeriod).toBe("month");
    expect(r.complete).toBe(true);
    expect(r.currency).toBe("GBP");
  });

  it("selects tiers per charge", () => {
    const r = ok(base({ lines: [{ sku: "SNS-200", qty: 20 }] }));
    expect(r.lines.map((l) => [l.charge, l.unitPriceMinor, l.priceSource])).toEqual([
      ["one_time", 11_900, "tier"],
      ["recurring", 250, "tier"],
    ]);
    const r2 = ok(base({ lines: [{ sku: "SNS-200", qty: 50 }] }));
    expect(r2.lines.map((l) => l.unitPriceMinor)).toEqual([10_900, 250]);
    const r3 = ok(base({ lines: [{ sku: "SNS-200", qty: 12 }] }));
    expect(r3.lines.map((l) => [l.unitPriceMinor, l.priceSource])).toEqual([[11_900, "tier"], [300, "list"]]);
  });

  it("prices yearly recurring", () => {
    const r = ok(base({ lines: [{ sku: "PLAN-Y", qty: 3 }] }));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ charge: "recurring", period: "year", lineTotalMinor: 57_000, kind: "service" });
    expect(r.recurringPeriod).toBe("year");
    expect(r.oneTime.totalMinor).toBe(0);
  });

  it("refuses monthly and yearly recurring prices on one quote", () => {
    const r = priceWithList(base({ lines: [{ sku: "PLAN-M", qty: 1 }, { sku: "PLAN-Y", qty: 1 }] }));
    expect(r).toEqual({ ok: false, errors: [{ kind: "mixed_periods" }] });
  });

  it("tells not charged, price missing and not sold apart", () => {
    const free = ok(base({ lines: [{ sku: "FREE-APP", qty: 1 }] }));
    expect(free.lines).toEqual([expect.objectContaining({ charge: "one_time", unitPriceMinor: 0, priceSource: "not_charged", lineTotalMinor: 0 })]);
    expect(free.approvalReasons).toEqual([]);

    const missing = ok(base({ lines: [{ sku: "SVC-INST", qty: 2 }] }));
    expect(missing.lines[0]).toMatchObject({ unitPriceMinor: null, lineTotalMinor: null });
    expect(missing.complete).toBe(false);
    expect(missing.approvalReasons).toEqual([{ kind: "price_missing", sku: "SVC-INST", charge: "one_time" }]);
    expect(engineApprovalText(missing.approvalReasons[0])).toBe("SVC-INST has no one-time price in the price list.");

    const notSold = priceWithList(base({ lines: [{ sku: "SNS-210", qty: 1 }] }));
    expect(notSold).toEqual({ ok: false, errors: [{ kind: "not_sold", sku: "SNS-210" }] });
    expect(engineErrorText({ kind: "not_sold", sku: "SNS-210" })).toBe("SNS-210 is not sold in this price list.");
  });

  it("reports unknown, inactive, duplicate and bad lines", () => {
    const r = priceWithList(base({ lines: [{ sku: "NOPE", qty: 1 }, { sku: "GONE", qty: 1 }, { sku: "GW-10", qty: 1 }, { sku: "GW-10", qty: 1 }, { sku: "OLD", qty: 0 }], discountBp: -1 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { kind: "bad_discount" },
      { kind: "unknown_sku", sku: "NOPE" },
      { kind: "inactive", sku: "GONE" },
      { kind: "duplicate_sku", sku: "GW-10" },
      { kind: "bad_qty", sku: "OLD" },
    ]);
    expect(priceWithList(base())).toEqual({ ok: false, errors: [{ kind: "no_lines" }] });
    expect(priceWithList(base({ lines: [{ sku: "GW-10", qty: 1, customOneTimeMinor: -5 }] }))).toEqual({ ok: false, errors: [{ kind: "bad_custom_price", sku: "GW-10" }] });
  });

  it("treats an item without a kind as a product", () => {
    expect(ok(base({ lines: [{ sku: "OLD", qty: 1 }] })).lines[0].kind).toBe("product");
  });

  it("applies the discount to one-time charges only", () => {
    const r = ok(base({ lines: [{ sku: "SNS-200", qty: 10 }, { sku: "PLAN-M", qty: 2 }], discountBp: 1_000 }));
    // one-time 10 × 119.00 = 1,190.00; 10% off = 119.00; VAT 20% on 1,071.00 = 214.20
    expect(r.oneTime).toEqual({ subtotalMinor: 119_000, discountMinor: 11_900, taxMinor: 21_420, totalMinor: 128_520 });
    // recurring 10 × 3.00 + 2 × 19.00 = 68.00, no discount; VAT 13.60
    expect(r.recurring).toEqual({ subtotalMinor: 6_800, discountMinor: 0, taxMinor: 1_360, totalMinor: 8_160 });
    expect(r.approvalReasons).toEqual([]);
  });

  it("asks for approval above the discount limit and at the custom-pricing quantity", () => {
    const r = ok(base({ lines: [{ sku: "SNS-200", qty: 200 }], discountBp: 1_500 }));
    expect(r.approvalReasons).toEqual([
      { kind: "custom_pricing_qty", sku: "SNS-200", qty: 200, from: 200 },
      { kind: "discount_over_limit", requestedBp: 1_500, limitBp: 1_000 },
    ]);
  });

  it("uses a person's custom price per charge", () => {
    const r = ok(base({ lines: [{ sku: "SNS-200", qty: 2, customRecurringMinor: 200 }] }));
    expect(r.lines.map((l) => [l.charge, l.unitPriceMinor, l.priceSource])).toEqual([["one_time", 12_900, "list"], ["recurring", 200, "custom"]]);
    const waived = ok(base({ lines: [{ sku: "SVC-INST", qty: 1, customOneTimeMinor: 0 }] }));
    expect(waived.lines[0]).toMatchObject({ unitPriceMinor: 0, priceSource: "custom" });
    expect(waived.approvalReasons).toEqual([]);
  });

  it("handles VAT included and excluded, rounding half up", () => {
    const incl = ok(base({ priceList: { currency: "ILS", pricesIncludeTax: true, taxRateBp: 1_800 }, lines: [{ sku: "GW-10", qty: 1 }] }));
    // 149.00 incl. 18% VAT: net 126.27, VAT 22.73
    expect(incl.oneTime).toEqual({ subtotalMinor: 14_900, discountMinor: 0, taxMinor: 2_273, totalMinor: 14_900 });
    const excl = ok(base({ priceList: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1_750 }, lines: [{ sku: "OLD", qty: 1 }] }));
    // 10.00 + 17.5% = 1.75
    expect(excl.oneTime).toEqual({ subtotalMinor: 1_000, discountMinor: 0, taxMinor: 175, totalMinor: 1_175 });
    // 3% of 1.50 = 0.045 → 0.05 (half up)
    const r = ok(base({ entries: [entry("OLD", { oneTimeCharged: true, oneTimeMinor: 150 })], lines: [{ sku: "OLD", qty: 1 }], discountBp: 300, priceList: { currency: "EUR", pricesIncludeTax: false, taxRateBp: 0 } }));
    expect(r.oneTime.discountMinor).toBe(5);
    expect(r.oneTime.totalMinor).toBe(145);
  });

  describe("auto-add", () => {
    const install: AutoAddRule = { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false };
    const pricedInstall = [...entries.filter((e) => e.sku !== "SVC-INST"), entry("SVC-INST", { oneTimeCharged: true, oneTimeMinor: 9_500 })];

    it("adds installation per site as its own service line", () => {
      const r = ok(base({ entries: pricedInstall, autoAdd: [install], sites: 3, lines: [{ sku: "GW-10", qty: 3 }] }));
      expect(r.lines.map((l) => [l.sku, l.qty, l.kind, l.autoAdded, l.removable])).toEqual([
        ["GW-10", 3, "product", false, true],
        ["SVC-INST", 3, "service", true, false],
      ]);
      expect(r.autoAdded).toEqual(["SVC-INST"]);
      expect(r.oneTime.subtotalMinor).toBe(3 * 14_900 + 3 * 9_500);
    });

    it("adds the matching quantity, and a removable line can be removed", () => {
      const rule: AutoAddRule = { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["SNS-200"], qty: "matching", removable: true };
      const r = ok(base({ entries: pricedInstall, autoAdd: [rule], lines: [{ sku: "SNS-200", qty: 7 }] }));
      expect(r.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ qty: 7, removable: true, autoAdded: true });
      const removed = ok(base({ entries: pricedInstall, autoAdd: [rule], lines: [{ sku: "SNS-200", qty: 7 }], removedByBuyer: ["SVC-INST"] }));
      expect(removed.lines.some((l) => l.sku === "SVC-INST")).toBe(false);
      expect(removed.autoAdded).toEqual([]);
    });

    it("keeps a non-removable line, but the discount still applies to it within the limits", () => {
      const r = ok(base({ entries: pricedInstall, autoAdd: [install], sites: 1, lines: [{ sku: "GW-10", qty: 1 }], removedByBuyer: ["SVC-INST"], discountBp: 2_000 }));
      expect(r.keptDespiteRemoval).toEqual(["SVC-INST"]);
      expect(r.oneTime.discountMinor).toBe(Math.floor(((14_900 + 9_500) * 2_000 + 5_000) / 10_000));
      expect(r.approvalReasons).toEqual([{ kind: "discount_over_limit", requestedBp: 2_000, limitBp: 1_000 }]);
    });

    it("an auto-added line with no price yet needs approval like any other", () => {
      const r = ok(base({ autoAdd: [install], sites: 2, lines: [{ sku: "GW-10", qty: 1 }] }));
      expect(r.approvalReasons).toEqual([{ kind: "price_missing", sku: "SVC-INST", charge: "one_time" }]);
    });

    it("skips an auto-add SKU that is not sold in this price list", () => {
      const r = ok(base({ entries: entries.filter((e) => e.sku !== "SVC-INST"), autoAdd: [install], sites: 2, lines: [{ sku: "GW-10", qty: 1 }] }));
      expect(r.lines.map((l) => l.sku)).toEqual(["GW-10"]);
      expect(r.autoAdded).toEqual([]);
    });
  });
});
