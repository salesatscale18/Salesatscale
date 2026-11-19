import { describe, expect, it } from "vitest";
import { countryValueLabel, splitCodes } from "@/lib/format";
import { describeFitRule, type FitRule } from "@/lib/catalog/fit";
import { describeAutoAddRule } from "@/lib/pricing/auto-add";
import { evidenceChipText } from "@/lib/pipeline/evidence-text";
import { seesPlatformDetails } from "@/lib/auth/display";
import { SELLER_NAV } from "@/components/sas/nav";

const names: Record<string, string> = { "GW-10": "Kitchen hub", "SVC-INST": "Installation", "SNS-200": "Fridge sensor", "PLAN-M": "Monitoring plan" };
const nameOf = (s: string) => names[s];

describe("lead-form country value (7.1.8)", () => {
  it("adds the country name to a code, leaves other values", () => {
    expect(countryValueLabel("IL")).toBe("IL (Israel)");
    expect(countryValueLabel("Israel")).toBe("Israel");
    expect(countryValueLabel("ZZ")).toBe("ZZ");
  });
});

describe("catalog rule sentences (7.1.6)", () => {
  it("item name first, the code in brackets", () => {
    expect(describeAutoAddRule({ kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false }, nameOf))
      .toBe("When a quote has Kitchen hub (GW-10), add Installation (SVC-INST) × number of sites.");
    const rules: FitRule[] = [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10", "GW-10C"], perSite: true },
      { kind: "max_per", sku: "SNS-200", max: 30, perOneOf: ["GW-10"] },
      { kind: "advice", sku: "PLAN-M", text: "Offer the annual plan." },
    ];
    expect(rules.map((r) => describeFitRule(r, nameOf))).toEqual([
      "Fridge sensor (SNS-200) needs one Kitchen hub (GW-10) or GW-10C per site.",
      "Up to 30 × Fridge sensor (SNS-200) per Kitchen hub (GW-10).",
      "Monitoring plan (PLAN-M): Offer the annual plan.",
    ]);
  });
  it("codes are their own parts, so they never wrap inside", () => {
    const text = "When a quote has Kitchen hub (GW-10) or GW-10C, add Installation (SVC-INST) × number of sites.";
    const parts = splitCodes(text, ["GW-10", "GW-10C", "SVC-INST"]);
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(["(GW-10)", "GW-10C", "(SVC-INST)"]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(splitCodes("GW-100 is not GW-10", ["GW-10"]).filter((p) => p.code).map((p) => p.text)).toEqual(["GW-10"]);
  });
});

describe("knowledge source chips (7.1.11)", () => {
  it("note, call and other sources", () => {
    expect(evidenceChipText({ kind: "text", title: "Pricing and policy", locator: "note" })).toBe("Pricing and policy");
    expect(evidenceChipText({ kind: "call", title: "Discovery call", locator: "02:11" })).toBe("Call · 02:11");
    expect(evidenceChipText({ kind: "file", title: "Product sheet", locator: "p.2" })).toBe("Product sheet · p.2");
  });
});

describe("platform details (7.1.3)", () => {
  it("only platform admins see them", () => {
    expect(seesPlatformDetails({ actingAs: false, role: "seller_admin", user: { role: "seller" } as never })).toBe(false);
    expect(seesPlatformDetails({ actingAs: true, role: "platform_admin", user: { role: "super_admin" } })).toBe(true);
    expect(seesPlatformDetails({ actingAs: false, role: "seller_admin", user: { role: "super_admin" } })).toBe(true);
  });
});

describe("nav icons, one meaning each (7.6)", () => {
  it("setup items", () => {
    const icon = Object.fromEntries(SELLER_NAV.flatMap((g) => g.items).map((i) => [i.id, i.icon]));
    expect(icon).toMatchObject({ playbook: "scroll-text", "order-form": "file-signature", "follow-ups": "alarm-clock", "price-lists": "tags" });
    expect(Object.values(icon)).not.toContain("sparkles");
    expect(Object.values(icon)).not.toContain("pen");
    expect(Object.values(icon)).not.toContain("credit-card");
  });
});
