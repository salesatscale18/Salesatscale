import { describe, expect, it } from "vitest";
import { applyAutoAdd, describeAutoAddRule, parseAutoAddRule, type AutoAddRule } from "@/lib/pricing/auto-add";

const install: AutoAddRule = { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10", "GW-10C"], qty: "sites", removable: false };
const setup: AutoAddRule = { kind: "auto_add", sku: "SETUP", whenAnyOf: ["SNS-200"], qty: "matching", removable: true };

describe("auto-add rules", () => {
  it("parses valid rules and rejects bad ones", () => {
    expect(parseAutoAddRule({ ...install })).toEqual(install);
    expect(parseAutoAddRule({ ...setup, removable: "yes" })).toEqual({ ...setup, removable: false });
    expect(parseAutoAddRule({ ...install, qty: "per_unit" })).toBeNull();
    expect(parseAutoAddRule({ ...install, whenAnyOf: [] })).toBeNull();
    expect(parseAutoAddRule({ ...install, whenAnyOf: ["SVC-INST"] })).toBeNull();
    expect(parseAutoAddRule({ ...install, sku: "bad sku" })).toBeNull();
    expect(parseAutoAddRule({ kind: "requires", sku: "A", oneOf: ["B"] })).toBeNull();
  });

  it("describes a rule in plain words", () => {
    expect(describeAutoAddRule(install)).toBe("When a quote has GW-10 or GW-10C, add SVC-INST × number of sites.");
    expect(describeAutoAddRule(setup)).toBe("When a quote has SNS-200, add SETUP × the same quantity. The buyer can remove it.");
  });

  it("adds one per site", () => {
    const r = applyAutoAdd([install], [{ sku: "GW-10", qty: 2 }], 3);
    expect(r.lines).toEqual([{ sku: "GW-10", qty: 2 }, { sku: "SVC-INST", qty: 3 }]);
    expect(r.autoAdded).toEqual([{ sku: "SVC-INST", qty: 3, removable: false }]);
  });

  it("adds one when the site count is not known", () => {
    expect(applyAutoAdd([install], [{ sku: "GW-10C", qty: 1 }], undefined).autoAdded[0].qty).toBe(1);
  });

  it("adds the matching quantity across every trigger SKU", () => {
    const rule: AutoAddRule = { ...setup, whenAnyOf: ["A", "B"] };
    expect(applyAutoAdd([rule], [{ sku: "A", qty: 4 }, { sku: "B", qty: 6 }], 1).autoAdded).toEqual([{ sku: "SETUP", qty: 10, removable: true }]);
  });

  it("does nothing without a trigger, or when the line is already quoted", () => {
    expect(applyAutoAdd([install], [{ sku: "SNS-200", qty: 5 }], 2).autoAdded).toEqual([]);
    const r = applyAutoAdd([install], [{ sku: "GW-10", qty: 1 }, { sku: "SVC-INST", qty: 1 }], 4);
    expect(r.autoAdded).toEqual([]);
    expect(r.lines).toHaveLength(2);
  });

  it("lets the buyer remove a removable line", () => {
    const r = applyAutoAdd([setup], [{ sku: "SNS-200", qty: 3 }], 1, ["SETUP"]);
    expect(r.autoAdded).toEqual([]);
    expect(r.keptDespiteRemoval).toEqual([]);
  });

  it("keeps a non-removable line the buyer removed, and says so", () => {
    const r = applyAutoAdd([install], [{ sku: "GW-10", qty: 1 }], 2, ["SVC-INST"]);
    expect(r.autoAdded).toEqual([{ sku: "SVC-INST", qty: 2, removable: false }]);
    expect(r.keptDespiteRemoval).toEqual(["SVC-INST"]);
  });

  it("two rules for one SKU: the larger quantity wins, and not removable wins", () => {
    const a: AutoAddRule = { kind: "auto_add", sku: "FEE", whenAnyOf: ["A"], qty: "matching", removable: true };
    const b: AutoAddRule = { kind: "auto_add", sku: "FEE", whenAnyOf: ["B"], qty: "sites", removable: false };
    const r = applyAutoAdd([a, b], [{ sku: "A", qty: 5 }, { sku: "B", qty: 1 }], 2, ["FEE"]);
    expect(r.autoAdded).toEqual([{ sku: "FEE", qty: 2, removable: false }]);
    expect(r.keptDespiteRemoval).toEqual(["FEE"]);
    const r2 = applyAutoAdd([a, b], [{ sku: "A", qty: 5 }, { sku: "B", qty: 1 }], 2);
    expect(r2.autoAdded).toEqual([{ sku: "FEE", qty: 5, removable: false }]);
  });
});
