import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/domain/money";

describe("formatMoney", () => {
  it.each([
    [486_000, "ILS", undefined, "₪4,860.00"],
    [18_000, "ILS", "month", "₪180.00/month"],
    [120_000, "USD", undefined, "$1,200.00"],
    [0, "EUR", undefined, "€0.00"],
    [-2_550, "ILS", undefined, "-₪25.50"],
  ] as const)("%i %s %s → %s", (minor, currency, period, expected) => {
    expect(formatMoney(minor, currency, { period })).toBe(expected);
  });

  it("uses the currency's own minor unit", () => {
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
  });

  it("rejects non-integer amounts so floats never reach a record", () => {
    expect(() => formatMoney(10.5, "ILS")).toThrow(/integer minor units/);
  });
});
