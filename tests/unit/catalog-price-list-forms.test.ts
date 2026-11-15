import { describe, expect, it } from "vitest";
import { parseItemEdit, unitLanguages } from "@/lib/catalog/rules";
import { applyAutoAdd, describeAutoAddRule, parseAutoAddRule } from "@/lib/pricing/auto-add";
import { entryFormDefaults, parseCopyForm, parseEntryForm, parseMetaForm } from "@/app/app/[account]/setup/price-lists/rules";

describe("item editor without prices", () => {
  const ok = { sku: "svc-inst", name: "Installation", kind: "service", unit: "site", description: "On-site setup" };

  it("keeps kind and a unit from the pick list, and no price fields", () => {
    const r = parseItemEdit(ok, ["he"]);
    expect(r.ok && r.value).toEqual({
      sku: "SVC-INST", name: "Installation", description: "On-site setup", kind: "service", unit: "site", unitCustom: null, active: true, availabilityNote: null,
    });
    expect(r.ok && "priceMinor" in r.value).toBe(false);
  });

  it.each([
    [{ kind: "" }, "kind"], [{ kind: "bundle" }, "kind"], [{ unit: "sensor" }, "unit"], [{ unit: "" }, "unit"], [{ sku: "bad sku" }, "sku"], [{ name: " " }, "name"],
  ])("rejects %o", (patch, field) => {
    const r = parseItemEdit({ ...ok, ...patch }, ["en"]);
    expect(!r.ok && r.errors).toHaveProperty(field);
  });

  it("a custom unit needs singular and plural in English and every selling language", () => {
    const custom = { ...ok, unit: "custom", unitOne_en: "probe", unitOther_en: "probes" };
    expect(parseItemEdit(custom, ["en"])).toMatchObject({ ok: true, value: { unit: "custom", unitCustom: { en: { one: "probe", other: "probes" } } } });
    expect(parseItemEdit(custom, ["he"])).toMatchObject({ ok: false, errors: { unitCustom: expect.any(String) } });
    const both = { ...custom, unitOne_he: "חיישן", unitOther_he: "חיישנים" };
    expect(parseItemEdit(both, ["he"])).toMatchObject({ ok: true, value: { unitCustom: { en: { one: "probe", other: "probes" }, he: { one: "חיישן", other: "חיישנים" } } } });
    expect(parseItemEdit({ ...custom, unitOther_en: "" }, ["en"]).ok).toBe(false);
    expect(parseItemEdit({ ...custom, unitOne_en: "x".repeat(31) }, ["en"]).ok).toBe(false);
  });

  it("asks for English first, then the selling languages, once each", () => {
    expect(unitLanguages(["he", "en", "he"])).toEqual(["en", "he"]);
    expect(unitLanguages([])).toEqual(["en"]);
  });
});

describe("auto-add quantity one", () => {
  it("parses, describes and adds a single line", () => {
    const rule = parseAutoAddRule({ kind: "auto_add", sku: "SETUP", whenAnyOf: ["A", "B"], qty: "one", removable: true });
    expect(rule).toEqual({ kind: "auto_add", sku: "SETUP", whenAnyOf: ["A", "B"], qty: "one", removable: true });
    expect(describeAutoAddRule(rule!)).toBe("When a quote has A or B, add SETUP once. The buyer can remove it.");
    expect(applyAutoAdd([rule!], [{ sku: "A", qty: 7 }, { sku: "B", qty: 2 }], 4).autoAdded).toEqual([{ sku: "SETUP", qty: 1, removable: true }]);
  });
});

describe("price list entry form", () => {
  it("converts major units in the list's currency and keeps a missing price as missing", () => {
    const r = parseEntryForm({ sku: "sns-200", sold: "yes", oneTimeCharged: "on", oneTimePrice: "129.50", oneTimeTiers: "10: 120", recurringCharged: "on", recurringPrice: "", recurringPeriod: "year" }, "GBP");
    expect(r).toEqual({
      ok: true, sold: true,
      entry: { sku: "SNS-200", oneTimeCharged: true, oneTimeMinor: 12950, oneTimeTiers: [{ minQty: 10, priceMinor: 12000 }], recurringCharged: true, recurringMinor: null, recurringPeriod: "year", recurringTiers: [], customPricingFromQty: null },
    });
  });

  it("ignores prices of parts that are not charged", () => {
    const r = parseEntryForm({ sku: "A", sold: "yes", oneTimePrice: "abc", recurringCharged: "on", recurringPrice: "19" }, "ILS");
    expect(r).toMatchObject({ ok: true, entry: { oneTimeCharged: false, oneTimeMinor: null, recurringMinor: 1900, recurringPeriod: "month" } });
  });

  it("'Sold here: no' means remove", () => {
    expect(parseEntryForm({ sku: "a", sold: "no", oneTimePrice: "x" }, "ILS")).toEqual({ ok: true, sold: false, sku: "A" });
  });

  it.each([
    [{ oneTimeCharged: "on", oneTimePrice: "1.234" }, "oneTimePrice"],
    [{ oneTimeCharged: "on", oneTimeTiers: "1: 5" }, "oneTimeTiers"],
    [{ recurringCharged: "on", recurringPeriod: "week" }, "recurringPeriod"],
    [{ customPricingFromQty: "0" }, "customPricingFromQty"],
  ])("rejects %o", (patch, field) => {
    const r = parseEntryForm({ sku: "A", sold: "yes", ...patch }, "ILS");
    expect(!r.ok && r.errors).toHaveProperty(field);
  });

  it("fills the form from an entry, in major units", () => {
    const d = entryFormDefaults({ id: "x", accountId: "a", priceListId: "p", sku: "A", oneTimeCharged: true, oneTimeMinor: 35000, oneTimeTiers: [{ minQty: 5, priceMinor: 30000 }], recurringCharged: false, recurringMinor: null, recurringPeriod: null, recurringTiers: [], customPricingFromQty: 20 }, "ILS");
    expect(d).toMatchObject({ sold: true, oneTimePrice: "350.00", oneTimeTiers: "5: 300.00", recurringCharged: false, customPricingFromQty: "20" });
    expect(entryFormDefaults(null, "ILS")).toMatchObject({ sold: false, oneTimeCharged: true, recurringCharged: false });
  });
});

describe("price list settings and copy forms", () => {
  it("parses settings", () => {
    expect(parseMetaForm({ name: " UK 2026 ", currency: "gbp", pricesIncludeTax: "", taxRate: "20", validFrom: "2026-12-01" }, true)).toEqual({
      ok: true, value: { name: "UK 2026", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2000, validFrom: "2026-12-01" },
    });
    expect(parseMetaForm({ name: "", currency: "EURO", taxRate: "abc", validFrom: "2026-13-01" }, true)).toMatchObject({ ok: false, errors: { name: expect.any(String), currency: expect.any(String), taxRate: expect.any(String), validFrom: expect.any(String) } });
    expect(parseMetaForm({ name: "A", currency: "" }, false).ok).toBe(true);
  });

  it("parses copy and adjust by percent or by factor", () => {
    const base = { source: "s", name: "Euro 2026", currency: "EUR", pricesIncludeTax: "on", taxRate: "19", rounding: "whole" };
    expect(parseCopyForm({ ...base, mode: "percent", amount: "-10" })).toMatchObject({ ok: true, sourceId: "s", options: { name: "Euro 2026", currency: "EUR", percent: "-10", rounding: "whole", pricesIncludeTax: true, taxRateBp: 1900 } });
    const f = parseCopyForm({ ...base, mode: "factor", amount: "0.25" });
    expect(f.ok && f.options).toMatchObject({ factor: "0.25" });
    expect(f.ok && "percent" in f.options).toBe(false);
    expect(parseCopyForm({ ...base, mode: "factor", amount: "" })).toMatchObject({ ok: false, errors: { adjust: expect.any(String) } });
    expect(parseCopyForm({ ...base, amount: "0", rounding: "up" })).toMatchObject({ ok: false, errors: { rounding: expect.any(String) } });
    expect(parseCopyForm({ ...base, amount: "0", source: "" })).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
  });
});
