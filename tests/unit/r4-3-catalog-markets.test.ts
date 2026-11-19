/**
 * Round 4, lane R4-3: display helpers for Catalog, Price lists, Markets and
 * Order form setup (B4, C4, D2, D4, E8/D13).
 */
import { describe, expect, it } from "vitest";
import { ruleIcon } from "@/lib/catalog/view";
import { tierSummary } from "@/lib/catalog/tiers";
import { legalByLanguage as marketLegalByLanguage } from "@/lib/markets/legal";
import { formCountryLabel } from "@/lib/markets/rules";
import { legalByLanguage, legalTable } from "@/lib/orders/settings";
import { vatParts } from "@/lib/pricing/list-view";

const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m));

describe("R4-3 display helpers", () => {
  it("B4: a needs rule uses the link icon; check stays for limits only", () => {
    expect(ruleIcon("requires")).toBe("link-2");
    expect(ruleIcon("auto_add")).toBe("plus");
    expect(ruleIcon("advice")).toBe("info");
    expect(ruleIcon("max_per")).toBe("check");
  });

  it("C4: a lead-form country value reads name first, code after", () => {
    expect(formCountryLabel("IL")).toBe("Israel (IL)");
    expect(formCountryLabel("de")).toBe("Germany (DE)");
    expect(formCountryLabel("Israel")).toBe("Israel");
    expect(formCountryLabel("ZZ")).toBe("ZZ");
  });

  it("D2: the tier summary shows two decimals", () => {
    expect(tierSummary(59_000, [{ minQty: 10, priceMinor: 55_050 }], 20, "ILS")).toBe("1–9: ₪590.00 · 10–19: ₪550.50 · 20+: custom pricing");
  });

  it("B5/D4: VAT line in lower case after the rate, with the word 'without'", () => {
    expect(vatParts({ pricesIncludeTax: false, taxRateBp: 1800 })).toEqual({ rate: "18%", mode: "Prices without VAT", line: "prices without VAT" });
  });

  it("D13/E8: the order form preview lists texts in the table's row order for every language", () => {
    // Hebrew privacy notice was written before the Hebrew sales terms: the preview still follows the table.
    const legal = [
      { sectionKey: "sales_terms", language: "en", title: "Sales terms", version: 1, createdAt: at(1) },
      { sectionKey: "privacy_notice", language: "he", title: "הודעת פרטיות", version: 1, createdAt: at(2) },
      { sectionKey: "privacy_notice", language: "en", title: "Privacy notice", version: 2, createdAt: at(3) },
      { sectionKey: "sales_terms", language: "he", title: "תנאי מכירה", version: 1, createdAt: at(4) },
    ];
    const rows = legalTable(legal, ["en", "he"]);
    expect(rows.map((r) => r.sectionKey)).toEqual(["sales_terms", "privacy_notice"]);
    const byLang = legalByLanguage(rows, legal, ["en", "he"]);
    expect(byLang.en.map((s) => s.title)).toEqual(["Sales terms", "Privacy notice"]);
    expect(byLang.he.map((s) => s.title)).toEqual(["תנאי מכירה", "הודעת פרטיות"]);
  });

  it("E8: Markets lists languages in the selling-language order and sections in the order form's order", () => {
    const sections = [
      { sectionKey: "privacy_notice", language: "he", id: "1" },
      { sectionKey: "sales_terms", language: "en", id: "2" },
      { sectionKey: "privacy_notice", language: "en", id: "3" },
      { sectionKey: "sales_terms", language: "he", id: "4" },
    ];
    const out = marketLegalByLanguage(sections, ["en", "he"]);
    expect(out.map((g) => g.language)).toEqual(["en", "he"]);
    expect(out[0].sections.map((s) => s.id)).toEqual(["3", "2"]);
    expect(out[1].sections.map((s) => s.id)).toEqual(["1", "4"]);
    // A language with no text is left out; one outside the list comes last.
    expect(marketLegalByLanguage([{ sectionKey: "a", language: "fr" }, { sectionKey: "a", language: "he" }], ["en", "he"]).map((g) => g.language)).toEqual(["he", "fr"]);
  });
});
