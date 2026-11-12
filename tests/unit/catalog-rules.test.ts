import { describe, expect, it } from "vitest";
import { parseCatalogItem, parseTaxRate, parseTiers } from "@/lib/catalog/rules";

describe("catalog item input", () => {
  const ok = { sku: "sns-200", name: "Wireless fridge sensor", unit: "Sensor", price: "590", tiers: "10: 550", customPricingFromQty: "20" };
  it("normalizes SKU and unit and converts prices to minor units", () => {
    const r = parseCatalogItem(ok, "ILS");
    expect(r.ok && r.value).toMatchObject({ sku: "SNS-200", unit: "sensor", priceMinor: 59_000, volumeTiers: [{ minQty: 10, priceMinor: 55_000 }], customPricingFromQty: 20, chargeType: "one_time", period: null, active: true });
  });
  it("monthly items get a month period; an empty price means priced by hand", () => {
    const r = parseCatalogItem({ ...ok, chargeType: "recurring", price: "", tiers: "" }, "ILS");
    expect(r.ok && r.value).toMatchObject({ chargeType: "recurring", period: "month", priceMinor: null });
  });
  it.each([
    [{ sku: "bad sku" }, "sku"], [{ name: "" }, "name"], [{ unit: "" }, "unit"], [{ price: "abc" }, "price"],
    [{ tiers: "ten: 5" }, "tiers"], [{ price: "", tiers: "10: 5" }, "tiers"], [{ customPricingFromQty: "0" }, "customPricingFromQty"],
  ])("rejects %o", (patch, field) => {
    const r = parseCatalogItem({ ...ok, ...patch }, "ILS");
    expect(!r.ok && r.errors).toHaveProperty(field);
  });
});

describe("tiers and tax", () => {
  it("parses and sorts tiers, rejects duplicates and tiny quantities", () => {
    expect(parseTiers("50: 500\n10+ = 550", "ILS")).toEqual([{ minQty: 10, priceMinor: 55_000 }, { minQty: 50, priceMinor: 50_000 }]);
    expect(parseTiers("10: 5\n10: 6", "ILS")).toBeNull();
    expect(parseTiers("1: 5", "ILS")).toBeNull();
    expect(parseTiers("", "ILS")).toEqual([]);
  });
  it.each([["18", 1800], ["17.5", 1750], ["0", 0], ["100", null], ["-1", null], ["x", null]])("tax %s → %s", (t, bp) => expect(parseTaxRate(t)).toBe(bp));
});
