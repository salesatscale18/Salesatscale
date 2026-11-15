import { describe, expect, it } from "vitest";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { tierProblem } from "@/lib/catalog/rules";
import { checkPriceBlock, minorFromText, serializeTierRows, tierErrorText, tierLines, tierRowErrors, tierSummary, wholeQty } from "@/lib/catalog/tiers";
import { parseEntryForm } from "@/app/app/[account]/setup/price-lists/rules";
import { entryProblems, normalizeEntry } from "@/lib/pricing/price-lists";

const rows = (...r: [string, string][]) => r.map(([qty, price], key) => ({ key, qty, price }));
const kinds = (c: ReturnType<typeof checkPriceBlock<number>>) => c.rows.map((r) => r.error?.kind ?? null);

describe("tier editor rules (both price blocks)", () => {
  it("accepts a valid block, sorts rows by quantity and returns the tiers", () => {
    const c = checkPriceBlock("590", rows(["20", "500"], ["10", "550"]), 50, "ILS");
    expect(c.errorCount).toBe(0);
    expect(c.rows.map((r) => r.qty)).toEqual(["10", "20"]);
    expect(c.tiers).toEqual([{ minQty: 10, priceMinor: 55_000 }, { minQty: 20, priceMinor: 50_000 }]);
    expect(c.baseMinor).toBe(59_000);
  });

  it("flags a price that is not lower than the tier before, naming that tier", () => {
    const c = checkPriceBlock("15", rows(["10", "16"]), 20, "ILS");
    expect(kinds(c)).toEqual(["lower"]);
    expect(c.errorCount).toBe(1);
    expect(tierErrorText(c.rows[0].error!, "ILS")).toBe("Price must be lower than the tier before it (₪15 from 1).");
    const equal = checkPriceBlock("590", rows(["10", "550"], ["15", "550"]), null, "ILS");
    expect(kinds(equal)).toEqual([null, "lower"]);
    expect(tierErrorText(equal.rows[1].error!, "ILS")).toContain("₪550 from 10");
  });

  it("flags a duplicate quantity", () => {
    const c = checkPriceBlock("590", rows(["10", "550"], ["10", "540"]), null, "ILS");
    expect(kinds(c)).toEqual([null, "duplicate"]);
    expect(tierErrorText(c.rows[1].error!, "ILS")).toBe("Quantity 10 is used twice.");
  });

  it("flags a tier at or above the custom-pricing quantity", () => {
    expect(kinds(checkPriceBlock("590", rows(["20", "500"]), 20, "ILS"))).toEqual(["custom"]);
    expect(kinds(checkPriceBlock("590", rows(["25", "500"]), 20, "ILS"))).toEqual(["custom"]);
    expect(kinds(checkPriceBlock("590", rows(["19", "500"]), 20, "ILS"))).toEqual([null]);
  });

  it("flags empty or bad quantities and prices, and tiers without a base price", () => {
    expect(kinds(checkPriceBlock("590", rows(["", ""]), null, "ILS"))).toEqual(["qty"]);
    expect(kinds(checkPriceBlock("590", rows(["1", "500"]), null, "ILS"))).toEqual(["qty"]);
    expect(kinds(checkPriceBlock("590", rows(["2.5", "500"]), null, "ILS"))).toEqual(["qty"]);
    expect(kinds(checkPriceBlock("590", rows(["10", "abc"]), null, "ILS"))).toEqual(["price"]);
    const noBase = checkPriceBlock("", rows(["10", "500"]), null, "ILS");
    expect(noBase.baseError).toBe("needed");
    expect(noBase.errorCount).toBe(1);
    expect(checkPriceBlock("x", [], null, "ILS")).toMatchObject({ baseError: "invalid", errorCount: 1 });
    // An empty base with no tiers is "price missing": allowed to save, blocks publishing.
    expect(checkPriceBlock("", [], null, "ILS")).toMatchObject({ baseError: null, errorCount: 0, baseMinor: null });
  });

  it("counts every error so the save button can say how many to fix", () => {
    const c = checkPriceBlock("590", rows(["10", "600"], ["10", "500"], ["30", "400"]), 20, "ILS");
    expect(kinds(c)).toEqual(["lower", "duplicate", "custom"]);
    expect(c.errorCount).toBe(3);
  });

  it("summarises the tiers, with the period for recurring prices", () => {
    expect(tierSummary(59_000, [{ minQty: 10, priceMinor: 55_000 }], 20, "ILS")).toBe("1–9: ₪590 · 10–19: ₪550 · 20+: custom pricing");
    expect(tierSummary(1_500, [{ minQty: 10, priceMinor: 1_250 }], 20, "ILS", "month")).toBe("1–9: ₪15/month · 10–19: ₪12.50/month · 20+: custom pricing");
    expect(tierSummary(19_000, [], null, "GBP", "year")).toBe("1+: £190/year");
    expect(tierSummary(59_000, [{ minQty: 10, priceMinor: 55_000 }], null, "ILS")).toBe("1–9: ₪590 · 10+: ₪550");
  });

  it("round-trips rows through the hidden form field", () => {
    const text = serializeTierRows([{ qty: "10", price: "550" }, { qty: "20", price: "500.50" }]);
    expect(text).toBe("10: 550\n20: 500.50");
    expect(tierLines(text)).toEqual([{ key: 0, qty: "10", price: "550" }, { key: 1, qty: "20", price: "500.50" }]);
    expect(tierLines("10+ = 550\nbad")).toEqual([{ key: 0, qty: "10", price: "550" }, { key: 1, qty: "bad", price: "" }]);
  });

  it("parses money exactly like the server-only parser", () => {
    for (const [v, c] of [["590", "ILS"], ["1,250.5", "ILS"], ["12.345", "ILS"], ["abc", "GBP"], ["0", "USD"], ["15.00", "EUR"], ["-3", "ILS"], ["", "ILS"]] as const) {
      expect(minorFromText(v, c)).toBe(parseMajorToMinor(v, c));
    }
    expect(wholeQty("20")).toBe(20);
    expect([wholeQty("0"), wholeQty("2.5"), wholeQty("")]).toEqual([null, null, null]);
  });
});

describe("server checks match the editor", () => {
  const form = (part: "oneTime" | "recurring", base: string, tiers: string, custom = "") =>
    parseEntryForm({ sku: "A", sold: "yes", [`${part}Charged`]: "on", [`${part}Price`]: base, [`${part}Tiers`]: tiers, customPricingFromQty: custom, recurringPeriod: "month" }, "ILS");

  it.each([
    ["not lower", "15", "10: 16", "20"],
    ["duplicate", "590", "10: 550\n10: 540", ""],
    ["at custom pricing", "590", "20: 500", "20"],
    ["above custom pricing", "590", "25: 500", "20"],
    ["no base price", "", "10: 500", ""],
    ["quantity below 2", "590", "1: 500", ""],
  ])("refuses a tier that is %s, in both blocks, with the editor's message", (_label, base, tiers, custom) => {
    for (const part of ["oneTime", "recurring"] as const) {
      const r = form(part, base, tiers, custom);
      const client = checkPriceBlock(base, tierLines(tiers), custom ? Number(custom) : null, "ILS");
      expect(client.errorCount).toBeGreaterThan(0);
      expect(r.ok).toBe(false);
      const firstRow = client.rows.find((x) => x.error)?.error;
      const expected = firstRow ? tierErrorText(firstRow, "ILS") : "Enter the base price before adding tiers.";
      expect(!r.ok && r.errors[`${part}Tiers`]).toBe(expected);
    }
  });

  it("accepts what the editor accepts, in both blocks", () => {
    for (const part of ["oneTime", "recurring"] as const) {
      const r = form(part, "590", "10: 550\n15: 520", "20");
      expect(r).toMatchObject({ ok: true, entry: { [`${part}Minor`]: 59_000, [`${part}Tiers`]: [{ minQty: 10, priceMinor: 55_000 }, { minQty: 15, priceMinor: 52_000 }], customPricingFromQty: 20 } });
    }
  });

  it("publish checks (tierProblem, entryProblems) use the same rules", () => {
    expect(tierProblem(59_000, [{ minQty: 10, priceMinor: 55_000 }, { minQty: 10, priceMinor: 54_000 }], null)).toBe("Two tiers start at 10.");
    expect(tierProblem(59_000, [{ minQty: 20, priceMinor: 50_000 }], 20)).toMatch(/custom pricing \(20\+\)/);
    expect(tierProblem(1_500, [{ minQty: 10, priceMinor: 1_600 }], null)).toMatch(/lower than the tier before/);
    const n = normalizeEntry({ sku: "A", oneTimeCharged: false, oneTimeMinor: null, recurringCharged: true, recurringMinor: 1_500, recurringTiers: [{ minQty: 10, priceMinor: 1_600 }] });
    expect(n.ok && entryProblems(n.value).map((p) => p.charge)).toEqual(["recurring"]);
    // tierRowErrors directly: the numbers both sides feed in.
    expect([...tierRowErrors(100, [{ key: "a", qty: 5, price: 90 }], null).errors]).toEqual([]);
  });
});
