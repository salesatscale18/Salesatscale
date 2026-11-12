import { describe, expect, it } from "vitest";
import { checkFit, describeFitRule, parseFitRule, type FitRule } from "@/lib/catalog/fit";

const rules: FitRule[] = [
  { kind: "requires", sku: "SNS-200", oneOf: ["GW-10", "GW-10C"], perSite: true },
  { kind: "max_per", sku: "SNS-200", max: 30, perOneOf: ["GW-10", "GW-10C"] },
  { kind: "requires", sku: "GW-10", oneOf: ["PLAN-M"] },
  { kind: "advice", sku: "SNS-200", text: "Freezers below −25°C need SNS-210 instead." },
  { kind: "advice", text: "No Wi-Fi on site: use GW-10C." },
];

describe("checkFit", () => {
  it("passes a complete two-site quote and returns the advice", () => {
    const r = checkFit(rules, [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], 2);
    expect(r).toEqual({ ok: true, problems: [], notes: ["Freezers below −25°C need SNS-210 instead.", "No Wi-Fi on site: use GW-10C."] });
  });

  it("explains missing gateways, too few per site and too many sensors per gateway", () => {
    expect(checkFit(rules, [{ sku: "SNS-200", qty: 3 }], 1).problems).toEqual([
      "SNS-200 needs GW-10 or GW-10C.", "SNS-200 needs GW-10 or GW-10C.",
    ]);
    expect(checkFit(rules, [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10C", qty: 1 }], 2).problems).toEqual([
      "SNS-200 needs one GW-10 or GW-10C per site: 2 sites, 1 quoted.",
    ]);
    expect(checkFit(rules, [{ sku: "SNS-200", qty: 31 }, { sku: "GW-10C", qty: 1 }]).problems).toEqual([
      "Up to 30 × SNS-200 per GW-10 or GW-10C: 31 quoted for 1.",
    ]);
  });

  it("ignores per-site rules when the site count is unknown, and rules for SKUs not quoted", () => {
    expect(checkFit(rules, [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10C", qty: 1 }]).ok).toBe(true);
    expect(checkFit(rules, [{ sku: "PLAN-M", qty: 1 }]).problems).toEqual([]);
  });
});

describe("parseFitRule / describeFitRule", () => {
  it("accepts the three kinds and describes them", () => {
    expect(rules.map((r) => parseFitRule(r))).toEqual(rules.map((r) => (r.kind === "requires" ? { ...r, perSite: r.perSite === true } : r)));
    expect(describeFitRule(rules[0])).toBe("SNS-200 needs one GW-10 or GW-10C per site.");
    expect(describeFitRule(rules[1])).toBe("Up to 30 × SNS-200 per GW-10 or GW-10C.");
    expect(describeFitRule(rules[2])).toBe("GW-10 is always sold with PLAN-M.");
  });
  it.each([
    null, {}, { kind: "requires", sku: "A" }, { kind: "requires", sku: "A", oneOf: [] }, { kind: "max_per", sku: "A", max: 0, perOneOf: ["B"] },
    { kind: "advice", text: "  " }, { kind: "requires", sku: "bad sku", oneOf: ["B"] }, { kind: "drop table" },
  ])("rejects %o", (raw) => expect(parseFitRule(raw)).toBeNull());
});
